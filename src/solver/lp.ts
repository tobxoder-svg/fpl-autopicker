/**
 * Builds the squad-selection MILP in CPLEX LP format for HiGHS.
 *
 * What this model solves exactly:
 *   - the 15-man squad, subject to budget, shape and the 3-per-club rule
 *   - the starting XI and captain for the NEXT gameweek
 *
 * How the rest of the horizon enters: each candidate carries a decayed sum of
 * its later-gameweek xP, weighted by `startShare` (the fraction of the horizon a
 * squad member is expected to actually start). That keeps the model at 3N
 * binaries and sub-second, at the cost of not planning transfers.
 *
 * The full multi-gameweek transfer model — free-transfer rollover, hits, chip
 * scheduling — is the next milestone. Its one real trap is that
 * `ft[t+1] = min(5, ft[t] - used[t] + 1)` is non-linear and needs auxiliary
 * binaries plus a big-M; that is where multi-GW FPL models quietly start
 * emitting illegal transfer plans.
 */

import type { Position } from "../model/types";

export interface Candidate {
  id: number;
  pos: Position;
  teamId: number;
  cost: number;
  /** xP for the next gameweek (may be 0 on a blank, or doubled on a double). */
  xpNext: number;
  /** Decay-weighted xP for the remainder of the horizon. */
  xpFuture: number;
  /** Standard deviation of next-gameweek points, for the risk term. */
  sigma: number;
  ownership: number;
}

export interface SolveParams {
  budget: number;
  minBank: number;
  maxPerClub: number;
  benchWeight: number;
  benchGkWeight: number;
  startShare: number;
  riskLambda: number;
  ownershipWeight: number;
  forceIn: number[];
  forceOut: number[];
}

export const SQUAD_SHAPE: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
export const XI_MIN: Record<Position, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
export const XI_MAX: Record<Position, number> = { GK: 1, DEF: 5, MID: 5, FWD: 3 };
export const SQUAD_SIZE = 15;
export const XI_SIZE = 11;

const r5 = (n: number) => Number(n.toFixed(5));

function terms(pairs: Array<[number, string]>): string {
  const out: string[] = [];
  for (const [coefRaw, name] of pairs) {
    const coef = r5(coefRaw);
    if (coef === 0) continue;
    out.push(coef >= 0 ? `+ ${coef} ${name}` : `- ${Math.abs(coef)} ${name}`);
  }
  return out.length ? out.join(" ") : "+ 0 zero";
}

/** Per-candidate objective value if the player sits on the bench all horizon. */
function benchValue(c: Candidate, p: SolveParams): number {
  const w = c.pos === "GK" ? p.benchGkWeight : p.benchWeight;
  return w * c.xpNext;
}

/** Per-candidate objective value contributed just by being in the squad. */
function squadValue(c: Candidate, p: SolveParams): number {
  return (
    c.xpFuture * p.startShare -
    p.riskLambda * c.sigma +
    p.ownershipWeight * (c.ownership / 100)
  );
}

export function buildSquadLp(
  candidates: Candidate[],
  params: SolveParams,
  /** Previously returned squads, as arrays of candidate indices, for k-best. */
  exclude: number[][] = [],
  minDifference = 2,
): string {
  const n = candidates.length;
  const obj: Array<[number, string]> = [];
  const cons: string[] = [];

  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    // Starting: full xP. Captain: a second helping. Bench: x - y at bench weight.
    obj.push([c.xpNext - benchValue(c, params), `y${i}`]);
    obj.push([c.xpNext, `c${i}`]);
    obj.push([squadValue(c, params) + benchValue(c, params), `x${i}`]);
  }

  const all = (prefix: string) =>
    Array.from({ length: n }, (_, i) => [1, `${prefix}${i}`] as [number, string]);

  cons.push(`squad: ${terms(all("x"))} = ${SQUAD_SIZE}`);
  cons.push(`xi: ${terms(all("y"))} = ${XI_SIZE}`);
  cons.push(`cap: ${terms(all("c"))} = 1`);

  for (const pos of ["GK", "DEF", "MID", "FWD"] as Position[]) {
    const xs = candidates
      .map((c, i) => [c.pos === pos ? 1 : 0, `x${i}`] as [number, string])
      .filter(([k]) => k);
    const ys = candidates
      .map((c, i) => [c.pos === pos ? 1 : 0, `y${i}`] as [number, string])
      .filter(([k]) => k);
    cons.push(`shape_${pos}: ${terms(xs)} = ${SQUAD_SHAPE[pos]}`);
    cons.push(`ximin_${pos}: ${terms(ys)} >= ${XI_MIN[pos]}`);
    cons.push(`ximax_${pos}: ${terms(ys)} <= ${XI_MAX[pos]}`);
  }

  cons.push(
    `budget: ${terms(candidates.map((c, i) => [c.cost, `x${i}`]))} <= ${params.budget - params.minBank}`,
  );

  const byClub = new Map<number, Array<[number, string]>>();
  candidates.forEach((c, i) => {
    if (!byClub.has(c.teamId)) byClub.set(c.teamId, []);
    byClub.get(c.teamId)!.push([1, `x${i}`]);
  });
  for (const [teamId, vars] of byClub) {
    cons.push(`club_${teamId}: ${terms(vars)} <= ${params.maxPerClub}`);
  }

  // Linking: a starter must be in the squad, a captain must be a starter.
  for (let i = 0; i < n; i++) {
    cons.push(`ly${i}: + 1 y${i} - 1 x${i} <= 0`);
    cons.push(`lc${i}: + 1 c${i} - 1 y${i} <= 0`);
  }

  const indexById = new Map(candidates.map((c, i) => [c.id, i]));
  for (const id of params.forceIn) {
    const i = indexById.get(id);
    if (i !== undefined) cons.push(`fin${i}: + 1 x${i} = 1`);
  }
  for (const id of params.forceOut) {
    const i = indexById.get(id);
    if (i !== undefined) cons.push(`fout${i}: + 1 x${i} = 0`);
  }

  // k-best: each new squad must differ from every previous one by at least
  // `minDifference` players. Without this the "alternatives" are the same squad
  // with one 4.0m defender swapped, which tells the user nothing.
  exclude.forEach((prev, k) => {
    const vars = prev.map((i) => [1, `x${i}`] as [number, string]);
    cons.push(`div${k}: ${terms(vars)} <= ${SQUAD_SIZE - minDifference}`);
  });

  const bins: string[] = [];
  for (let i = 0; i < n; i++) bins.push(`x${i}`, `y${i}`, `c${i}`);

  return [
    "Maximize",
    ` obj: ${terms(obj)}`,
    "Subject To",
    ...cons.map((c) => ` ${c}`),
    "Bounds",
    " zero = 0",
    "Binary",
    ` ${bins.join(" ")}`,
    "End",
    "",
  ].join("\n");
}
