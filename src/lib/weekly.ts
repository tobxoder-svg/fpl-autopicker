/**
 * The last step of a week's plan: captain and chip, on top of the transfers
 * and lineup from autoplan.ts. Shared by the runner and the Autopilot tab.
 */

import type { Dataset } from "./data";
import type { AutoCriteria, PlanContext, SolveFn, WeekPlan } from "./autoplan";
import type { FixtureOdds } from "./odds";
import { pickCaptain, rankCaptains, type CaptainRow } from "./captain";
import { bestXi, chipGains, decideChips, xpByEvent, type ChipDecision, type ChipState } from "./chips";

export interface WeekExtras {
  captains: CaptainRow[];
  chips: ChipDecision;
  /** True when the captain came from the blended ranking (vs the model's pick as fallback). */
  captainRanked: boolean;
  oddsUsed: boolean;
}

export async function finishWeek(opts: {
  ds: Dataset;
  ctx: PlanContext;
  plan: WeekPlan;
  criteria: AutoCriteria;
  states: ChipState[];
  odds?: ((event: number, teamH: number, teamA: number) => FixtureOdds | null) | null;
  /** Solver for the Free Hit / Wildcard comparison; omit to skip it. */
  solve?: SolveFn;
  /** The chip the autopilot already played on an earlier run this gameweek. */
  keepChip?: string | null;
  /** Free Hit / Wildcard gains worked out already (the tab caches them per plan). */
  gains?: { fhGain: number | null; wcGain: number | null };
}): Promise<{ plan: WeekPlan; extras: WeekExtras }> {
  const { ds, ctx, plan, criteria, states } = opts;
  const event = plan.event;

  // ---- captain
  const captains = rankCaptains({ ds, ids: plan.xi, event, odds: opts.odds, criteria });
  const pick = pickCaptain(captains, { captain: plan.captain, vice: plan.vice });

  // ---- chips: values now and for the rest of each auto chip's window
  const autoStates = states.filter((s) => s.available && (s.name === "3xc" || s.name === "bboost"));
  const lastStop = Math.max(event, ...autoStates.map((s) => s.stopEvent));
  const events = Array.from({ length: lastStop - event + 1 }, (_, i) => event + i);
  const byEvent = xpByEvent(ds, plan.squad, events);
  const tc = new Map<number, number>();
  const bb = new Map<number, number>();
  for (const e of events) {
    const m = byEvent.get(e)!;
    const r = bestXi(plan.squad, ctx.posOf, (id) => m.get(id) ?? 0);
    tc.set(e, r.captainXp);
    bb.set(e, r.benchXp);
  }
  // This gameweek's bench is the planned bench, not the greedy one.
  const now = byEvent.get(event)!;
  bb.set(event, plan.bench.reduce((s, id) => s + (now.get(id) ?? 0), 0));
  // TC "now" stays the model's best starter, like the later weeks it's compared
  // with — the blended captain score only decides who wears the armband.

  const has = (n: string) => states.some((s) => s.name === n && s.available);
  const gains =
    opts.gains ??
    (opts.solve && (has("freehit") || has("wildcard"))
      ? await chipGains({ ctx, plan, solve: opts.solve, freehit: has("freehit"), wildcard: has("wildcard") })
      : { fhGain: null, wcGain: null });

  const chips = decideChips({ event, states, tc, bb, fhGain: gains.fhGain, wcGain: gains.wcGain, criteria, keep: opts.keepChip });

  const out: WeekPlan = {
    ...plan,
    captain: pick.captain,
    vice: pick.vice,
    plan: {
      ...plan.plan,
      chip: chips.play,
      picks: plan.plan.picks.map((p) => ({ ...p, is_captain: p.element === pick.captain, is_vice_captain: p.element === pick.vice })),
    },
  };
  if (pick.captain !== plan.captain) {
    out.notes = [...plan.notes, `Captain: ${ctx.nameOf(pick.captain)} over the model's ${ctx.nameOf(plan.captain)} once odds, FPL's projection and form are in.`];
  }
  return {
    plan: out,
    extras: { captains, chips, captainRanked: pick.fromRanking, oddsUsed: captains.some((c) => c.withOdds != null) },
  };
}
