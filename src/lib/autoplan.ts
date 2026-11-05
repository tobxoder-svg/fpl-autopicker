/**
 * The autopilot's weekly planner — shared by the GitHub job that executes it
 * (scripts/autopick.ts, Node) and the Autopilot tab that previews it
 * (src/routes/Autopilot.tsx, browser). Same code both sides, so the preview
 * can't drift from what actually runs.
 *
 * Planning happens in two phases:
 *
 *   1. transferCurve() — the best squad reachable with at most k transfers, for
 *      k = 0..free transfers. Expensive (one solve per k) but independent of
 *      the criteria, so the tab computes it once per team/data refresh.
 *   2. finishPlan() — applies the criteria: choose how many transfers to make,
 *      then the money tie-break, then the lineup. At most two solves, so the
 *      tab can re-run it on every slider move.
 *
 * The owner's rules (also documented in autopilot/criteria.json):
 *   1. Never go minus on points — transfers never exceed free transfers (no
 *      hits), and each transfer must add at least `minGainPerTransfer` xP.
 *   2. Act only 12 hours or less before the deadline (`windowMaxH` ≤ 12).
 *   3. Best expected points first; among squads within `bankToleranceXp` of
 *      the best, the one that leaves the most money.
 */

import type { Position } from "../model/types";
import type { Candidate, SolveParams } from "../solver/lp";
import { DEFAULT_STRATEGY } from "../model/types";
import { toCandidates, type Projection } from "./projections";
import { fromSolution } from "./squad";

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

export interface AutoCriteria {
  /** xP (5-GW horizon) each transfer must add, or the free transfer rolls. */
  minGainPerTransfer: number;
  /** How much xP the money tie-break may give up to leave more in the bank. */
  bankToleranceXp: number;
  /** The window opens this many hours before the deadline. Hard cap 12. */
  windowMaxH: number;
  /** ...and closes this many hours before it, so it never races the lock. */
  windowMinH: number;
}

export const HARD_WINDOW_CAP_H = 12;

export const CRITERIA_LIMITS: Record<keyof AutoCriteria, { min: number; max: number; step: number }> = {
  minGainPerTransfer: { min: 0.1, max: 5, step: 0.1 },
  bankToleranceXp: { min: 0, max: 10, step: 0.5 },
  windowMaxH: { min: 2, max: HARD_WINDOW_CAP_H, step: 1 },
  windowMinH: { min: 0.5, max: 3, step: 0.5 },
};

export const DEFAULT_CRITERIA: AutoCriteria = {
  minGainPerTransfer: 1,
  bankToleranceXp: 2,
  windowMaxH: 12,
  windowMinH: 1,
};

/** Fills gaps with defaults and clamps — the 12-hour cap can't be configured away. */
export function normaliseCriteria(raw: Partial<Record<keyof AutoCriteria, unknown>> | null | undefined): AutoCriteria {
  const out = { ...DEFAULT_CRITERIA };
  for (const key of Object.keys(CRITERIA_LIMITS) as Array<keyof AutoCriteria>) {
    const v = Number(raw?.[key]);
    if (raw && raw[key] !== undefined && raw[key] !== "" && Number.isFinite(v)) {
      const { min, max } = CRITERIA_LIMITS[key];
      out[key] = Math.min(max, Math.max(min, v));
    }
  }
  if (out.windowMinH >= out.windowMaxH) out.windowMinH = Math.min(DEFAULT_CRITERIA.windowMinH, out.windowMaxH / 2);
  return out;
}

export function sameCriteria(a: AutoCriteria, b: AutoCriteria): boolean {
  return (Object.keys(CRITERIA_LIMITS) as Array<keyof AutoCriteria>).every((k) => Math.abs(a[k] - b[k]) < 1e-9);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface TeamPick {
  element: number;
  position: number;
  isCaptain: boolean;
  isVice: boolean;
  /** What FPL pays you if you sell him (the runner knows it exactly; the tab approximates). */
  sellingPrice: number;
}

export interface TeamState {
  picks: TeamPick[];
  bank: number;
  freeTransfers: number;
}

/** An owned player missing from the projection pool (injured, never played). */
export interface ExtraOwned {
  id: number;
  pos: Position;
  teamId: number;
  name: string;
}

export interface Solved {
  /** Expected-points objective. Undefined meaning in money mode — never read there. */
  objective: number;
  /** Candidate indices. */
  squad: number[];
  xi: number[];
  captain: number | null;
}

export type SolveFn = (candidates: Candidate[], params: SolveParams) => Promise<Solved | null>;

// ---------------------------------------------------------------------------
// Phase 1: the transfer curve
// ---------------------------------------------------------------------------

const POS_ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];
export const MAX_FREE_TRANSFERS = 5;

