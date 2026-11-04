#!/usr/bin/env python3
"""
FPL match predictor
===================

Win / draw / loss for every remaining Premier League fixture, built only from
the public FPL API (bootstrap-static + fixtures). Standard library only.

How it works
------------
The weighted binary tree from the slides is kept: a run of wins is still the
product of the win probability at each fork. What changes is where each fork's
weight comes from. Instead of one club-wide win rate with hand-set multipliers,
every fixture gets its own probability from a two-sided goals model, so the
numbers for both teams always add up (win + draw + loss = 1).

1. Ratings. Each club gets an attack and a defence rating (log scale, 0 = league
   average), fitted twice and blended:
     * from actual GOALS in finished fixtures (time-decayed), and
     * from season xG / xGA in bootstrap-static (more stable, less luck).
   Both fits are opponent-adjusted: scoring 2 against the best defence counts
   for more than 2 against the worst.
2. Prior. Early-season samples are tiny, so ratings are shrunk toward a prior
   built from FPL fixture difficulty. FPL's `strength_*` fields are 0 in
   2026/27 and are deliberately not used; instead, the difficulty other clubs
   are given when facing club X is a strength rating of X.
3. Match. Expected goals:  lambda_home = base_home * exp(att_home + def_away)
                           lambda_away = base_away * exp(att_away + def_home)
   A Dixon-Coles corrected Poisson score grid then gives P(home), P(draw),
   P(away), the most likely score, both-teams-to-score and clean sheets.
4. Streaks. P(next N wins) = product of that team's per-fixture win
   probabilities, i.e. the slides' path product with real weights.

Usage
-----
  python fpl_match_predictor.py                    # every remaining fixture
  python fpl_match_predictor.py --horizon 3        # next 3 gameweeks only
  python fpl_match_predictor.py --team MUN --streak 5
  python fpl_match_predictor.py --csv predictions.csv --ratings
  python fpl_match_predictor.py --backtest         # how good is it, honestly?
  python fpl_match_predictor.py --save-dir snap/   # cache the API responses
  python fpl_match_predictor.py --data-dir snap/   # run offline from a cache
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime

API = "https://fantasy.premierleague.com/api/"

# ---------------------------------------------------------------------------
# Tunable model settings (judgement, like the slides' multipliers, but each one
# can be checked with --backtest instead of taken on faith)
# ---------------------------------------------------------------------------
GOALS_WEIGHT = 0.35      # blend: 0.35 goals-fit + 0.65 xG-fit
PRIOR_MATCHES = 6.0      # strength of the difficulty prior, in pseudo-matches
FDR_SCALE = 0.20         # log-rating per 1 point of average fixture difficulty
HALF_LIFE_DAYS = 90.0    # time decay for the goals fit
DC_RHO = -0.06           # Dixon-Coles low-score correction (more 0-0 / 1-1)
PRIOR_HOME_GOALS = 1.53  # league-average fallback, home side
PRIOR_AWAY_GOALS = 1.22  # league-average fallback, away side
BASE_PRIOR_MATCHES = 40  # shrink this season's base rates toward the above
MAX_GOALS = 10


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

def fetch(path: str):
    req = urllib.request.Request(
        API + path, headers={"User-Agent": "Mozilla/5.0 (fpl-match-predictor)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def load_data(data_dir: str | None, save_dir: str | None):
    if data_dir:
        with open(os.path.join(data_dir, "bootstrap-static.json")) as fh:
            bootstrap = json.load(fh)
        with open(os.path.join(data_dir, "fixtures.json")) as fh:
            fixtures = json.load(fh)
    else:
        try:
            bootstrap = fetch("bootstrap-static/")
            fixtures = fetch("fixtures/")
        except Exception as exc:  # network, 403, timeout
            sys.exit(f"Could not reach the FPL API ({exc}).\n"
                     "Run from a machine with internet access, or pass "
                     "--data-dir with saved bootstrap-static.json + fixtures.json.")
    if save_dir:
        os.makedirs(save_dir, exist_ok=True)
        with open(os.path.join(save_dir, "bootstrap-static.json"), "w") as fh:
            json.dump(bootstrap, fh)
        with open(os.path.join(save_dir, "fixtures.json"), "w") as fh:
            json.dump(fixtures, fh)
    return bootstrap, fixtures


def fnum(value) -> float:
    """FPL sends many numbers as strings ('1.23'); missing values become 0."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def is_played(f) -> bool:
    # Use the score plus either finished flag. Gameweek stats can land before
    # `finished` flips, so `finished_provisional` is accepted too.
    return (f.get("team_h_score") is not None
            and f.get("team_a_score") is not None
            and bool(f.get("finished") or f.get("finished_provisional")))


