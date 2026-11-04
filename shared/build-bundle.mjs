/**
 * FPL API -> Fantasy Drafter bundle. Pure and dependency-free, so the same code
 * runs in the snapshot script (scripts/fetch-fpl.mjs) and the live Vercel
 * function (api/bundle.js) — the two can never drift apart.
 *
 * Findings that shaped it, all verified against the live endpoint:
 *   1. Every `strength_*` field on /teams is 0 and `strength` is null. Team
 *      ratings come from fixture difficulty plus observed xG/xGC instead.
 *   2. There is no `penalties_scored`, and `expected_goals` already includes
 *      penalty xG — so penalties must not be added a second time.
 */

const POSITIONS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
const MINUTES_PER_TEAM_MATCH = 990; // 11 players x 90


const num = (v) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};
const per90 = (total, minutes) => (minutes > 0 ? (num(total) * 90) / minutes : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n, d = 4) => Number(n.toFixed(d));

/**
 * Qualifying defensive actions. The API's own `defensive_contribution` is
 * authoritative — it already applies the positional rule (clearances, blocks,
 * interceptions and tackles for defenders; plus recoveries for everyone else)
 * and reports 0 for goalkeepers, who are excluded from the scoring. Verified
 * against live data: for a defender it equals CBI + tackles exactly, and for a
 * midfielder CBI + tackles + recoveries. The sum is only a fallback.
 */
function defensiveActions(el) {
  const explicit = num(el.defensive_contribution);
  if (explicit > 0) return explicit;
  const cbi = num(el.clearances_blocks_interceptions);
  const tackles = num(el.tackles);
  const recoveries = num(el.recoveries);
  return POSITIONS[el.element_type] === "DEF" ? cbi + tackles : cbi + tackles + recoveries;
}

/**
 * Fixture difficulty as a team-strength index, and the reason this function
 * exists at all: the `strength_*` fields are zeroed in the live API.
 *
 * The trick is that difficulty is assigned to the *opponent*. When team X plays
 * at home, `team_a_difficulty` is what the away side was told to expect — which
 * is a rating of X. Averaging that across X's fixtures gives a usable strength
 * index that is always populated, including before a ball is kicked.
 */
function difficultyIndex(teams, fixtures) {
  const seen = new Map(teams.map((t) => [t.id, []]));
  for (const f of fixtures) {
    if (f.event === null) continue;
    seen.get(f.team_h)?.push(num(f.team_a_difficulty));
    seen.get(f.team_a)?.push(num(f.team_h_difficulty));
  }
  const index = new Map(
    [...seen].map(([id, xs]) => [id, mean(xs.filter((x) => x > 0))]),
  );
  const avg = mean([...index.values()].filter((x) => x > 0)) || 3;
  return { index, avg };
}

/**
 * Team attack, defensive leakiness and possession share.
 *
 * Each is a fixture-difficulty prior blended toward what has actually been
 * observed, weighted by matches played — so gameweek 2 leans on the prior and
 * gameweek 20 leans on the data, without a cliff in between.
 *
 * Possession is the one the DEFCON model cares about most, and the FPL API does
 * not publish it. It is inferred from defensive-action volume: a side that
 * spends more of the match defending racks up more clearances, blocks,
 * interceptions, tackles and recoveries per 90. Swapping in a real feed (FBref,
 * Opta) is the highest-value data upgrade available to this project.
 */
