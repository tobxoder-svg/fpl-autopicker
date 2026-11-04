/**
 * Match predictions: win / draw / loss for every remaining fixture.
 *
 * Port of fpl_match_predictor.py. The weighted binary tree from the "five in a
 * row" slides is kept — a run of wins is the product of the win probability at
 * each fork — but each fork's weight now comes from a two-sided goals model, so
 * both teams' numbers always add up (home + draw + away = 1).
 *
 *   1. Ratings. Each club gets attack and defence on a log scale (0 = league
 *      average), fitted from actual goals (time-decayed) and from season xG/xGA,
 *      then blended. Both fits are opponent-adjusted.
 *   2. Prior. Early-season samples are tiny, so ratings are shrunk toward a prior
 *      built from FPL fixture difficulty (the `strength_*` fields are zero in
 *      2026/27). Older bundles without difficulty fall back to the existing team
 *      ratings as the prior.
 *   3. Match. λ_home = base_home · exp(att_h + def_a), λ_away likewise, then a
 *      Dixon–Coles corrected Poisson score grid.
 *   4. Streaks. P(next N wins) = product of per-fixture win probabilities.
 *
 * The settings below are judgement, like the slides' multipliers — but each can
 * be checked with `backtest()` instead of being taken on faith.
 */

import { poissonPmf } from "./distributions";
import type { DataBundle, MatchResult } from "./types";

export const MATCH_SETTINGS = {
  goalsWeight: 0.35, // blend: 0.35 goals fit + 0.65 xG fit
  priorMatches: 6, // strength of the prior, in pseudo-matches
  fdrScale: 0.2, // log-rating per point of average fixture difficulty
  halfLifeDays: 90, // time decay for the goals fit
  rho: -0.06, // Dixon–Coles low-score correction (more 0-0 / 1-1)
  priorHomeGoals: 1.53,
  priorAwayGoals: 1.22,
  basePriorMatches: 40, // shrink this season's base rates toward the above
  maxGoals: 10,
};

export interface MatchModel {
  att: Map<number, number>;
  def: Map<number, number>;
  baseH: number;
  baseA: number;
  played: Map<number, number>;
  nResults: number;
  source: "goals" | "goals+xG";
}

export interface MatchPrediction {
  event: number;
  kickoff: string | null;
  teamH: number;
  teamA: number;
  xgH: number;
  xgA: number;
  pHome: number;
  pDraw: number;
  pAway: number;
  score: [number, number];
  pScore: number;
  pBtts: number;
  pCsHome: number;
  pCsAway: number;
}

type Outcome = "home" | "draw" | "away";

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

interface Prior {
  att: Map<number, number>;
  def: Map<number, number>;
}

function difficultyPrior(bundle: DataBundle): Prior {
  const ids = bundle.teams.map((t) => t.id);
  const withFdr = bundle.teams.filter((t) => typeof t.fdr === "number" && t.fdr > 0);
  const att = new Map<number, number>();
  const def = new Map<number, number>();

  if (withFdr.length >= ids.length / 2) {
    const mean = withFdr.reduce((s, t) => s + t.fdr!, 0) / withFdr.length;
    for (const t of bundle.teams) {
      const s = MATCH_SETTINGS.fdrScale * ((t.fdr && t.fdr > 0 ? t.fdr : mean) - mean);
      att.set(t.id, s);
      def.set(t.id, -s); // stronger: scores more, concedes less
    }
  } else {
    // Older bundle: lean on the ratings fetch-fpl.mjs already computed.
    for (const t of bundle.teams) {
      att.set(t.id, Math.log(Math.max(0.2, t.attack || 1)));
      def.set(t.id, Math.log(Math.max(0.2, t.defence || 1)));
    }
    centre(att);
    centre(def);
  }
  return { att, def };
}

function centre(m: Map<number, number>) {
  const mean = [...m.values()].reduce((a, b) => a + b, 0) / (m.size || 1);
  for (const [k, v] of m) m.set(k, v - mean);
}