export interface PlanContext {
  candidates: Candidate[];
  base: SolveParams;
  owned: number[];
  ownedSet: Set<number>;
  selling: Map<number, number>;
  freeTransfers: number;
  bank: number;
  posOf: (id: number) => Position | undefined;
  xpNext: (id: number) => number;
  xpHorizon: (id: number) => number;
  priceNow: (id: number) => number;
  nameOf: (id: number) => string;
}

/** Players it may buy: fully available, nothing flagged. */
export function buyable(p: Projection): boolean {
  return p.player.status === "a" && (p.player.chanceOfPlaying == null || p.player.chanceOfPlaying >= 100);
}

export function buildContext(opts: {
  projections: Projection[];
  team: TeamState;
  extraOwned?: ExtraOwned[];
}): PlanContext {
  const { projections, team } = opts;
  const strategy = { ...DEFAULT_STRATEGY };
  const owned = team.picks.map((p) => p.element);
  const ownedSet = new Set(owned);
  const selling = new Map(team.picks.map((p) => [p.element, p.sellingPrice]));

  const banned = projections.filter((p) => !ownedSet.has(p.player.id) && !buyable(p)).map((p) => p.player.id);
  const candidates: Candidate[] = toCandidates(projections, { ...strategy, forceOut: banned }, owned).map((c) =>
    // Keeping a player is worth his selling price, not today's price.
    ownedSet.has(c.id) ? { ...c, cost: selling.get(c.id) ?? c.cost } : c,
  );
  const extra = new Map((opts.extraOwned ?? []).map((e) => [e.id, e]));
  for (const id of owned) {
    if (candidates.some((c) => c.id === id)) continue;
    const e = extra.get(id);
    if (!e) throw new Error(`squad player ${id} is missing from the player data`);
    candidates.push({ id, pos: e.pos, teamId: e.teamId, cost: selling.get(id) ?? 0, xpNext: 0, xpFuture: 0, sigma: 0, ownership: 0 });
  }

  const proj = new Map(projections.map((p) => [p.player.id, p]));
  const cand = new Map(candidates.map((c) => [c.id, c]));
  const bw = strategy.benchWeights;
  const squadValue = owned.reduce((s, id) => s + (selling.get(id) ?? 0), 0);

  return {
    candidates,
    base: {
      budget: team.bank + squadValue,
      minBank: 0,
      maxPerClub: strategy.maxPerClub,
      benchWeight: (bw[0] + bw[1] + bw[2]) / 3,
      benchGkWeight: strategy.benchGkWeight,
      startShare: 0.85,
      riskLambda: 0,
      ownershipWeight: 0,
      forceIn: [],
      forceOut: [],
    },
    owned,
    ownedSet,
    selling,
    // Rule 1: never more transfers than free ones — no hits.
    freeTransfers: Math.min(MAX_FREE_TRANSFERS, Math.max(0, Math.floor(team.freeTransfers))),
    bank: team.bank,
    posOf: (id) => proj.get(id)?.player.pos ?? cand.get(id)?.pos,
    xpNext: (id) => proj.get(id)?.xpNext ?? 0,
    xpHorizon: (id) => proj.get(id)?.xpHorizon ?? 0,
    priceNow: (id) => proj.get(id)?.player.cost ?? selling.get(id) ?? 0,
    nameOf: (id) => proj.get(id)?.player.webName ?? extra.get(id)?.name ?? `#${id}`,
  };
}

export interface CurvePoint {
  k: number;
  sol: Solved;
}

