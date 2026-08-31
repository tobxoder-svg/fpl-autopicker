/**
 * The editable squad — what the user is allowed to rearrange after the solver
 * has handed back an answer, and what stays fixed.
 *
 * The 15 players are fixed until the next solve. Which eleven start, the bench
 * order and the captain are the user's to move, subject to the same formation
 * rules the solver obeyed. Every rule is enforced here rather than in the drag
 * handler, so an illegal arrangement cannot be produced by any interaction.
 */

import type { Position } from "../model/types";

export const XI_MIN: Record<Position, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
export const XI_MAX: Record<Position, number> = { GK: 1, DEF: 5, MID: 5, FWD: 3 };
export const XI_SIZE = 11;

export interface SquadState {
  /** All 15, as returned by the solver. */
  squad: number[];
  /** The eleven who start. */
  xi: number[];
  /** Four, goalkeeper first, then the outfield substitution order. */
  bench: number[];
  captain: number | null;
}

type PosOf = (id: number) => Position | undefined;

export function countByPosition(ids: number[], posOf: PosOf): Record<Position, number> {
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const id of ids) {
    const pos = posOf(id);
    if (pos) counts[pos] += 1;
  }
  return counts;
}

export function isLegalXi(xi: number[], posOf: PosOf): boolean {
  if (xi.length !== XI_SIZE) return false;
  const c = countByPosition(xi, posOf);
  return (Object.keys(XI_MIN) as Position[]).every((p) => c[p] >= XI_MIN[p] && c[p] <= XI_MAX[p]);
}

/** e.g. "3-5-2" — goalkeeper implied, as everyone writes it. */
export function formationOf(xi: number[], posOf: PosOf): string {
  const c = countByPosition(xi, posOf);
  return `${c.DEF}-${c.MID}-${c.FWD}`;
}

/**
 * Builds the editable state from a solver result. The bench is ordered by
 * expected points, since the substitute most likely to be needed should be the
 * one most likely to score — the goalkeeper is pinned to the first slot because
 * FPL substitutes keepers only for keepers.
 */
export function fromSolution(
  squad: number[],
  xi: number[],
  captain: number | null,
  posOf: PosOf,
  xpOf: (id: number) => number,
): SquadState {
  const benchIds = squad.filter((id) => !xi.includes(id));
  const gk = benchIds.filter((id) => posOf(id) === "GK");
  const outfield = benchIds
    .filter((id) => posOf(id) !== "GK")
    .sort((a, b) => xpOf(b) - xpOf(a));
  return { squad, xi: [...xi], bench: [...gk, ...outfield], captain };
}

export interface SwapResult {
  ok: boolean;
  reason?: string;
  next?: SquadState;
}

/**
 * Swaps two players between any two slots. Same-area swaps reorder; a starter
 * and a substitute trade places only when the resulting eleven is still legal.
 */
export function swap(state: SquadState, aId: number, bId: number, posOf: PosOf): SwapResult {
  if (aId === bId) return { ok: false, reason: "same player" };

  const aInXi = state.xi.includes(aId);
  const bInXi = state.xi.includes(bId);
  const posA = posOf(aId);
  const posB = posOf(bId);
  if (!posA || !posB) return { ok: false, reason: "unknown player" };

  // Both starting: nothing to enforce, the eleven is unchanged.
  if (aInXi && bInXi) {
    const xi = [...state.xi];
    const i = xi.indexOf(aId);
    const j = xi.indexOf(bId);
    [xi[i], xi[j]] = [xi[j], xi[i]];
    return { ok: true, next: { ...state, xi } };
  }

  // Both benched: reorder the substitution priority.
  if (!aInXi && !bInXi) {
    if ((posA === "GK") !== (posB === "GK")) {
      return { ok: false, reason: "the reserve keeper has its own slot" };
    }
    const bench = [...state.bench];
    const i = bench.indexOf(aId);
    const j = bench.indexOf(bId);
    [bench[i], bench[j]] = [bench[j], bench[i]];
    return { ok: true, next: { ...state, bench } };
  }

  const starter = aInXi ? aId : bId;
  const sub = aInXi ? bId : aId;
  const starterPos = aInXi ? posA : posB;
  const subPos = aInXi ? posB : posA;

  if ((starterPos === "GK") !== (subPos === "GK")) {
    return { ok: false, reason: "only a keeper can replace the keeper" };
  }

  const nextXi = state.xi.map((id) => (id === starter ? sub : id));
  if (!isLegalXi(nextXi, posOf)) {
    return { ok: false, reason: `${starterPos} → ${subPos} would break the formation` };
  }

  const nextBench = state.bench.map((id) => (id === sub ? starter : id));
  const captain = state.captain === starter ? sub : state.captain;
  return { ok: true, next: { squad: state.squad, xi: nextXi, bench: nextBench, captain } };
}

/** Whether dropping `dragId` onto `targetId` would be accepted. */
export function canSwap(state: SquadState, dragId: number, targetId: number, posOf: PosOf): boolean {
  return swap(state, dragId, targetId, posOf).ok;
}

export function setCaptain(state: SquadState, id: number): SquadState {
  return state.xi.includes(id) ? { ...state, captain: id } : state;
}

/** True once the user has moved away from what the solver returned. */
export function hasDiverged(state: SquadState, original: SquadState): boolean {
  if (state.captain !== original.captain) return true;
  if (state.xi.length !== original.xi.length) return true;
  const originalXi = new Set(original.xi);
  if (state.xi.some((id) => !originalXi.has(id))) return true;
  return state.bench.some((id, i) => original.bench[i] !== id);
}
