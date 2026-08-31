/**
 * The expected-points model: eight additive, separately testable components.
 *
 * Each is a pure function of (player, team, fixture). They are kept apart on
 * purpose — when a projection misses you need to know *which* term was wrong,
 * and a single fitted regressor can never tell you that.
 *
 * Season context: 2026/27. Defensive contribution points are live (DEF 10 CBIT,
 * MID/FWD 12 CBIRT, 2 pts, capped). The bonus-point system was retuned this
 * season to reduce its overlap with DEFCON and improve goalkeeper, full-back
 * and attacker bonus, so the bonus term below is deliberately a shrunk prior
 * rather than a fit on last season's data.
 */

import { nbinomSf, poissonFloorDiv } from "./distributions";
import type { Player, Position, Team, TeamFixture, XpResult } from "./types";

export const GOAL_POINTS: Record<Position, number> = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
export const CS_POINTS: Record<Position, number> = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
export const DEFCON_THRESHOLD: Record<Position, number> = { GK: 99, DEF: 10, MID: 12, FWD: 12 };
export const ASSIST_POINTS = 3;
export const DEFCON_POINTS = 2;
export const PEN_CONVERSION = 0.79;

const LEAGUE_GOALS = 1.4;
const LEAGUE_PENS = 0.11;
const HOME_ATTACK = 1.09;
const AWAY_ATTACK = 0.91;
const DEFCON_DISPERSION = 6.5;

/**
 * Positional priors for the per-90 rates, and the number of minutes of evidence
 * it takes for a player's own record to outweigh them.
 *
 * This is not decoration. A player with 15 minutes who happened to make three
 * tackles reads as 18 defensive actions per 90 — and, unshrunk, projects as the
 * best asset in the game. Regressing the start probability is not enough; the
 * rates themselves have to be regressed too, or every small sample becomes an
 * outlier the optimiser then goes hunting for.
 */
const RATE_PRIOR: Record<"npxg90" | "xa90" | "defcon90" | "saves90", Record<Position, number>> = {
  npxg90: { GK: 0.0, DEF: 0.05, MID: 0.12, FWD: 0.3 },
  xa90: { GK: 0.01, DEF: 0.07, MID: 0.14, FWD: 0.11 },
  defcon90: { GK: 0, DEF: 7.5, MID: 5.0, FWD: 2.2 },
  saves90: { GK: 2.9, DEF: 0, MID: 0, FWD: 0 },
};
const PRIOR_MINUTES = 450;

/** Shrinks an observed per-90 rate toward its positional prior by sample size. */
export function shrinkRate(observed: number, prior: number, minutes: number): number {
  return (observed * minutes + prior * PRIOR_MINUTES) / (minutes + PRIOR_MINUTES);
}

export interface ShrunkRates {
  npxg90: number;
  xa90: number;
  defcon90: number;
  saves90: number;
}

export function shrunkRates(p: Player): ShrunkRates {
  const m = Math.max(0, p.minutes);
  return {
    npxg90: shrinkRate(p.npxg90, RATE_PRIOR.npxg90[p.pos], m),
    xa90: shrinkRate(p.xa90, RATE_PRIOR.xa90[p.pos], m),
    defcon90: shrinkRate(p.defcon90, RATE_PRIOR.defcon90[p.pos], m),
    saves90: shrinkRate(p.saves90, RATE_PRIOR.saves90[p.pos], m),
  };
}

/** Bonus priors by position, shrunk hard — see the note at the top of the file. */
const BONUS_PRIOR: Record<Position, number> = { GK: 0.22, DEF: 0.26, MID: 0.2, FWD: 0.18 };
const BONUS_SHRINKAGE = 0.55;

// ---------------------------------------------------------------------------
// Component 1 — expected minutes
// ---------------------------------------------------------------------------

export interface MinutesResult {
  pStart: number;
  pAppear: number;
  p60: number;
  xmins: number;
  points: number;
}

