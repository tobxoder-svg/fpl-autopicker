/**
 * Who gets the armband — shared by the runner and the Autopilot tab.
 *
 * The squad planner already picks the starter with the highest model xP. That's
 * one opinion. The captain is worth double (triple with the chip), so it's the
 * single decision most worth a second and third opinion:
 *
 *   1. Our model, per fixture (sums both games in a double gameweek).
 *   2. Bookmakers: the expected goals and clean-sheet chance implied by the
 *      1X2 and over/under prices (src/lib/odds.ts). They price in team news
 *      and rotation the model can't see. Blended into the model's goal rates
 *      for that fixture with `oddsWeight`, so a striker's attacking points scale
 *      with his team's market xG, a defender's clean sheet with the market's.
 *   3. FPL's own projection (ep_next) — weight `fplEpWeight`.
 *   4. Recent form (points per match, last 30 days) — weight `formWeight`.
 *
 * Then minutes security (a flagged player can't captain), and a style dial
 * (`captainDifferential`): negative leans to the template captain with steadier
 * returns — protects rank; positive to the low-owned pick with upside — gains it.
 * Ownership is overall ownership, a proxy for how many rivals captain him.
 */

import type { Dataset } from "./data";
import type { FixtureOdds } from "./odds";
import type { AutoCriteria } from "./autoplan";
import { expectedPoints, fixtureLambdas, pointsStdDev } from "../model/xp";

export interface CaptainRow {
  id: number;
  name: string;
  /** "ARS (H)", "che (a)" style, one per fixture. */
  fixtures: string[];
  /** Our model's xP for the gameweek. */
  model: number;
  /** The model with the bookmakers' goal rates blended in; null without odds. */
  withOdds: number | null;
  ep: number | null;
  form: number | null;
  ownership: number;
  sigma: number;
  /** Blended expected points. */
  mean: number;
  /** What it ranks on: the mean adjusted for style. */
  score: number;
  eligible: boolean;
  reasons: string[];
}

type OddsLookup = (event: number, teamH: number, teamA: number) => FixtureOdds | null;
type CaptainCriteria = Pick<AutoCriteria, "oddsWeight" | "fplEpWeight" | "formWeight" | "captainDifferential">;

/** Plays (or is likely to): no flag, or a flag of 75% or better. */
function available(status: string, chance: number | null): boolean {
  if (chance != null) return chance >= 75;
  return status === "a";
}