def current_event(bootstrap) -> int:
    events = bootstrap.get("events", [])
    for key in ("is_current", "is_next"):
        for e in events:
            if e.get(key):
                return e["id"]
    return 1


def is_upcoming(f, cur_event: int) -> bool:
    # Not played, not kicked off, and scheduled. Requiring event >= current GW
    # stops a just-finished-but-not-yet-flagged round looking upcoming, while
    # still keeping a Monday game of the current round.
    return (not is_played(f)
            and not f.get("started")
            and f.get("event") is not None
            and f["event"] >= cur_event)


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

def difficulty_prior(team_ids, fixtures):
    """Log-strength prior from FPL fixture difficulty.

    `team_a_difficulty` is what the away side was told to expect, i.e. a rating
    of the HOME side (and vice versa). Averaging those over the season gives a
    populated strength index for every club, even before a ball is kicked.
    """
    seen = defaultdict(list)
    for f in fixtures:
        if f.get("team_a_difficulty"):
            seen[f["team_h"]].append(f["team_a_difficulty"])
        if f.get("team_h_difficulty"):
            seen[f["team_a"]].append(f["team_h_difficulty"])
    idx = {t: (sum(seen[t]) / len(seen[t]) if seen[t] else None) for t in team_ids}
    known = [v for v in idx.values() if v is not None]
    mean = sum(known) / len(known) if known else 3.0
    strength = {t: FDR_SCALE * ((idx[t] if idx[t] is not None else mean) - mean)
                for t in team_ids}
    # stronger club: scores more (att up) and concedes less (def down)
    return strength, {t: -s for t, s in strength.items()}


def fit_ratings(team_ids, matches, scored, conceded, base_h, base_a,
                prior_att, prior_def, tau=PRIOR_MATCHES, iters=200):
    """Opponent-adjusted multiplicative Poisson fit with a pseudo-match prior.

    matches  : list of (home_id, away_id, weight)
    scored   : team -> weighted total goals (or xG) scored in those matches
    conceded : team -> weighted total conceded
    The update for attack is  exp(att) = (scored + prior pseudo-goals) /
    (expected goals at average attack + prior pseudo-exposure); defence alike.
    """
    att = dict(prior_att)
    dfn = dict(prior_def)
    b_avg = (base_h + base_a) / 2
    by_team = defaultdict(list)          # team -> (opp, is_home, weight)
    for h, a, w in matches:
        by_team[h].append((a, True, w))
        by_team[a].append((h, False, w))

    for _ in range(iters):
        new_att = {}
        for t in team_ids:
            num = scored.get(t, 0.0) + tau * b_avg * math.exp(prior_att[t])
            den = tau * b_avg
            for opp, home, w in by_team[t]:
                den += w * (base_h if home else base_a) * math.exp(dfn[opp])
            new_att[t] = math.log(num / den)
        new_def = {}
        for t in team_ids:
            num = conceded.get(t, 0.0) + tau * b_avg * math.exp(prior_def[t])
            den = tau * b_avg
            for opp, home, w in by_team[t]:
                # opponent is away when t is home
                den += w * (base_a if home else base_h) * math.exp(new_att[opp])
            new_def[t] = math.log(num / den)
        # centre so 0 = league average (keeps the base rates meaningful)
        ma = sum(new_att.values()) / len(new_att)
        md = sum(new_def.values()) / len(new_def)
        att = {t: v - ma for t, v in new_att.items()}
        dfn = {t: v - md for t, v in new_def.items()}
    return att, dfn