function teamRatings(teams, elements, fixtures) {
  const { index: fdr, avg: fdrAvg } = difficultyIndex(teams, fixtures);

  const agg = new Map(teams.map((t) => [t.id, { xg: 0, xgc: 0, minutes: 0, actions: 0 }]));
  for (const el of elements) {
    const g = agg.get(el.team);
    if (!g) continue;
    g.xg += num(el.expected_goals);
    g.xgc += num(el.expected_goals_conceded);
    g.minutes += num(el.minutes);
    g.actions += defensiveActions(el);
  }

  // Team xG is a plain sum — each shot belongs to exactly one player. Team xGC
  // is not: every player on the pitch accrues it, so the per-90 form of the sum
  // is what recovers the per-match figure.
  const xgPerMatch = (id) => {
    const g = agg.get(id);
    const matches = g.minutes / MINUTES_PER_TEAM_MATCH;
    return matches > 0 ? g.xg / matches : 0;
  };
  const xgcPerMatch = (id) => per90(agg.get(id).xgc, agg.get(id).minutes);
  const actionRate = (id) => per90(agg.get(id).actions, agg.get(id).minutes);

  const leagueXg = mean(teams.map((t) => xgPerMatch(t.id)).filter((x) => x > 0)) || 1;
  const leagueXgc = mean(teams.map((t) => xgcPerMatch(t.id)).filter((x) => x > 0)) || 1;
  const leagueActions = mean(teams.map((t) => actionRate(t.id)).filter((x) => x > 0)) || 1;

  return new Map(
    teams.map((t) => {
      const g = agg.get(t.id);
      const matches = g.minutes / MINUTES_PER_TEAM_MATCH;
      const w = clamp(matches / (matches + 6), 0, 1); // ~6 matches to trust the data
      const idx = (fdr.get(t.id) || fdrAvg) / fdrAvg; // >1 = harder to face = stronger

      const attack = clamp(
        clamp(xgPerMatch(t.id) / leagueXg, 0.5, 2) * w + clamp(0.55 + 0.45 * idx, 0.6, 1.6) * (1 - w),
        0.6,
        1.6,
      );
      const defence = clamp(
        clamp(xgcPerMatch(t.id) / leagueXgc, 0.4, 2) * w + clamp(1.55 - 0.55 * idx, 0.55, 1.6) * (1 - w),
        0.55,
        1.6,
      );
      const possession = clamp(
        (0.5 - 0.55 * (actionRate(t.id) / leagueActions - 1)) * w + (0.5 + 0.28 * (idx - 1)) * (1 - w),
        0.3,
        0.68,
      );

      return [
        t.id,
        {
          attack: round(attack),
          defence: round(defence),
          possession: round(possession),
          matchesPlayed: round(matches, 2),
          // Match-predictor inputs: raw strength signals, not blended ratings,
          // so the predictor can do its own opponent adjustment.
          fdr: round(fdr.get(t.id) || fdrAvg, 3),
          xgForPerMatch: round(xgPerMatch(t.id), 3),
          xgAgainstPerMatch: round(xgcPerMatch(t.id), 3),
        },
      ];
    }),
  );
}

/** Fails loudly rather than writing a bundle that renders every projection NaN. */
function assertSane(teams, players) {
  const bad = teams.filter(
    (t) => ![t.attack, t.defence, t.possession].every((v) => Number.isFinite(v) && v > 0),
  );
  if (bad.length) {
    throw new Error(`non-finite team ratings for: ${bad.map((t) => t.short).join(", ")}`);
  }
  if (teams.length < 20) throw new Error(`only ${teams.length} teams — API shape changed?`);
  if (teams.some((t) => !Number.isFinite(t.matchesPlayed))) {
    throw new Error("matchesPlayed is not finite — the minutes aggregate failed");
  }
  if (players.length < 300) throw new Error(`only ${players.length} players — API shape changed?`);

  const numeric = ["npxg90", "xa90", "defcon90", "saves90", "yellow90", "red90", "cost"];
  for (const p of players) {
    for (const k of numeric) {
      if (!Number.isFinite(p[k])) throw new Error(`${p.webName}.${k} is not finite`);
    }
  }
  const withXg = players.filter((p) => p.npxg90 > 0).length;
  const withDefcon = players.filter((p) => p.defcon90 > 0).length;
  if (withXg < 50) throw new Error(`only ${withXg} players have xG — check expected_goals`);
  if (withDefcon < 50) {
    throw new Error(`only ${withDefcon} players have defensive actions — check defensive_contribution`);
  }
  const spread = teams.map((t) => t.possession);
  if (Math.max(...spread) - Math.min(...spread) < 0.05) {
    throw new Error("possession proxy is flat — the derivation collapsed");
  }
}