/**
 * Opponent-adjusted multiplicative Poisson fit with a pseudo-match prior.
 * exp(att) = (scored + prior pseudo-goals) / (expected at average attack + prior exposure).
 */
function fitRatings(
  ids: number[],
  matches: Array<[number, number, number]>,
  scored: Map<number, number>,
  conceded: Map<number, number>,
  baseH: number,
  baseA: number,
  prior: Prior,
  iters = 200,
): { att: Map<number, number>; def: Map<number, number> } {
  const tau = MATCH_SETTINGS.priorMatches;
  const bAvg = (baseH + baseA) / 2;
  let att = new Map(prior.att);
  let def = new Map(prior.def);

  const byTeam = new Map<number, Array<[number, boolean, number]>>(ids.map((i) => [i, []]));
  for (const [h, a, w] of matches) {
    byTeam.get(h)?.push([a, true, w]);
    byTeam.get(a)?.push([h, false, w]);
  }

  for (let it = 0; it < iters; it++) {
    const newAtt = new Map<number, number>();
    for (const t of ids) {
      const num = (scored.get(t) ?? 0) + tau * bAvg * Math.exp(prior.att.get(t)!);
      let den = tau * bAvg;
      for (const [opp, home, w] of byTeam.get(t)!) den += w * (home ? baseH : baseA) * Math.exp(def.get(opp)!);
      newAtt.set(t, Math.log(num / den));
    }
    const newDef = new Map<number, number>();
    for (const t of ids) {
      const num = (conceded.get(t) ?? 0) + tau * bAvg * Math.exp(prior.def.get(t)!);
      let den = tau * bAvg;
      for (const [opp, home, w] of byTeam.get(t)!) den += w * (home ? baseA : baseH) * Math.exp(newAtt.get(opp)!);
      newDef.set(t, Math.log(num / den));
    }
    centre(newAtt);
    centre(newDef);
    att = newAtt;
    def = newDef;
  }
  return { att, def };
}

/**
 * Fit the match model. With `beforeEvent`, only results from earlier gameweeks
 * are used and xG is switched off (season xG totals would leak later matches) —
 * that is what the back-test needs.
 */