def build_model(bootstrap, fixtures, use_xg=True, cutoff_event=None):
    """Fit ratings. With cutoff_event, only fixtures before that GW are used
    (for back-testing); xG is then switched off because bootstrap totals
    already contain later matches."""
    teams = {t["id"]: t for t in bootstrap["teams"]}
    team_ids = list(teams)

    played = [f for f in fixtures if is_played(f)]
    if cutoff_event is not None:
        played = [f for f in played if (f.get("event") or 0) < cutoff_event]
        use_xg = False

    # League base rates, shrunk toward long-run averages
    n = len(played)
    hg = sum(f["team_h_score"] for f in played)
    ag = sum(f["team_a_score"] for f in played)
    base_h = (hg + BASE_PRIOR_MATCHES * PRIOR_HOME_GOALS) / (n + BASE_PRIOR_MATCHES)
    base_a = (ag + BASE_PRIOR_MATCHES * PRIOR_AWAY_GOALS) / (n + BASE_PRIOR_MATCHES)

    prior_att, prior_def = difficulty_prior(team_ids, fixtures)

    # --- goals fit, time-decayed
    times = [parse_time(f.get("kickoff_time")) for f in played]
    ref = max((t for t in times if t), default=None)
    g_matches, g_for, g_against = [], defaultdict(float), defaultdict(float)
    n_played = defaultdict(int)
    for f, t in zip(played, times):
        w = 1.0
        if ref and t:
            w = 0.5 ** (((ref - t).total_seconds() / 86400) / HALF_LIFE_DAYS)
        h, a = f["team_h"], f["team_a"]
        g_matches.append((h, a, w))
        g_for[h] += w * f["team_h_score"]; g_against[h] += w * f["team_a_score"]
        g_for[a] += w * f["team_a_score"]; g_against[a] += w * f["team_h_score"]
        n_played[h] += 1; n_played[a] += 1
    att_g, def_g = fit_ratings(team_ids, g_matches, g_for, g_against,
                               base_h, base_a, prior_att, prior_def)

    # --- xG fit from season totals (no decay possible: totals only)
    att, dfn, source = att_g, def_g, "goals"
    if use_xg:
        xg_for, xgc_sum, mins = defaultdict(float), defaultdict(float), defaultdict(float)
        for e in bootstrap.get("elements", []):
            t = e.get("team")
            xg_for[t] += fnum(e.get("expected_goals"))   # already includes pen xG
            xgc_sum[t] += fnum(e.get("expected_goals_conceded"))
            mins[t] += fnum(e.get("minutes"))
        # xGC accrues to everyone on the pitch: sum*90/minutes = per match
        xg_against = {t: (xgc_sum[t] * 90 / mins[t] if mins[t] else 0.0) * n_played[t]
                      for t in team_ids}
        if sum(xg_for.values()) > 0 and sum(xg_against.values()) > 0:
            x_matches = [(h, a, 1.0) for h, a, _ in g_matches]
            att_x, def_x = fit_ratings(team_ids, x_matches, xg_for, xg_against,
                                       base_h, base_a, prior_att, prior_def)
            gw = GOALS_WEIGHT
            att = {t: gw * att_g[t] + (1 - gw) * att_x[t] for t in team_ids}
            dfn = {t: gw * def_g[t] + (1 - gw) * def_x[t] for t in team_ids}
            source = "goals+xG"

    return {
        "teams": teams, "att": att, "def": dfn,
        "base_h": base_h, "base_a": base_a,
        "n_played": n_played, "n_fixtures_used": n, "source": source,
    }


def poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam + k * math.log(lam) - math.lgamma(k + 1)) if lam > 0 else float(k == 0)


