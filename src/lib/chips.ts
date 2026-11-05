/**
 * When to play a chip — shared by the runner and the Autopilot tab.
 *
 * The owner's split: Triple Captain and Bench Boost are played automatically;
 * Wildcard and Free Hit are only ever suggested (alert + tab), and the owner
 * plays them in the FPL app.
 *
 * 2026/27 rules this follows: one set of four chips for GW1–19 and another for
 * GW20–38 (the windows come from the API when it lists them); the first set
 * expires at the GW19 deadline, so an unused chip is simply lost; one chip per
 * gameweek; no Free Hit in GW1 or in the gameweek straight after a Free Hit.
 *
 * Timing, per auto chip, every gameweek:
 *   value now     TC: the best starter's xP (the extra captain helping).
 *                 BB: the four bench players' xP.
 *   value later   the same for each remaining gameweek in the chip's window,
 *                 with today's squad — doubles and blanks fall out of the
 *                 fixture list, so a double gameweek shows up as a spike.
 *   play now if   it clears the minimum (tcMinXp / bbMinXp) and no later week
 *                 is better by more than chipWaitMarginPct — or it's the last
 *                 gameweek of the window ("use it or lose it"), or there are as
 *                 many unused chips as gameweeks left in the window.
 * Re-evaluated every week, so a chip held for a better week is played when that
 * week arrives, or when the window runs out.
 */

import type { Position } from "../model/types";
import type { Dataset } from "./data";
import type { AutoCriteria, PlanContext, SolveFn, WeekPlan } from "./autoplan";
import { expectedPoints } from "../model/xp";

export type ChipName = "wildcard" | "freehit" | "bboost" | "3xc";
export const CHIP_ORDER: ChipName[] = ["3xc", "bboost", "freehit", "wildcard"];
export const CHIP_LABEL: Record<ChipName, string> = {
  "3xc": "Triple Captain",
  bboost: "Bench Boost",
  freehit: "Free Hit",
  wildcard: "Wildcard",
};
const isChip = (s: string): s is ChipName => (CHIP_ORDER as string[]).includes(s);

// ---------------------------------------------------------------------------
// Windows and availability
// ---------------------------------------------------------------------------

export interface ChipWindow {
  name: string;
  startEvent: number;
  stopEvent: number;
}

/** The API's windows, or the 2026/27 halves when it doesn't list them. */
export function chipWindows(fromApi?: ChipWindow[] | null): ChipWindow[] {
  if (fromApi?.length) return fromApi;
  return CHIP_ORDER.flatMap((name) => [
    { name, startEvent: 1, stopEvent: 19 },
    { name, startEvent: 20, stopEvent: 38 },
  ]);
}

export interface ChipState {
  name: ChipName;
  available: boolean;
  /** Played for this gameweek already (by you, or by the autopilot on an earlier run). */
  active: boolean;
  startEvent: number;
  stopEvent: number;
  why: string;
}

function windowFor(windows: ChipWindow[], name: string, event: number) {
  return windows.find((w) => w.name === name && event >= w.startEvent && event <= w.stopEvent) ?? null;
}

/**
 * From public history (the tab): which chips were played in which gameweek.
 * FPL's history uses the same chip names.
 */
export function statesFromHistory(windows: ChipWindow[], used: Array<{ name: string; event: number }>, event: number): ChipState[] {
  const activeNow = used.find((u) => u.event === event);
  return CHIP_ORDER.map((name) => {
    const w = windowFor(windows, name, event);
    if (!w) return { name, available: false, active: false, startEvent: event, stopEvent: event, why: "no window this gameweek" };
    const base = { name, startEvent: w.startEvent, stopEvent: w.stopEvent };
    const u = used.find((x) => x.name === name && x.event >= w.startEvent && x.event <= w.stopEvent);
    if (u) return { ...base, available: false, active: u.event === event, why: u.event === event ? "played this gameweek" : `used GW${u.event}` };
    if (activeNow) return { ...base, available: false, active: false, why: "another chip is on this gameweek" };
    const ruled = freeHitRule(name, event, used);
    if (ruled) return { ...base, available: false, active: false, why: ruled };
    return { ...base, available: true, active: false, why: `GW${w.startEvent}–${w.stopEvent}` };
  });
}