/** Best squad for at most k transfers, k = 0..min(free transfers, cap). */
export async function transferCurve(ctx: PlanContext, solve: SolveFn, cap = ctx.freeTransfers): Promise<CurvePoint[]> {
  const out: CurvePoint[] = [];
  for (let k = 0; k <= Math.min(cap, ctx.freeTransfers); k++) {
    const sol = await solve(ctx.candidates, { ...ctx.base, keep: { ids: ctx.owned, minKept: 15 - k } });
    if (!sol) {
      if (k === 0) throw new Error("could not solve the current squad's lineup");
      break;
    }
    out.push({ k, sol });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 2: apply the criteria
// ---------------------------------------------------------------------------

export interface PlannedTransfer {
  pos: Position;
  out: number;
  in: number;
  sell: number;
  buy: number;
  xpOut: number;
  xpIn: number;
}

export interface CurveRow {
  k: number;
  objective: number;
  gainVsRoll: number;
  /** What this many transfers must add to pass rule 1. */
  required: number;
  /** gainVsRoll − required: the score the planner maximises. */
  net: number;
  passes: boolean;
}

export interface WeekPlan {
  event: number;
  criteria: AutoCriteria;
  freeTransfers: number;
  transfersUsed: number;
  /** k chosen by rule 1, before the money tie-break (which may use fewer). */
  chosenK: number;
  curve: CurveRow[];
  rollObjective: number;
  bestObjective: number;
  finalObjective: number;
  gain: number;
  bankBefore: number;
  bankAfter: number;
  bankSavedByTieBreak: number;
  xpGivenUpForMoney: number;
  transfers: PlannedTransfer[];
  squad: number[];
  xi: number[];
  bench: number[];
  captain: number;
  vice: number;
  /** FPL's lineup payload shape; also what the runner's safety checks read. */
  plan: {
    event: number;
    generated_at: string;
    source: string;
    chip: null;
    picks: Array<{ element: number; position: number; is_captain: boolean; is_vice_captain: boolean }>;
    xp: Record<string, number>;
  };
  notes: string[];
}

/**
 * Rule 1 applied to the curve: what each transfer count must add, and which
 * count wins. Pure and instant — the tab calls it on every slider move.
 */
export function scoreCurve(curve: CurvePoint[], criteria: AutoCriteria): { rows: CurveRow[]; best: CurvePoint } {
  const roll = curve[0].sol;
  const rows = curve.map((e) => {
    const gainVsRoll = e.sol.objective - roll.objective;
    const required = criteria.minGainPerTransfer * e.k;
    return { k: e.k, objective: e.sol.objective, gainVsRoll, required, net: gainVsRoll - required, passes: e.k === 0 || gainVsRoll - required >= -1e-9 };
  });
  let best = curve[0];
  for (const e of curve) {
    const score = e.sol.objective - criteria.minGainPerTransfer * e.k;
    if (score > best.sol.objective - criteria.minGainPerTransfer * best.k + 1e-6) best = e;
  }
  return { rows, best };
}

export async function finishPlan(opts: {
  ctx: PlanContext;
  curve: CurvePoint[];
  criteria: AutoCriteria;
  solve: SolveFn;
  event: number;
  now?: Date;
}): Promise<WeekPlan> {
  const { ctx, curve, criteria, solve, event } = opts;
  const { candidates, base, owned, ownedSet, selling } = ctx;
  const notes: string[] = [];
  const roll = curve[0].sol;
  // Rule 1: the transfer count whose gain beats its requirement by the most.
  const { rows, best } = scoreCurve(curve, criteria);

  let finalSol = roll;
  let tieBreakSaving = 0;
  let xpGivenUp = 0;
  if (best.k > 0) {
    // Rule 3: stay within the tolerance of the best (and never below rule 1's bar),
    // then spend as little as possible.
    const floor = Math.max(best.sol.objective - criteria.bankToleranceXp, roll.objective + criteria.minGainPerTransfer * best.k) - 1e-4;
    const cheap = await solve(candidates, { ...base, keep: { ids: owned, minKept: 15 - best.k }, money: { minObjective: floor } });
    const squadIdx = (cheap ?? best.sol).squad;
    // Money mode ignores the lineup, so re-solve the chosen squad's best XI and captain.
    const lineup = await solve(candidates, { ...base, keep: { ids: squadIdx.map((i) => candidates[i].id), minKept: 15 } });
    finalSol = lineup ?? best.sol;
    const spend = (s: Solved) => s.squad.reduce((a, i) => a + candidates[i].cost, 0);
    tieBreakSaving = Math.max(0, spend(best.sol) - spend(finalSol));
    xpGivenUp = Math.max(0, best.sol.objective - finalSol.objective);
  } else if (curve.length > 1) {
    const top = curve[curve.length - 1];
    notes.push(
      `Rolling: the best move (+${(top.sol.objective - roll.objective).toFixed(1)} xP with ${top.k}) ` +
        `doesn't clear ${criteria.minGainPerTransfer} xP per transfer.`,
    );
  } else if (ctx.freeTransfers === 0) {
    notes.push("No free transfers — and hits are never taken.");
  }

  const ids = (is: number[]) => is.map((i) => candidates[i].id);
  const squadIds = ids(finalSol.squad);
  const xiIds = ids(finalSol.xi);
  const captainId = finalSol.captain != null ? candidates[finalSol.captain].id : null;
  const transfersUsed = squadIds.filter((id) => !ownedSet.has(id)).length;
  if (transfersUsed > ctx.freeTransfers) {
    throw new Error(`planner produced ${transfersUsed} transfers with ${ctx.freeTransfers} free — refusing`);
  }

  // Lineup: XI in formation order, captain from the solver, vice = next-best starter.
  const { posOf, xpNext } = ctx;
  const state = fromSolution(squadIds, xiIds, captainId, posOf, xpNext);
  const xi = [...state.xi].sort((a, b) => POS_ORDER.indexOf(posOf(a)!) - POS_ORDER.indexOf(posOf(b)!));
  const captain = state.captain ?? [...xi].sort((a, b) => xpNext(b) - xpNext(a))[0];
  const vice = xi.filter((id) => id !== captain).sort((a, b) => xpNext(b) - xpNext(a))[0];

  // Transfers as FPL needs them: like-for-like, dearest out with dearest in.
  const outs = owned.filter((id) => !squadIds.includes(id));
  const ins = squadIds.filter((id) => !ownedSet.has(id));
  const transfers: PlannedTransfer[] = [];
  for (const pos of POS_ORDER) {
    const o = outs.filter((id) => posOf(id) === pos).sort((a, b) => (selling.get(b) ?? 0) - (selling.get(a) ?? 0));
    const i = ins.filter((id) => posOf(id) === pos).sort((a, b) => ctx.priceNow(b) - ctx.priceNow(a));
    o.forEach((id, n) => {
      if (i[n] === undefined) return;
      transfers.push({
        pos,
        out: id,
        in: i[n],
        sell: selling.get(id) ?? 0,
        buy: ctx.priceNow(i[n]),
        xpOut: ctx.xpHorizon(id),
        xpIn: ctx.xpHorizon(i[n]),
      });
    });
  }

  const bankAfter =
    ctx.bank + outs.reduce((s, id) => s + (selling.get(id) ?? 0), 0) - ins.reduce((s, id) => s + ctx.priceNow(id), 0);

  const xp: Record<string, number> = {};
  for (const id of new Set([...owned, ...squadIds])) xp[id] = Number(ctx.xpHorizon(id).toFixed(2));

  return {
    event,
    criteria,
    freeTransfers: ctx.freeTransfers,
    transfersUsed,
    chosenK: best.k,
    curve: rows,
    rollObjective: roll.objective,
    bestObjective: best.sol.objective,
    finalObjective: finalSol.objective,
    gain: finalSol.objective - roll.objective,
    bankBefore: ctx.bank,
    bankAfter,
    bankSavedByTieBreak: tieBreakSaving,
    xpGivenUpForMoney: xpGivenUp,
    transfers,
    squad: squadIds,
    xi,
    bench: state.bench,
    captain,
    vice,
    plan: {
      event,
      generated_at: (opts.now ?? new Date()).toISOString(),
      source: "fpl-autopicker/autoplan",
      chip: null,
      picks: [...xi, ...state.bench].map((element, i) => ({
        element,
        position: i + 1,
        is_captain: element === captain,
        is_vice_captain: element === vice,
      })),
      xp,
    },
    notes,
  };
}

/** Both phases in one go — what the runner uses. */
export async function planWeek(opts: {
  projections: Projection[];
  team: TeamState;
  criteria: AutoCriteria;
  solve: SolveFn;
  event: number;
  maxTransfers?: number;
  extraOwned?: ExtraOwned[];
  now?: Date;
}): Promise<WeekPlan> {
  const ctx = buildContext(opts);
  const curve = await transferCurve(ctx, opts.solve, opts.maxTransfers);
  return finishPlan({ ctx, curve, criteria: opts.criteria, solve: opts.solve, event: opts.event, now: opts.now });
}

// ---------------------------------------------------------------------------
// The window (rule 2)
// ---------------------------------------------------------------------------

export interface WindowState {
  phase: "before" | "open" | "closing" | "passed";
  opensAt: Date;
  closesAt: Date;
  deadline: Date;
  /** When the first hourly run inside the window fires (runs at :07). */
  expectedRun: Date | null;
}

export const RUN_MINUTE = 7;

export function windowState(deadline: Date, criteria: AutoCriteria, now: Date): WindowState {
  const h = 3_600_000;
  const opensAt = new Date(deadline.getTime() - Math.min(HARD_WINDOW_CAP_H, criteria.windowMaxH) * h);
  const closesAt = new Date(deadline.getTime() - criteria.windowMinH * h);
  const nextRunAfter = (t: Date) => {
    const r = new Date(t);
    r.setUTCMinutes(RUN_MINUTE, 0, 0);
    if (r.getTime() <= t.getTime()) r.setUTCHours(r.getUTCHours() + 1);
    return r;
  };
  let phase: WindowState["phase"];
  let expectedRun: Date | null = null;
  if (now >= deadline) phase = "passed";
  else if (now >= closesAt) phase = "closing";
  else if (now >= opensAt) {
    phase = "open";
    expectedRun = nextRunAfter(now);
  } else {
    phase = "before";
    expectedRun = nextRunAfter(new Date(opensAt.getTime() - 1));
  }
  if (expectedRun && expectedRun >= closesAt) expectedRun = null;
  return { phase, opensAt, closesAt, deadline, expectedRun };
}