def match_probs(lam_h: float, lam_a: float, rho: float = DC_RHO) -> dict:
    ph = [poisson_pmf(k, lam_h) for k in range(MAX_GOALS + 1)]
    pa = [poisson_pmf(k, lam_a) for k in range(MAX_GOALS + 1)]
    grid = [[ph[i] * pa[j] for j in range(MAX_GOALS + 1)] for i in range(MAX_GOALS + 1)]
    # Dixon-Coles: independent Poisson under-predicts 0-0 and 1-1
    grid[0][0] *= max(0.0, 1 - lam_h * lam_a * rho)
    grid[0][1] *= max(0.0, 1 + lam_h * rho)
    grid[1][0] *= max(0.0, 1 + lam_a * rho)
    grid[1][1] *= max(0.0, 1 - rho)
    total = sum(map(sum, grid))
    p_h = p_d = p_a = btts = 0.0
    best, best_p = (0, 0), -1.0
    for i in range(MAX_GOALS + 1):
        for j in range(MAX_GOALS + 1):
            p = grid[i][j] / total
            if i > j: p_h += p
            elif i == j: p_d += p
            else: p_a += p
            if i and j: btts += p
            if p > best_p: best, best_p = (i, j), p
    cs_home = sum(grid[i][0] for i in range(MAX_GOALS + 1)) / total
    cs_away = sum(grid[0][j] for j in range(MAX_GOALS + 1)) / total
    return {"home": p_h, "draw": p_d, "away": p_a, "score": best,
            "score_p": best_p, "btts": btts, "cs_home": cs_home, "cs_away": cs_away}


def predict_fixture(model, f) -> dict:
    h, a = f["team_h"], f["team_a"]
    lam_h = model["base_h"] * math.exp(model["att"][h] + model["def"][a])
    lam_a = model["base_a"] * math.exp(model["att"][a] + model["def"][h])
    out = match_probs(lam_h, lam_a)
    out.update({"event": f.get("event"), "kickoff": f.get("kickoff_time"),
                "home_id": h, "away_id": a, "xg_home": lam_h, "xg_away": lam_a})
    return out


# ---------------------------------------------------------------------------
# Streaks (the slides' path product, with a real weight at each fork)
# ---------------------------------------------------------------------------

def streak_table(preds, team_ids, n):
    by_team = defaultdict(list)
    for p in preds:
        by_team[p["home_id"]].append((p, "home"))
        by_team[p["away_id"]].append((p, "away"))
    rows = []
    for t in team_ids:
        games = sorted(by_team[t], key=lambda x: (x[0]["event"], x[0]["kickoff"] or ""))[:n]
        if len(games) < n:
            continue
        p_win, p_unbeaten, path = 1.0, 1.0, []
        for p, side in games:
            win = p[side]
            loss = p["away" if side == "home" else "home"]
            p_win *= win
            p_unbeaten *= 1 - loss
            path.append(win)
        rows.append({"team": t, "p_win_all": p_win, "p_unbeaten": p_unbeaten,
                     "path": path, "games": games})
    return sorted(rows, key=lambda r: -r["p_win_all"])


# ---------------------------------------------------------------------------
# Back-test: refit before each gameweek, score that gameweek
# ---------------------------------------------------------------------------

def backtest(bootstrap, fixtures, start_event=4):
    played = [f for f in fixtures if is_played(f)]
    events = sorted({f["event"] for f in played if f.get("event")})
    rows = []
    for ev in events:
        if ev < start_event:
            continue
        model = build_model(bootstrap, fixtures, cutoff_event=ev)
        prior = [f for f in played if f["event"] < ev]
        n = len(prior) or 1
        base = {
            "home": sum(f["team_h_score"] > f["team_a_score"] for f in prior) / n,
            "draw": sum(f["team_h_score"] == f["team_a_score"] for f in prior) / n,
            "away": sum(f["team_h_score"] < f["team_a_score"] for f in prior) / n,
        }
        base = {k: (v * n + 1) / (n + 3) for k, v in base.items()}   # no zeros
        for f in (x for x in played if x["event"] == ev):
            p = predict_fixture(model, f)
            res = ("home" if f["team_h_score"] > f["team_a_score"]
                   else "draw" if f["team_h_score"] == f["team_a_score"] else "away")
            rows.append({"model": p, "base": base, "result": res})
    if not rows:
        print("Not enough finished gameweeks to back-test yet.")
        return

    def scores(get):
        ll = br = hit = 0.0
        for r in rows:
            probs = get(r)
            ll -= math.log(max(probs[r["result"]], 1e-9))
            br += sum((probs[k] - (k == r["result"])) ** 2 for k in ("home", "draw", "away"))
            top = max(probs[k] for k in ("home", "draw", "away"))
            picks = [k for k in ("home", "draw", "away") if probs[k] == top]
            hit += (r["result"] in picks) / len(picks)   # ties share the credit
        m = len(rows)
        return ll / m, br / m, hit / m

    print(f"\nBack-test: {len(rows)} fixtures, each predicted using only earlier "
          "gameweeks (goals only - season xG totals would leak the future).")
    print(f"{'':28}{'log loss':>10}{'Brier':>9}{'pick right':>12}")
    for name, get in [("this model", lambda r: r["model"]),
                      ("league base rates", lambda r: r["base"]),
                      ("coin flip (1/3 each)", lambda r: {"home": 1/3, "draw": 1/3, "away": 1/3})]:
        ll, br, hit = scores(get)
        print(f"  {name:26}{ll:10.3f}{br:9.3f}{hit:11.1%}")
    print("Lower log loss / Brier is better. Bookmakers usually land near 0.96-0.98 "
          "log loss on the Premier League.")


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def find_team(teams, query):
    q = query.lower()
    for t in teams.values():
        if q in (t["short_name"].lower(), t["name"].lower(), str(t["id"])):
            return t["id"]
    for t in teams.values():
        if q in t["name"].lower():
            return t["id"]
    sys.exit(f"No team matches '{query}'. Try a short name like ARS, MUN, LIV.")