/**
 * @param boot        bootstrap-static response
 * @param fixturesRaw fixtures response
 * @returns DataBundle (see src/model/types.ts); throws if the result would
 *          render every projection NaN.
 */
export function buildBundle(boot, fixturesRaw, { generatedAt = new Date().toISOString() } = {}) {
  const ratings = teamRatings(boot.teams, boot.elements, fixturesRaw);
  const teams = boot.teams.map((t) => ({
    id: t.id,
    name: t.name,
    short: t.short_name,
    ...ratings.get(t.id),
  }));

  const players = boot.elements
    .filter((el) => num(el.minutes) > 0 || el.status === "a")
    .map((el) => {
      const minutes = num(el.minutes);
      const starts = num(el.starts);
      // Prefer the API's own per-90 fields; fall back to computing them.
      const pick = (per90Field, totalField) =>
        num(el[per90Field]) > 0 ? num(el[per90Field]) : per90(el[totalField], minutes);

      return {
        id: el.id,
        name: `${el.first_name} ${el.second_name}`.trim(),
        webName: el.web_name,
        pos: POSITIONS[el.element_type],
        teamId: el.team,
        cost: num(el.now_cost),
        status: el.status ?? "a",
        chanceOfPlaying: el.chance_of_playing_next_round ?? null,
        ownership: num(el.selected_by_percent),
        minutes,
        starts,
        appearances: Math.max(starts, minutes > 0 ? 1 : 0),

        // `expected_goals` already includes penalty xG, and the API exposes no
        // `penalties_scored` to net it out. So this is total xG, not npxG, and
        // `penShare` below is held at 0 — adding a separate penalty term would
        // double-count every penalty taker. Wiring in a real npxG feed is what
        // would let the penalty term come back.
        npxg90: round(pick("expected_goals_per_90", "expected_goals")),
        xa90: round(pick("expected_assists_per_90", "expected_assists")),
        defcon90:
          num(el.defensive_contribution_per_90) > 0
            ? round(num(el.defensive_contribution_per_90))
            : round(per90(defensiveActions(el), minutes)),
        saves90: round(pick("saves_per_90", "saves")),
        yellow90: round(per90(el.yellow_cards, minutes)),
        red90: round(per90(el.red_cards, minutes)),
        penShare: 0,
        /** Kept for display only — see the note above. 1 = first-choice taker. */
        penaltiesOrder: el.penalties_order ?? null,
        totalPoints: num(el.total_points),
      };
    });

  assertSane(teams, players);

  const current = boot.events.find((e) => e.is_current);
  const next = boot.events.find((e) => e.is_next);
  const startEvent = next?.id ?? (current?.id ?? 0) + 1;

  // Gameweek stats land before its fixtures are flagged `finished`, so filtering
  // on `finished` alone would leave the just-played round looking upcoming.
  const fixtures = fixturesRaw
    .filter((f) => f.event !== null && f.event >= startEvent && !f.finished)
    .map((f) => ({
      event: f.event,
      teamH: f.team_h,
      teamA: f.team_a,
      finished: false,
      kickoff: f.kickoff_time ?? null,
    }));

  // Played league matches, for the match predictor. A score plus either finished
  // flag counts — `finished_provisional` flips first, before bonus is confirmed.
  const results = fixturesRaw
    .filter(
      (f) =>
        f.event !== null &&
        f.team_h_score !== null &&
        f.team_a_score !== null &&
        (f.finished || f.finished_provisional),
    )
    .map((f) => ({
      event: f.event,
      kickoff: f.kickoff_time ?? null,
      teamH: f.team_h,
      teamA: f.team_a,
      scoreH: num(f.team_h_score),
      scoreA: num(f.team_a_score),
    }));

  const bundle = {
    generatedAt,
    season: "2026/27",
    currentEvent: current?.id ?? null,
    nextEvent: next?.id ?? null,
    teams,
    players,
    fixtures,
    results,
  };

  return bundle;
}