function freeHitRule(name: string, event: number, used: Array<{ name: string; event: number }>): string | null {
  if (name !== "freehit") return null;
  if (event === 1) return "not allowed in GW1";
  if (used.some((u) => u.name === "freehit" && u.event === event - 1)) return "not the week after a Free Hit";
  return null;
}

/** From the logged-in my-team endpoint (the runner): FPL says what's available. */
export function statesFromMyTeam(
  chips: Array<{ name: string; available: boolean; active?: boolean; startEvent?: number | null; stopEvent?: number | null }>,
  windows: ChipWindow[],
  event: number,
): ChipState[] {
  return CHIP_ORDER.map((name) => {
    const entries = chips.filter((c) => c.name === name);
    const inWindow = entries.find((c) => c.startEvent != null && c.stopEvent != null && event >= c.startEvent && event <= c.stopEvent);
    const c = inWindow ?? entries.find((x) => x.available || x.active) ?? entries[0];
    const w = windowFor(windows, name, event);
    const startEvent = c?.startEvent ?? w?.startEvent ?? event;
    const stopEvent = c?.stopEvent ?? w?.stopEvent ?? event;
    if (!c) return { name, available: false, active: false, startEvent, stopEvent, why: "not offered on your team" };
    if (c.active) return { name, available: false, active: true, startEvent, stopEvent, why: "played this gameweek" };
    return { name, available: c.available, active: false, startEvent, stopEvent, why: c.available ? `GW${startEvent}–${stopEvent}` : "used or not available" };
  });
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** xP per player per gameweek, from the model, for the given squad. */
export function xpByEvent(ds: Dataset, ids: number[], events: number[]): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>(events.map((e) => [e, new Map()]));
  const wanted = new Set(events);
  for (const id of ids) {
    const p = ds.playersById.get(id);
    const team = p ? ds.teamsById.get(p.teamId) : undefined;
    for (const e of events) out.get(e)!.set(id, 0);
    if (!p || !team) continue;
    for (const fx of ds.fixturesByTeam.get(p.teamId) ?? []) {
      if (!wanted.has(fx.event)) continue;
      const opp = ds.teamsById.get(fx.opponentId);
      if (!opp) continue;
      const m = out.get(fx.event)!;
      m.set(id, (m.get(id) ?? 0) + expectedPoints(p, team, opp, fx.home).xp);
    }
  }
  return out;
}

/**
 * Best legal XI for one gameweek (1 GK; at least 3 DEF, 2 MID, 1 FWD), greedy —
 * exact for a 2-5-5-3 squad, where no maximum can bind.
 */