export function rankCaptains(opts: {
  ds: Dataset;
  ids: number[];
  event: number;
  odds?: OddsLookup | null;
  criteria: CaptainCriteria;
}): CaptainRow[] {
  const { ds, ids, event, criteria } = opts;
  const rows: CaptainRow[] = [];

  for (const id of ids) {
    const p = ds.playersById.get(id);
    const team = p ? ds.teamsById.get(p.teamId) : undefined;
    if (!p || !team) {
      rows.push({ id, name: `#${id}`, fixtures: [], model: 0, withOdds: null, ep: null, form: null, ownership: 0, sigma: 0, mean: 0, score: -Infinity, eligible: false, reasons: ["no data"] });
      continue;
    }
    const fixtures = (ds.fixturesByTeam.get(p.teamId) ?? []).filter((f) => f.event === event);
    let model = 0;
    let withOdds = 0;
    let anyOdds = false;
    let variance = 0;
    const labels: string[] = [];
    const oddsNotes: string[] = [];

    for (const fx of fixtures) {
      const opp = ds.teamsById.get(fx.opponentId);
      if (!opp) continue;
      const r = expectedPoints(p, team, opp, fx.home);
      model += r.xp;
      variance += pointsStdDev(p, r) ** 2;
      labels.push(fx.home ? `${opp.short} (H)` : `${opp.short.toLowerCase()} (a)`);

      const o = opts.odds?.(event, fx.home ? team.id : opp.id, fx.home ? opp.id : team.id) ?? null;
      if (!o) {
        withOdds += r.xp;
        continue;
      }
      anyOdds = true;
      const m = fixtureLambdas(team, opp, fx.home);
      const w = criteria.oddsWeight;
      const mktFor = fx.home ? o.lamH : o.lamA;
      const mktAgainst = fx.home ? o.lamA : o.lamH;
      const forUsed = (1 - w) * m.goalsFor + w * mktFor;
      const againstUsed = (1 - w) * m.goalsAgainst + w * mktAgainst;
      const b = r.breakdown;
      const attacking = b.attacking * (m.goalsFor > 0 ? forUsed / m.goalsFor : 1);
      const cleanSheet = b.cleanSheet * Math.exp(-(againstUsed - m.goalsAgainst));
      const conceded = b.conceded * (m.goalsAgainst > 0 ? againstUsed / m.goalsAgainst : 1);
      const delta = attacking - b.attacking + (cleanSheet - b.cleanSheet) + (conceded - b.conceded);
      const base = b.appearance + b.attacking + b.cleanSheet + b.conceded + b.defcon + b.saves;
      // Bonus follows the rest of the score.
      const bonus = base > 0 ? (b.bonus * Math.max(0, base + delta)) / base : b.bonus;
      withOdds += r.xp + delta + (bonus - b.bonus);
      oddsNotes.push(`market: ${team.short} ${mktFor.toFixed(1)} xG, ${Math.round(Math.exp(-mktAgainst) * 100)}% clean sheet`);
    }

    const n = fixtures.length;
    const ep = p.epNext ?? null;
    const form = p.form ?? null;
    const own = p.ownership ?? 0;
    const sigma = Math.sqrt(variance);
    const base = anyOdds ? withOdds : model;
    const wEp = ep != null ? criteria.fplEpWeight : 0;
    // Form is per match: a double gameweek doubles it.
    const wForm = form != null ? criteria.formWeight : 0;
    const mean = (1 - wEp - wForm) * base + wEp * (ep ?? 0) + wForm * (form ?? 0) * n;

    const d = criteria.captainDifferential;
    const ownShare = Math.min(1, own / 100);
    const styled = d >= 0 ? mean * (1 - 0.5 * d * ownShare) + 0.25 * d * sigma : mean * (1 + 0.3 * -d * ownShare) + 0.25 * d * sigma;

    const eligible = n > 0 && available(p.status, p.chanceOfPlaying);
    const reasons: string[] = [];
    if (n === 0) reasons.push("no game this gameweek");
    if (n > 1) reasons.push(`double gameweek (${n} games)`);
    if (!available(p.status, p.chanceOfPlaying)) reasons.push(`flagged${p.chanceOfPlaying != null ? ` ${p.chanceOfPlaying}%` : ""}`);
    if (p.penaltiesOrder === 1) reasons.push("on penalties");
    else if (p.freekicksOrder === 1) reasons.push("on direct free kicks");
    reasons.push(...oddsNotes);
    if (ep != null) reasons.push(`FPL projects ${ep.toFixed(1)}`);
    if (form != null && form >= 6) reasons.push(`in form (${form.toFixed(1)} a game)`);
    if (own >= 30) reasons.push(`template (${own.toFixed(0)}% owned)`);
    else if (own < 10) reasons.push(`differential (${own.toFixed(1)}% owned)`);

    rows.push({
      id,
      name: p.webName,
      fixtures: labels,
      model,
      withOdds: anyOdds ? withOdds : null,
      ep,
      form,
      ownership: own,
      sigma,
      mean,
      score: eligible ? styled : -Infinity,
      eligible,
      reasons,
    });
  }

  return rows.sort((a, b) => b.score - a.score || b.mean - a.mean);
}

/** Captain and vice from a ranking: the top two eligible players. */
export function pickCaptain(rows: CaptainRow[], fallback: { captain: number; vice: number }) {
  const ok = rows.filter((r) => r.eligible);
  if (!ok.length) return { ...fallback, fromRanking: false };
  const captain = ok[0].id;
  const vice = ok[1]?.id ?? (fallback.vice !== captain ? fallback.vice : fallback.captain);
  return { captain, vice, fromRanking: true };
}