export function buildMatchModel(bundle: DataBundle, beforeEvent?: number): MatchModel {
  const S = MATCH_SETTINGS;
  const ids = bundle.teams.map((t) => t.id);
  let results = bundle.results ?? [];
  let useXg = true;
  if (beforeEvent !== undefined) {
    results = results.filter((r) => r.event < beforeEvent);
    useXg = false;
  }

  const n = results.length;
  const hg = results.reduce((s, r) => s + r.scoreH, 0);
  const ag = results.reduce((s, r) => s + r.scoreA, 0);
  const baseH = (hg + S.basePriorMatches * S.priorHomeGoals) / (n + S.basePriorMatches);
  const baseA = (ag + S.basePriorMatches * S.priorAwayGoals) / (n + S.basePriorMatches);

  const prior = difficultyPrior(bundle);

  // Goals fit, time-decayed relative to the latest result.
  const times = results.map((r) => (r.kickoff ? Date.parse(r.kickoff) : NaN));
  const ref = Math.max(...times.filter(Number.isFinite), -Infinity);
  const matches: Array<[number, number, number]> = [];
  const gFor = new Map<number, number>();
  const gAgainst = new Map<number, number>();
  const played = new Map<number, number>(ids.map((i) => [i, 0]));
  const add = (m: Map<number, number>, k: number, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  results.forEach((r, i) => {
    const t = times[i];
    const w =
      Number.isFinite(t) && Number.isFinite(ref)
        ? Math.pow(0.5, (ref - t) / 86_400_000 / S.halfLifeDays)
        : 1;
    matches.push([r.teamH, r.teamA, w]);
    add(gFor, r.teamH, w * r.scoreH);
    add(gAgainst, r.teamH, w * r.scoreA);
    add(gFor, r.teamA, w * r.scoreA);
    add(gAgainst, r.teamA, w * r.scoreH);
    add(played, r.teamH, 1);
    add(played, r.teamA, 1);
  });
  const goals = fitRatings(ids, matches, gFor, gAgainst, baseH, baseA, prior);

  let att = goals.att;
  let def = goals.def;
  let source: MatchModel["source"] = "goals";

  if (useXg && n > 0) {
    const xFor = new Map<number, number>();
    const xAgainst = new Map<number, number>();
    for (const t of bundle.teams) {
      const p = played.get(t.id) ?? 0;
      if (typeof t.xgForPerMatch === "number") xFor.set(t.id, t.xgForPerMatch * p);
      if (typeof t.xgAgainstPerMatch === "number") xAgainst.set(t.id, t.xgAgainstPerMatch * p);
    }
    const total = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    if (xFor.size === ids.length && total(xFor) > 0 && total(xAgainst) > 0) {
      const unweighted = matches.map(([h, a]) => [h, a, 1] as [number, number, number]);
      const xg = fitRatings(ids, unweighted, xFor, xAgainst, baseH, baseA, prior);
      const gw = S.goalsWeight;
      att = new Map(ids.map((t) => [t, gw * goals.att.get(t)! + (1 - gw) * xg.att.get(t)!]));
      def = new Map(ids.map((t) => [t, gw * goals.def.get(t)! + (1 - gw) * xg.def.get(t)!]));
      source = "goals+xG";
    }
  }

  return { att, def, baseH, baseA, played, nResults: n, source };
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export function matchProbs(lamH: number, lamA: number, rho = MATCH_SETTINGS.rho) {
  const G = MATCH_SETTINGS.maxGoals;
  const ph = Array.from({ length: G + 1 }, (_, k) => poissonPmf(k, lamH));
  const pa = Array.from({ length: G + 1 }, (_, k) => poissonPmf(k, lamA));
  const grid = ph.map((x) => pa.map((y) => x * y));
  grid[0][0] *= Math.max(0, 1 - lamH * lamA * rho);
  grid[0][1] *= Math.max(0, 1 + lamH * rho);
  grid[1][0] *= Math.max(0, 1 + lamA * rho);
  grid[1][1] *= Math.max(0, 1 - rho);
  const total = grid.flat().reduce((a, b) => a + b, 0);

  let pHome = 0, pDraw = 0, pAway = 0, pBtts = 0, pCsHome = 0, pCsAway = 0;
  let score: [number, number] = [0, 0];
  let pScore = -1;
  for (let i = 0; i <= G; i++) {
    for (let j = 0; j <= G; j++) {
      const p = grid[i][j] / total;
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
      if (i > 0 && j > 0) pBtts += p;
      if (j === 0) pCsHome += p;
      if (i === 0) pCsAway += p;
      if (p > pScore) {
        pScore = p;
        score = [i, j];
      }
    }
  }
  return { pHome, pDraw, pAway, score, pScore, pBtts, pCsHome, pCsAway };
}

export function predictMatch(
  model: MatchModel,
  f: { event: number; teamH: number; teamA: number; kickoff?: string | null },
): MatchPrediction {
  const xgH = model.baseH * Math.exp((model.att.get(f.teamH) ?? 0) + (model.def.get(f.teamA) ?? 0));
  const xgA = model.baseA * Math.exp((model.att.get(f.teamA) ?? 0) + (model.def.get(f.teamH) ?? 0));
  return {
    event: f.event,
    kickoff: f.kickoff ?? null,
    teamH: f.teamH,
    teamA: f.teamA,
    xgH,
    xgA,
    ...matchProbs(xgH, xgA),
  };
}

/** Every remaining scheduled fixture, in kick-off order. Postponed ones (no GW) are skipped. */
export function predictAll(bundle: DataBundle, model = buildMatchModel(bundle)): MatchPrediction[] {
  return bundle.fixtures
    .filter((f): f is typeof f & { event: number } => f.event !== null && !f.finished)
    .map((f) => predictMatch(model, f))
    .sort(
      (a, b) =>
        a.event - b.event ||
        (a.kickoff ?? "").localeCompare(b.kickoff ?? "") ||
        a.teamH - b.teamH,
    );
}

// ---------------------------------------------------------------------------
// Streaks — the slides' path product, with a real weight at each fork
// ---------------------------------------------------------------------------

export interface StreakStep {
  prediction: MatchPrediction;
  home: boolean;
  opponentId: number;
  pWin: number;
  pLoss: number;
}

export interface Streak {
  teamId: number;
  steps: StreakStep[];
  pWinAll: number;
  pUnbeaten: number;
}

export function streakFor(predictions: MatchPrediction[], teamId: number, n: number): Streak | null {
  const steps: StreakStep[] = predictions
    .filter((p) => p.teamH === teamId || p.teamA === teamId)
    .slice(0, n)
    .map((p) => {
      const home = p.teamH === teamId;
      return {
        prediction: p,
        home,
        opponentId: home ? p.teamA : p.teamH,
        pWin: home ? p.pHome : p.pAway,
        pLoss: home ? p.pAway : p.pHome,
      };
    });
  if (steps.length < n) return null;
  return {
    teamId,
    steps,
    pWinAll: steps.reduce((acc, s) => acc * s.pWin, 1),
    pUnbeaten: steps.reduce((acc, s) => acc * (1 - s.pLoss), 1),
  };
}

// ---------------------------------------------------------------------------
// Back-test: refit before each gameweek, score that gameweek
// ---------------------------------------------------------------------------

export interface BacktestScore {
  logLoss: number;
  brier: number;
  pickRate: number;
}

export interface BacktestResult {
  n: number;
  model: BacktestScore;
  baseRates: BacktestScore;
  coinFlip: BacktestScore;
}

const OUTCOMES: Outcome[] = ["home", "draw", "away"];

function outcomeOf(r: MatchResult): Outcome {
  return r.scoreH > r.scoreA ? "home" : r.scoreH === r.scoreA ? "draw" : "away";
}

export function backtest(bundle: DataBundle, startEvent = 4): BacktestResult | null {
  const results = bundle.results ?? [];
  const events = [...new Set(results.map((r) => r.event))].filter((e) => e >= startEvent).sort((a, b) => a - b);
  const rows: Array<{ model: Record<Outcome, number>; base: Record<Outcome, number>; result: Outcome }> = [];

  for (const ev of events) {
    const model = buildMatchModel(bundle, ev);
    const prior = results.filter((r) => r.event < ev);
    const count = (o: Outcome) => prior.filter((r) => outcomeOf(r) === o).length;
    const n = prior.length;
    const base = Object.fromEntries(OUTCOMES.map((o) => [o, (count(o) + 1) / (n + 3)])) as Record<Outcome, number>;
    for (const r of results.filter((x) => x.event === ev)) {
      const p = predictMatch(model, r);
      rows.push({ model: { home: p.pHome, draw: p.pDraw, away: p.pAway }, base, result: outcomeOf(r) });
    }
  }
  if (!rows.length) return null;

  const score = (get: (r: (typeof rows)[number]) => Record<Outcome, number>): BacktestScore => {
    let ll = 0, br = 0, hit = 0;
    for (const r of rows) {
      const p = get(r);
      ll -= Math.log(Math.max(p[r.result], 1e-9));
      br += OUTCOMES.reduce((s, o) => s + (p[o] - (o === r.result ? 1 : 0)) ** 2, 0);
      const top = Math.max(...OUTCOMES.map((o) => p[o]));
      const picks = OUTCOMES.filter((o) => p[o] === top);
      hit += picks.includes(r.result) ? 1 / picks.length : 0; // ties share the credit
    }
    return { logLoss: ll / rows.length, brier: br / rows.length, pickRate: hit / rows.length };
  };

  return {
    n: rows.length,
    model: score((r) => r.model),
    baseRates: score((r) => r.base),
    coinFlip: score(() => ({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 })),
  };
}
