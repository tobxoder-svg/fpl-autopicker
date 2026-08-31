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

import { nbinomSf, nbinomVar, poissonFloorDiv } from "./distributions";
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
export function expectedMinutes(p: Player): MinutesResult {
  const games = Math.max(1, p.appearances);
  const startRate = clamp(p.starts / games, 0, 1);
  const cameoRate = clamp((p.appearances - p.starts) / games, 0, 1);

  // Availability multiplier from the API's own injury flag.
  const avail =
    p.status === "a"
      ? 1
      : p.chanceOfPlaying === null
        ? p.status === "u" || p.status === "s" || p.status === "i"
          ? 0
          : 0.5
        : p.chanceOfPlaying / 100;

  // Regress thin samples toward a squad-player prior rather than trusting one
  // start out of one appearance.
  const weight = games / (games + 3);
  const pStart = clamp((startRate * weight + 0.45 * (1 - weight)) * avail, 0, 1);
  const pCameo = clamp(cameoRate * weight * avail, 0, 1 - pStart);

  // Minutes per start, from observed data where there is enough of it.
  const minsPerStart = p.starts > 0 ? clamp(p.minutes / p.starts, 45, 90) : 78;
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
export function defconMean(p: Player, team: Team, minutesScale: number): number {
  const opponentPossession = 1 - team.possession;
  return p.defcon90 * Math.pow(opponentPossession / 0.5, 0.6) * minutesScale;
}

export function expectedPoints(
  p: Player,
  team: Team,
  opponent: Team,
  home: boolean,
): XpResult {
  const mins = expectedMinutes(p);
  const scale = mins.xmins / 90;

  // 2 — attacking returns
  const mult = attackMultiplier(team, opponent, home);
  const pens = p.penShare * LEAGUE_PENS * team.attack * scale;
  const xg = p.npxg90 * mult * scale + pens * PEN_CONVERSION;
  const xa = p.xa90 * mult * scale;
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
  if (p.pos !== "GK" && p.defcon90 > 0) {
    expActions = defconMean(p, team, scale);
    pDefcon = nbinomSf(DEFCON_THRESHOLD[p.pos], expActions, DEFCON_DISPERSION);
  }
  const defcon = pDefcon * DEFCON_POINTS;

  // 6 — saves, 1 per 3
  const saves =
    p.pos === "GK" ? poissonFloorDiv(p.saves90 * opponent.attack * scale, 3) : 0;

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
  const actionVar = p.defcon90 > 0 ? nbinomVar(r.expActions, 6.5) * 0 : 0; // held for a future fit
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