/**
 * The highest-leverage component by a distance: every term below is scaled by
 * it. A flawless attacking model on a player who lasts 55 minutes is still a
 * bad projection.
 */
export function expectedMinutes(p: Player, team: Team): MinutesResult {
  // The club's matches played is the honest denominator. A player's own
  // appearance count is not: one start in one appearance is not a nailed starter.
  // Defaults to 2 for a bundle written before this field existed, so an old
  // snapshot degrades rather than turning every projection into NaN.
  const teamMatches = Math.max(1, Number.isFinite(team.matchesPlayed) ? team.matchesPlayed : 2);

  // Availability multiplier from the API's own injury flag.
  const avail =
    p.status === "a"
      ? 1
      : p.chanceOfPlaying === null
        ? p.status === "u" || p.status === "s" || p.status === "i"
          ? 0
          : 0.5
        : p.chanceOfPlaying / 100;

  // Regress toward a squad-player prior, with the club's matches as evidence.
  // Starts are a far lower-variance signal than the per-90 rates above, so this
  // prior is deliberately lighter: after two matches a player who started both
  // should read as a probable starter, not as a coin flip.
  const w = teamMatches / (teamMatches + 1.5);
  const startRate = clamp(p.starts / teamMatches, 0, 1);
  const minuteShare = clamp(p.minutes / (teamMatches * 90), 0, 1);

  // Two views of the same thing — how often they start, and how much of the
  // available football they actually play. Averaging them keeps a regular
  // substitute from being read as a starter.
  const evidence = (startRate + minuteShare) / 2;
  const pStart = clamp((evidence * w + 0.45 * (1 - w)) * avail, 0, 1);

  const appearanceRate = clamp((p.appearances - p.starts) / teamMatches, 0, 1);
  const pCameo = clamp(appearanceRate * w * avail, 0, Math.max(0, 1 - pStart));

  // Minutes per start, from observed data once there is enough of it.
  const minsPerStart = p.starts >= 2 ? clamp(p.minutes / p.starts, 45, 90) : 74;
  const p60GivenStart = clamp((minsPerStart - 40) / 45, 0.3, 0.97);

  const p60 = pStart * p60GivenStart;
  const pAppear = pStart + pCameo;
  const xmins = pStart * minsPerStart + pCameo * 18;

  return { pStart, pAppear, p60, xmins, points: 2 * p60 + (pAppear - p60) };
}

// ---------------------------------------------------------------------------
// Components 2-8
// ---------------------------------------------------------------------------

function attackMultiplier(team: Team, opponent: Team, home: boolean): number {
  return team.attack * opponent.defence * (home ? HOME_ATTACK : AWAY_ATTACK);
}

function lambdaConceded(team: Team, opponent: Team, home: boolean): number {
  return LEAGUE_GOALS * team.defence * opponent.attack * (home ? AWAY_ATTACK : HOME_ATTACK);
}

/**
 * DEFCON opportunity scales with the OPPONENT's share of the ball. A defender
 * on a 37%-possession side spends far more of the match defending, and clears
 * the 10-action threshold far more often than an equally capable player at a
 * possession-dominant club. This term is where most public models leave points
 * on the table.
 */
export function defconMean(rate: number, team: Team, minutesScale: number): number {
  const opponentPossession = 1 - team.possession;
  return rate * Math.pow(opponentPossession / 0.5, 0.6) * minutesScale;
}