def fmt_kickoff(value):
    t = parse_time(value)
    return t.strftime("%a %d %b %H:%M") if t else "TBC"


def print_predictions(model, preds):
    teams = model["teams"]
    sn = lambda i: teams[i]["short_name"]
    last_ev = None
    for p in preds:
        if p["event"] != last_ev:
            last_ev = p["event"]
            print(f"\nGW{last_ev}")
            print(f"  {'kick-off (UTC)':17}{'home':>5} {'xG':>9} {'away':<5}"
                  f"{'home':>7}{'draw':>7}{'away':>7}   likely  btts")
        fav = max(("home", "draw", "away"), key=lambda k: p[k])
        cells = []
        for k in ("home", "draw", "away"):
            cell = f"{p[k]:6.0%}"
            cells.append(cell + ("*" if k == fav else " "))
        s = p["score"]
        print(f"  {fmt_kickoff(p['kickoff']):17}{sn(p['home_id']):>5} "
              f"{p['xg_home']:4.1f}-{p['xg_away']:<4.1f} {sn(p['away_id']):<5}"
              f"{''.join(cells)}  {s[0]}-{s[1]}   {p['btts']:4.0%}")


def print_ratings(model):
    teams = model["teams"]
    rows = sorted(teams, key=lambda t: -(model["att"][t] - model["def"][t]))
    print(f"\nRatings ({model['source']}; 1.00 = league average)")
    print(f"  {'team':6}{'attack':>8}{'defence':>9}{'overall':>9}{'played':>8}")
    print("  " + " " * 6 + f"{'(x goals)':>8}{'(x conc.)':>9}")
    for t in rows:
        a, d = math.exp(model["att"][t]), math.exp(model["def"][t])
        print(f"  {teams[t]['short_name']:6}{a:8.2f}{d:9.2f}{a / d:9.2f}{model['n_played'][t]:8d}")


def print_streaks(model, rows, n, only_team=None):
    teams = model["teams"]
    sn = lambda i: teams[i]["short_name"]
    if only_team:
        rows = [r for r in rows if r["team"] == only_team]
    print(f"\nP(win the next {n} in a row) - product of each fixture's win chance")
    for r in rows:
        print(f"  {sn(r['team']):5} win all {r['p_win_all']:7.2%}  (1 in "
              f"{1 / r['p_win_all']:,.0f})   unbeaten {r['p_unbeaten']:6.1%}")
        if only_team:
            for (p, side), w in zip(r["games"], r["path"]):
                opp = p["away_id"] if side == "home" else p["home_id"]
                print(f"       GW{p['event']:<3} {'vs' if side == 'home' else ' @'} "
                      f"{sn(opp):5} win {w:5.1%}")