export function bestXi(ids: number[], posOf: (id: number) => Position | undefined, xp: (id: number) => number) {
  const by = (pos: Position) => ids.filter((id) => posOf(id) === pos).sort((a, b) => xp(b) - xp(a));
  const gk = by("GK");
  const need: Array<[Position, number]> = [["DEF", 3], ["MID", 2], ["FWD", 1]];
  const xi = gk.slice(0, 1);
  const rest: number[] = [];
  for (const [pos, n] of need) {
    const list = by(pos);
    xi.push(...list.slice(0, n));
    rest.push(...list.slice(n));
  }
  rest.sort((a, b) => xp(b) - xp(a));
  xi.push(...rest.slice(0, 11 - xi.length));
  const inXi = new Set(xi);
  const bench = ids.filter((id) => !inXi.has(id));
  return {
    xi,
    bench,
    captainXp: Math.max(0, ...xi.map(xp)),
    benchXp: bench.reduce((s, id) => s + xp(id), 0),
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface ChipRow {
  name: ChipName;
  label: string;
  /** Played by the autopilot (true) or suggested to you (false). */
  auto: boolean;
  state: ChipState;
  /** TC: captain xP · BB: bench xP · FH/WC: xP gained. Null when not worked out. */
  now: number | null;
  threshold: number;
  /** The best later gameweek in the window, for TC and BB. */
  best: { event: number; value: number } | null;
  gwsLeft: number;
  decision: "play" | "suggest" | "hold" | "off" | "unavailable" | "active";
  why: string;
}

export interface ChipDecision {
  /** The chip the autopilot plays this gameweek. */
  play: "3xc" | "bboost" | null;
  /** Chips worth playing this gameweek that only you can play. */
  suggest: Array<"wildcard" | "freehit" | "3xc" | "bboost">;
  forced: boolean;
  rows: ChipRow[];
}

type ChipCriteria = Pick<
  AutoCriteria,
  "autoTripleCaptain" | "autoBenchBoost" | "tcMinXp" | "bbMinXp" | "chipWaitMarginPct" | "fhMinGain" | "wcMinGain"
>;

export function decideChips(opts: {
  event: number;
  states: ChipState[];
  /** Per gameweek: captain xP (TC) and bench xP (BB) with today's squad. */
  tc: Map<number, number>;
  bb: Map<number, number>;
  fhGain: number | null;
  wcGain: number | null;
  criteria: ChipCriteria;
  /** A chip the autopilot already played on an earlier run this gameweek. */
  keep?: string | null;
}): ChipDecision {
  const { event, states, criteria } = opts;
  const margin = 1 + criteria.chipWaitMarginPct / 100;
  const avail = states.filter((s) => s.available);

  // Use-it-or-lose-it: as many unused chips as gameweeks left in their window.
  let forced = false;
  let forcedWhy = "";
  for (const stop of new Set(avail.map((s) => s.stopEvent))) {
    const unused = avail.filter((s) => s.stopEvent === stop).length;
    const left = stop - event + 1;
    if (unused >= left) {
      forced = true;
      forcedWhy = `use it or lose it: ${unused} chip${unused > 1 ? "s" : ""} left and ${left} gameweek${left > 1 ? "s" : ""} before they expire (GW${stop})`;
    }
  }

  const rows: ChipRow[] = states.map((state) => {
    const auto = state.name === "3xc" ? criteria.autoTripleCaptain : state.name === "bboost" ? criteria.autoBenchBoost : false;
    const threshold =
      state.name === "3xc" ? criteria.tcMinXp : state.name === "bboost" ? criteria.bbMinXp : state.name === "freehit" ? criteria.fhMinGain : criteria.wcMinGain;
    const gwsLeft = Math.max(0, state.stopEvent - event + 1);
    const row: ChipRow = { name: state.name, label: CHIP_LABEL[state.name], auto, state, now: null, threshold, best: null, gwsLeft, decision: "unavailable", why: state.why };
    if (state.active) return { ...row, decision: "active", why: "played this gameweek" };
    if (!state.available) return row;

    if (state.name === "3xc" || state.name === "bboost") {
      const series = state.name === "3xc" ? opts.tc : opts.bb;
      const now = series.get(event) ?? 0;
      let best: ChipRow["best"] = null;
      for (let e = event + 1; e <= state.stopEvent; e++) {
        const v = series.get(e);
        if (v != null && (!best || v > best.value)) best = { event: e, value: v };
      }
      const what = state.name === "3xc" ? "captain" : "bench";
      const last = event === state.stopEvent;
      const later = best && best.value > now * margin;
      const wants = last || (now >= threshold && !later);
      let why: string;
      if (last) why = `last gameweek before it expires — ${what} ${now.toFixed(1)} xP`;
      else if (now < threshold) why = `${what} ${now.toFixed(1)} xP, below the ${threshold} bar`;
      else if (later) why = `GW${best!.event} looks better (${best!.value.toFixed(1)} vs ${now.toFixed(1)} xP)`;
      else why = `${what} ${now.toFixed(1)} xP — clears ${threshold}, and no later week is ${criteria.chipWaitMarginPct}% better`;
      return { ...row, now, best, decision: wants ? (auto ? "play" : "suggest") : "hold", why };
    }

    const gain = state.name === "freehit" ? opts.fhGain : opts.wcGain;
    if (gain == null) return { ...row, decision: "hold", why: "not worked out" };
    const scope = state.name === "freehit" ? "this gameweek" : "over 5 gameweeks";
    const wants = gain >= threshold;
    return {
      ...row,
      now: gain,
      decision: wants ? "suggest" : "hold",
      why: wants ? `+${gain.toFixed(1)} xP ${scope} — clears ${threshold}` : `+${gain.toFixed(1)} xP ${scope}, below the ${threshold} bar`,
    };
  });

  // One chip per gameweek.
  const ratio = (r: ChipRow) => (r.now ?? 0) / Math.max(1e-9, r.threshold);
  let play: ChipDecision["play"] = null;
  if (opts.keep === "3xc" || opts.keep === "bboost") {
    play = opts.keep;
  } else {
    const keen = rows.filter((r) => r.auto && r.decision === "play").sort((a, b) => ratio(b) - ratio(a));
    if (keen.length) play = keen[0].name as "3xc" | "bboost";
    else if (forced) {
      const any = rows.filter((r) => r.auto && r.state.available && (r.name === "3xc" || r.name === "bboost")).sort((a, b) => ratio(b) - ratio(a));
      if (any.length) {
        play = any[0].name as "3xc" | "bboost";
        any[0].why = `${forcedWhy} — ${any[0].why}`;
      }
    }
  }
  for (const r of rows) {
    if (r.name === play) r.decision = "play";
    else if (r.decision === "play") {
      r.decision = "hold";
      r.why =
        r.gwsLeft === 1
          ? `expires unused — one chip per gameweek and ${CHIP_LABEL[play!]} is worth more`
          : `one chip per gameweek — ${CHIP_LABEL[play!]} goes first`;
    }
  }

  // Suggestions to you: the best one only (one chip per gameweek). Made even when
  // the autopilot plans its own chip: if you play the suggestion first, the
  // autopilot sees an active chip and leaves the week to you.
  const wanting = rows.filter((r) => r.decision === "suggest").sort((a, b) => ratio(b) - ratio(a));
  if (forced && !play && !wanting.length) {
    const left = rows.filter((r) => r.state.available).sort((a, b) => (b.now ?? 0) - (a.now ?? 0));
    if (left[0]) {
      left[0].decision = "suggest";
      left[0].why = `${forcedWhy} — ${left[0].why}`;
      wanting.push(left[0]);
    }
  }
  const suggest: ChipDecision["suggest"] = [];
  wanting.forEach((r, i) => {
    if (i === 0) suggest.push(r.name);
    else {
      r.decision = "hold";
      r.why = `one chip per gameweek — ${CHIP_LABEL[wanting[0].name]} looks better · ${r.why}`;
    }
  });

  return { play, suggest, forced, rows };
}

// ---------------------------------------------------------------------------
// Free Hit and Wildcard: what they'd add, by solving
// ---------------------------------------------------------------------------

/**
 * Free Hit: the best squad for this gameweek alone, any players, same budget,
 * vs your planned squad for this gameweek. Wildcard: the best squad over the
 * planning horizon with unlimited transfers vs your best free-transfer plan.
 */
export async function chipGains(opts: {
  ctx: PlanContext;
  plan: WeekPlan;
  solve: SolveFn;
  freehit: boolean;
  wildcard: boolean;
}): Promise<{ fhGain: number | null; wcGain: number | null }> {
  const { ctx, plan, solve } = opts;
  let fhGain: number | null = null;
  let wcGain: number | null = null;
  if (opts.freehit) {
    const oneWeek = { ...ctx.base, startShare: 0 };
    const fh = await solve(ctx.candidates, oneWeek);
    const mine = await solve(ctx.candidates, { ...oneWeek, keep: { ids: plan.squad, minKept: 15 } });
    if (fh && mine) fhGain = Math.max(0, fh.objective - mine.objective);
  }
  if (opts.wildcard) {
    const wc = await solve(ctx.candidates, { ...ctx.base });
    if (wc) wcGain = Math.max(0, wc.objective - plan.bestObjective);
  }
  return { fhGain, wcGain };
}

export { isChip };