export function expectedPoints(
  p: Player,
  team: Team,
  opponent: Team,
  home: boolean,
): XpResult {
  const mins = expectedMinutes(p, team);
  const scale = mins.xmins / 90;
  const rates = shrunkRates(p);

  // 2 — attacking returns
  const mult = attackMultiplier(team, opponent, home);
  const pens = p.penShare * LEAGUE_PENS * team.attack * scale;
  const xg = rates.npxg90 * mult * scale + pens * PEN_CONVERSION;
  const xa = rates.xa90 * mult * scale;
  const attacking = xg * GOAL_POINTS[p.pos] + xa * ASSIST_POINTS;

  // 3 — clean sheet (requires 60+ minutes)
  const lamC = lambdaConceded(team, opponent, home);
  const pCleanSheet = Math.exp(-lamC) * mins.p60;
  const cleanSheet = pCleanSheet * CS_POINTS[p.pos];

  // 4 — goals conceded, -1 per 2. Routinely omitted; it is the difference
  //     between a cheap defender being playable and being a trap.
  const conceded =
    p.pos === "GK" || p.pos === "DEF"
      ? -poissonFloorDiv(lamC * scale, 2) * mins.pAppear
      : 0;

  // 5 — defensive contribution
  let expActions = 0;
  let pDefcon = 0;
  if (p.pos !== "GK" && rates.defcon90 > 0) {
    expActions = defconMean(rates.defcon90, team, scale);
    pDefcon = nbinomSf(DEFCON_THRESHOLD[p.pos], expActions, DEFCON_DISPERSION);
  }
  const defcon = pDefcon * DEFCON_POINTS;

  // 6 — saves, 1 per 3
  const saves =
    p.pos === "GK" ? poissonFloorDiv(rates.saves90 * opponent.attack * scale, 3) : 0;

  const base = mins.points + attacking + cleanSheet + conceded + defcon + saves;

  // 7 — bonus (shrunk prior; the 2026/27 retune invalidates a 2025/26 fit)
  const bonus = BONUS_PRIOR[p.pos] * Math.max(0, base) * BONUS_SHRINKAGE + defcon * 0.1;

  // 8 — discipline. Small, but card risk correlates with high-DEFCON defenders,
  //     so it partially cancels the edge from component 5.
  const discipline = -(p.yellow90 * scale) - 3 * p.red90 * scale;

  const breakdown = {
    appearance: mins.points,
    attacking,
    cleanSheet,
    conceded,
    defcon,
    saves,
    bonus,
    discipline,
  };

  const xp = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { xp, breakdown, xmins: mins.xmins, pCleanSheet, pDefcon, expActions };
}

/**
 * Standard deviation of a player's points, for the risk-aware objective
 * (`xP - lambda * sigma`). Goals are lumpy and dominate the variance; DEFCON is
 * near-Bernoulli. Two players with identical xP can have very different spreads,
 * which is the whole reason the slider exists.
 */
export function pointsStdDev(p: Player, r: XpResult): number {
  const goalVar = Math.pow(GOAL_POINTS[p.pos], 2) * (r.breakdown.attacking > 0 ? r.xmins / 90 : 0) * 0.35;
  const csVar = Math.pow(CS_POINTS[p.pos], 2) * r.pCleanSheet * (1 - r.pCleanSheet);
  const dcVar = Math.pow(DEFCON_POINTS, 2) * r.pDefcon * (1 - r.pDefcon);
  const actionVar = 0; // negative-binomial action variance, held for a future fit
  return Math.sqrt(Math.max(0, goalVar + csVar + dcVar + actionVar));
}

/**
 * Total xP over a horizon, with per-gameweek decay. Uncertainty compounds, so
 * gameweek +5 must not weigh as much as gameweek +1. Blanks contribute nothing
 * and doubles contribute twice, which falls out of the fixture list itself.
 */
export function horizonXp(
  p: Player,
  team: Team,
  teamsById: Map<number, Team>,
  fixtures: TeamFixture[],
  horizon: number,
  decay: number,
  startEvent: number,
): { total: number; perEvent: Map<number, number> } {
  const perEvent = new Map<number, number>();
  let total = 0;
  for (const fx of fixtures) {
    const step = fx.event - startEvent;
    if (step < 0 || step >= horizon) continue;
    const opponent = teamsById.get(fx.opponentId);
    if (!opponent) continue;
    const r = expectedPoints(p, team, opponent, fx.home);
    const weighted = r.xp * Math.pow(decay, step);
    total += weighted;
    perEvent.set(fx.event, (perEvent.get(fx.event) ?? 0) + r.xp);
  }
  return { total, perEvent };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