def write_csv(path, model, preds):
    teams = model["teams"]
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["event", "kickoff_utc", "home", "away", "xg_home", "xg_away",
                    "p_home", "p_draw", "p_away", "likely_score", "p_btts",
                    "p_cs_home", "p_cs_away"])
        for p in preds:
            w.writerow([p["event"], p["kickoff"] or "", teams[p["home_id"]]["name"],
                        teams[p["away_id"]]["name"], f"{p['xg_home']:.2f}",
                        f"{p['xg_away']:.2f}", f"{p['home']:.4f}", f"{p['draw']:.4f}",
                        f"{p['away']:.4f}", f"{p['score'][0]}-{p['score'][1]}",
                        f"{p['btts']:.4f}", f"{p['cs_home']:.4f}", f"{p['cs_away']:.4f}"])


def main(argv=None):
    ap = argparse.ArgumentParser(description="Predict every remaining Premier "
                                 "League fixture from FPL API data.")
    ap.add_argument("--horizon", type=int, help="only the next N gameweeks")
    ap.add_argument("--gw", type=int, help="only this gameweek")
    ap.add_argument("--team", help="only fixtures for this team (e.g. MUN)")
    ap.add_argument("--streak", type=int, metavar="N",
                    help="P(next N wins) per team, the slides' path product")
    ap.add_argument("--ratings", action="store_true", help="print team ratings")
    ap.add_argument("--csv", metavar="FILE", help="write predictions to CSV")
    ap.add_argument("--json", metavar="FILE", help="write predictions to JSON")
    ap.add_argument("--backtest", action="store_true",
                    help="score the model on finished gameweeks")
    ap.add_argument("--no-xg", action="store_true", help="goals-only ratings")
    ap.add_argument("--data-dir", help="read saved API responses instead of fetching")
    ap.add_argument("--save-dir", help="save the API responses for offline reuse")
    args = ap.parse_args(argv)

    bootstrap, fixtures = load_data(args.data_dir, args.save_dir)
    model = build_model(bootstrap, fixtures, use_xg=not args.no_xg)
    teams = model["teams"]
    cur = current_event(bootstrap)

    upcoming = sorted((f for f in fixtures if is_upcoming(f, cur)),
                      key=lambda f: (f["event"], f.get("kickoff_time") or "", f["id"]))
    unscheduled = sum(1 for f in fixtures if not is_played(f) and f.get("event") is None)
    all_preds = [predict_fixture(model, f) for f in upcoming]

    preds = all_preds
    if upcoming:
        first = upcoming[0]["event"]
        if args.gw:
            preds = [p for p in preds if p["event"] == args.gw]
        elif args.horizon:
            preds = [p for p in preds if p["event"] < first + args.horizon]
    team_id = find_team(teams, args.team) if args.team else None
    if team_id:
        preds = [p for p in preds if team_id in (p["home_id"], p["away_id"])]

    print(f"FPL match predictor - {model['n_fixtures_used']} finished fixtures, "
          f"ratings from {model['source']}, league base "
          f"{model['base_h']:.2f} home / {model['base_a']:.2f} away goals")
    if model["n_fixtures_used"] < 60:
        print("Early season: ratings lean on the fixture-difficulty prior; "
              "expect them to sharpen week by week.")
    if unscheduled:
        print(f"{unscheduled} postponed fixture(s) have no gameweek yet and are skipped.")

    if args.ratings:
        print_ratings(model)
    if preds:
        print_predictions(model, preds)
    else:
        print("\nNo upcoming fixtures match those filters.")
    if args.streak:
        print_streaks(model, streak_table(all_preds, list(teams), args.streak), args.streak, team_id)
    if args.backtest:
        backtest(bootstrap, fixtures)
    if args.csv:
        write_csv(args.csv, model, preds)
        print(f"\nWrote {len(preds)} fixtures to {args.csv}")
    if args.json:
        with open(args.json, "w") as fh:
            json.dump([{**p, "home": teams[p["home_id"]]["name"],
                        "away": teams[p["away_id"]]["name"],
                        "p_home": p["home"], "p_draw": p["draw"], "p_away": p["away"]}
                       for p in preds], fh, indent=1, default=str)
        print(f"Wrote {len(preds)} fixtures to {args.json}")


if __name__ == "__main__":
    main()
