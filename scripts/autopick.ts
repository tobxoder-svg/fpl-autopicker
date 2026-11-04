#!/usr/bin/env tsx
/**
 * FPL autopilot — fully automatic weekly transfers, no confirmation.
 *
 * Runs hourly from GitHub Actions. Inside the window before each deadline it
 * works out the week's transfers and lineup from live FPL data, checks every
 * FPL rule, and submits them. The owner's rules are enforced in code:
 *
 *   1. Never go minus on points.
 *      - No hits, ever: transfers are capped at the free transfers available.
 *      - A transfer is only made if it raises expected points by at least
 *        MIN_GAIN_PER_TRANSFER (default 1.0 xP over the 5-GW horizon);
 *        otherwise the free transfer rolls.
 *   2. Execute 12 hours or less before the deadline.
 *      - Acts only when the deadline is between WINDOW_MIN_H (1h) and 12h
 *        away. WINDOW_MAX_H can be lowered but never raised above 12.
 *   3. Optimise money left, still favouring high expected points.
 *      - First the best expected points for the chosen number of transfers;
 *        then, among squads within BANK_TOLERANCE_XP (default 2 xP) of
 *        that, the one that spends least — i.e. leaves the most money.
 *
 * Also: it buys only fully available players, never plays a chip, leaves the
 * week alone if you have already made transfers or activated a chip yourself,
 * executes at most once per gameweek, and re-reads your team afterwards to
 * confirm FPL accepted it.
 *
 * Modes (AUTOPILOT_MODE): "dry-run" (default — plans and reports, sends
 * nothing) or "live" (submits). Exit codes: 0 done or skipped, 1 blocked or a
 * submit failed (CI emails you), 2 login dead, 75 FPL temporarily unavailable.
 *
 * Usage:
 *   npx tsx scripts/autopick.ts                          # what CI runs
 *   npx tsx scripts/autopick.ts --offline dir --now ISO  # tests with saved JSON
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import highsLoader from "highs";
import { buildBundle } from "../shared/build-bundle.mjs";
import { indexBundle } from "../src/lib/data.ts";
import { projectAll, toCandidates, type Projection } from "../src/lib/projections.ts";
import { buildSquadLp, type Candidate, type SolveParams } from "../src/solver/lp.ts";
import { fromSolution } from "../src/lib/squad.ts";
import { DEFAULT_STRATEGY, type Position } from "../src/model/types.ts";
import {
  AuthError,
  TemporaryError,
  diffPlan,
  exchangeRefreshToken,
  getJson,
  nextDeadline,
  normaliseMyTeam,
  notify,
  renderReport,
  toProposal,
  writeSecretJson,
} from "./autopilot.mjs";

const API = "https://fantasy.premierleague.com/api";
const UA = { "User-Agent": "fpl-autopicker/1.0 (personal team automation)" };
const POS_ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];
const MAX_FREE_TRANSFERS = 5;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  strict: false,
  options: {
    offline: { type: "string" },
    now: { type: "string" },
    state: { type: "string", default: ".autopilot/state.json" },
    out: { type: "string", default: ".autopilot/out" },
    force: { type: "boolean", default: false },
  },
});

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

export const CONFIG = {
  mode: process.env.AUTOPILOT_MODE === "live" ? "live" : "dry-run",
  minGainPerTransfer: Math.max(0.01, num(process.env.MIN_GAIN_PER_TRANSFER, 1.0)),
  bankToleranceXp: Math.max(0, num(process.env.BANK_TOLERANCE_XP, 2)),
  windowMaxH: Math.min(12, num(process.env.WINDOW_MAX_H, 12)), // owner's rule: never above 12
  windowMinH: Math.max(0.5, num(process.env.WINDOW_MIN_H, 1)),
  setLineup: process.env.SET_LINEUP !== "false",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamPick {
  element: number;
  position: number;
  isCaptain: boolean;
  isVice: boolean;
  sellingPrice: number;
}
export interface MyTeam {
  picks: TeamPick[];
  bank: number;
  freeTransfers: number;
  unlimited: boolean;
  made: number;
  chips: Array<{ name: string; available: boolean; status?: string }>;
}
interface Solved {
  objective: number;
  squad: number[];
  xi: number[];
  captain: number | null;
}
export interface WeekPlan {
  event: number;
  transfersUsed: number;
  freeTransfers: number;
  objectiveByK: Array<{ k: number; objective: number }>;
  rollObjective: number;
  finalObjective: number;
  gain: number;
  bankBefore: number;
  bankAfter: number;
  bankSavedByTieBreak: number;
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

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

type Highs = Awaited<ReturnType<typeof highsLoader>>;
let highs: Highs | null = null;
async function solver(): Promise<Highs> {
  highs ??= await highsLoader();
  return highs;
}

function picked(columns: Record<string, { Primal?: number }>, prefix: string): number[] {
  const out: number[] = [];
  for (const [name, col] of Object.entries(columns)) {
    if (name[0] === prefix && /^\d+$/.test(name.slice(1)) && (col.Primal ?? 0) > 0.5) {
      out.push(Number(name.slice(1)));
    }
  }
  return out;
}

/** The squad objective (expected points) of a fixed squad/XI/captain. */
function objectiveOf(cands: Candidate[], p: SolveParams, sol: { squad: number[]; xi: number[]; captain: number | null }) {
  const lp = buildSquadLp(cands, p);
  const line = lp.split("\n")[1].replace(/^\s*obj:\s*/, "");
  const coef = new Map<string, number>();
  for (const m of line.matchAll(/([+-])\s*([\d.]+)\s+(\w+)/g)) {
    coef.set(m[3], (m[1] === "-" ? -1 : 1) * Number(m[2]));
  }
  let v = 0;
  for (const i of sol.squad) v += coef.get(`x${i}`) ?? 0;
  for (const i of sol.xi) v += coef.get(`y${i}`) ?? 0;
  if (sol.captain != null) v += coef.get(`c${sol.captain}`) ?? 0;
  return v;
}

async function solve(cands: Candidate[], params: SolveParams): Promise<Solved | null> {
  const h = await solver();
  const lp = buildSquadLp(cands, params);
  const r = h.solve(lp, { time_limit: 30, mip_rel_gap: 0.0001, output_flag: false });
  if (r.Status !== "Optimal") return null;
  const squad = picked(r.Columns, "x");
  if (squad.length !== 15) return null;
  const xi = picked(r.Columns, "y");
  const captain = picked(r.Columns, "c")[0] ?? null;
  // In money mode the solver's objective is spend; report expected points.
  const objective = params.money
    ? objectiveOf(cands, { ...params, money: undefined }, { squad, xi, captain })
    : (r.ObjectiveValue ?? 0);
  return { objective, squad, xi, captain };
}

// ---------------------------------------------------------------------------
// The weekly plan
// ---------------------------------------------------------------------------

/** Players it is allowed to buy: fully available, nothing flagged. */
function buyable(p: Projection): boolean {
  return p.player.status === "a" && (p.player.chanceOfPlaying == null || p.player.chanceOfPlaying >= 100);
}

export async function planWeek(opts: {
  boot: any;
  fixtures: any;
  team: MyTeam;
  event: number;
  maxTransfers?: number; // forced cap (0 = lineup only)
  now?: Date;
}): Promise<WeekPlan> {
  const { boot, fixtures, team, event } = opts;
  const notes: string[] = [];
  const owned = team.picks.map((p) => p.element);
  const ownedSet = new Set(owned);
  const selling = new Map(team.picks.map((p) => [p.element, p.sellingPrice]));

  const bundle = buildBundle(boot, fixtures, {
    includeIds: owned,
    generatedAt: (opts.now ?? new Date()).toISOString(),
  });
  const ds = indexBundle(bundle, "live");
  if (ds.startEvent !== event) {
    notes.push(`Model's next gameweek is ${ds.startEvent}, deadline is GW${event} — using GW${event} fixtures.`);
  }
  const strategy = { ...DEFAULT_STRATEGY };
  const projections = projectAll(ds, strategy);

  const banned = projections.filter((p) => !ownedSet.has(p.player.id) && !buyable(p)).map((p) => p.player.id);
  const candidates = toCandidates(projections, { ...strategy, forceOut: banned }, owned).map((c) =>
    // Keeping a player is worth his selling price, not today's price.
    ownedSet.has(c.id) ? { ...c, cost: selling.get(c.id) ?? c.cost } : c,
  );
  const missing = owned.filter((id) => !candidates.some((c) => c.id === id));
  if (missing.length) throw new Error(`squad players missing from the pool: ${missing.join(", ")}`);

  const bankBefore = team.bank;
  const squadValue = owned.reduce((s, id) => s + (selling.get(id) ?? 0), 0);
  const bw = strategy.benchWeights;
  const base: SolveParams = {
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
  };

  // Rule 1: transfers never exceed free transfers — no hits.
  const ft = Math.min(MAX_FREE_TRANSFERS, Math.max(0, team.freeTransfers));
  const cap = Math.min(ft, opts.maxTransfers ?? ft);

  const byK: Array<{ k: number; sol: Solved }> = [];
  for (let k = 0; k <= cap; k++) {
    const sol = await solve(candidates, { ...base, keep: { ids: owned, minKept: 15 - k } });
    if (!sol) {
      if (k === 0) throw new Error("could not solve the current squad's lineup");
      break;
    }
    byK.push({ k, sol });
  }
  const roll = byK[0].sol;

  // Each transfer must earn at least minGain xP; pick the count that does best net of that.
  let best = byK[0];
  for (const e of byK) {
    const score = e.sol.objective - CONFIG.minGainPerTransfer * e.k;
    const bestScore = best.sol.objective - CONFIG.minGainPerTransfer * best.k;
    if (score > bestScore + 1e-6) best = e;
  }

  let finalSol = roll;
  let tieBreakSaving = 0;
  if (best.k > 0) {
    // Rule 3: keep expected points near the best, then spend as little as possible.
    const floor =
      Math.max(best.sol.objective - CONFIG.bankToleranceXp, roll.objective + CONFIG.minGainPerTransfer * best.k) -
      1e-4;
    const keepK = { ids: owned, minKept: 15 - best.k };
    const cheap = await solve(candidates, { ...base, keep: keepK, money: { minObjective: floor } });
    const chosen = cheap ?? best.sol;
    // Money mode fixes the squad; re-solve for that squad's best XI and captain.
    const lineup = await solve(candidates, {
      ...base,
      keep: { ids: chosen.squad.map((i) => candidates[i].id), minKept: 15 },
    });
    finalSol = lineup ?? chosen;
    const spend = (s: Solved) => s.squad.reduce((a, i) => a + candidates[i].cost, 0);
    tieBreakSaving = spend(best.sol) - spend(finalSol);
  }

  const ids = (is: number[]) => is.map((i) => candidates[i].id);
  const squadIds = ids(finalSol.squad);
  const xiIds = ids(finalSol.xi);
  const captainId = finalSol.captain != null ? candidates[finalSol.captain].id : null;
  const proj = new Map(projections.map((p) => [p.player.id, p]));
  const posOf = (id: number) => proj.get(id)?.player.pos;
  const xpNext = (id: number) => proj.get(id)?.xpNext ?? 0;

  const transfersUsed = squadIds.filter((id) => !ownedSet.has(id)).length;
  if (transfersUsed > ft) throw new Error(`planner produced ${transfersUsed} transfers with ${ft} free — refusing`);

  // Lineup: XI in formation order, captain from the solver, vice = next-best starter.
  const state = fromSolution(squadIds, xiIds, captainId, posOf, xpNext);
  const xi = [...state.xi].sort((a, b) => POS_ORDER.indexOf(posOf(a)!) - POS_ORDER.indexOf(posOf(b)!));
  const captain = state.captain ?? [...xi].sort((a, b) => xpNext(b) - xpNext(a))[0];
  const vice = xi.filter((id) => id !== captain).sort((a, b) => xpNext(b) - xpNext(a))[0];
  const order = [...xi, ...state.bench];

  const costNow = (id: number) => proj.get(id)?.player.cost ?? 0;
  const bankAfter =
    bankBefore +
    owned.filter((id) => !squadIds.includes(id)).reduce((s, id) => s + (selling.get(id) ?? 0), 0) -
    squadIds.filter((id) => !ownedSet.has(id)).reduce((s, id) => s + costNow(id), 0);

  const xpMap: Record<string, number> = {};
  for (const id of new Set([...owned, ...squadIds])) xpMap[id] = Number((proj.get(id)?.xpHorizon ?? 0).toFixed(2));

  if (best.k === 0 && byK.length > 1) {
    const top = byK[byK.length - 1];
    notes.push(
      `Rolled: the best move (+${(top.sol.objective - roll.objective).toFixed(1)} xP with ${top.k}) ` +
        `didn't clear ${CONFIG.minGainPerTransfer} xP per transfer.`,
    );
  }

  return {
    event,
    transfersUsed,
    freeTransfers: ft,
    objectiveByK: byK.map((e) => ({ k: e.k, objective: Number(e.sol.objective.toFixed(2)) })),
    rollObjective: roll.objective,
    finalObjective: finalSol.objective,
    gain: finalSol.objective - roll.objective,
    bankBefore,
    bankAfter,
    bankSavedByTieBreak: tieBreakSaving,
    plan: {
      event,
      generated_at: (opts.now ?? new Date()).toISOString(),
      source: "fpl-autopicker/autopick",
      chip: null,
      picks: order.map((element, i) => ({
        element,
        position: i + 1,
        is_captain: element === captain,
        is_vice_captain: element === vice,
      })),
      xp: xpMap,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// FPL I/O
// ---------------------------------------------------------------------------

async function postJson(path: string, body: unknown, token: string) {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        ...UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Authorization": `Bearer ${token}`,
        Origin: "https://fantasy.premierleague.com",
        Referer: "https://fantasy.premierleague.com/",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new TemporaryError(`POST ${path}: network error ${(err as Error).message}`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new AuthError(`POST ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  if (res.status >= 500) throw new TemporaryError(`POST ${path} -> ${res.status}`);
  if (!res.ok) throw new Error(`FPL rejected POST ${path} (${res.status}): ${text.slice(0, 400)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function activeChip(raw: any): string | null {
  for (const c of raw?.chips ?? []) {
    if ((c.status_for_entry ?? c.status) === "active") return c.name;
  }
  return raw?.active_chip ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function writeMarker(value: string) {
  if (process.env.AUTOPILOT_DONE_FILE) await writeFile(process.env.AUTOPILOT_DONE_FILE, value);
}

async function main(): Promise<number> {
  const now = args.now ? new Date(String(args.now)) : new Date();
  const outDir = String(args.out);
  const statePath = String(args.state);
  const offline = args.offline ? String(args.offline) : null;
  const say = (s: string) => console.log(s);

  // 1. Public data and the deadline window.
  const [boot, fixtures] = offline
    ? await Promise.all([readJson(join(offline, "bootstrap.json")), readJson(join(offline, "fixtures.json"))])
    : await Promise.all([getJson("/bootstrap-static/"), getJson("/fixtures/")]);
  const dl = nextDeadline(boot.events, now.getTime());
  if (!dl) return say("No upcoming deadline — season over."), 0;
  const inWindow = dl.hoursLeft <= CONFIG.windowMaxH && dl.hoursLeft >= CONFIG.windowMinH;
  // --force previews outside the window, but never in live mode: rule 2 is absolute.
  const forced = Boolean(args.force) && CONFIG.mode !== "live";
  if (!inWindow && !forced) {
    say(`GW${dl.event} deadline in ${dl.hoursLeft.toFixed(1)}h — acts only between ${CONFIG.windowMaxH}h and ${CONFIG.windowMinH}h before.`);
    return 0;
  }
  say(`GW${dl.event}: ${dl.hoursLeft.toFixed(1)}h to deadline. Mode: ${CONFIG.mode}.`);

  // 2. Once per gameweek.
  const marker = process.env.AUTOPILOT_DONE_EVENT ?? "";
  if (marker === `${dl.event}:done`) return say(`Already executed for GW${dl.event}.`), 0;
  const transfersAlreadyDone = marker === `${dl.event}:transfers`;

  // 3. Login and the live squad.
  let token = "";
  let entry: number | string | undefined = process.env.FPL_ENTRY_ID;
  let raw: any;
  if (offline) {
    raw = await readJson(join(offline, "my-team.json"));
    entry ??= 0;
  } else {
    const state = await readJson(statePath).catch(() => ({}));
    const auth = await exchangeRefreshToken(state, statePath);
    token = auth.accessToken;
    entry ??= auth.state.entry;
    if (!entry) {
      const me = await getJson("/me/", token);
      entry = me?.player?.entry;
      if (!entry) throw new AuthError("/me/ returned no team for this login");
      await writeSecretJson(statePath, { ...auth.state, entry });
    }
    raw = await getJson(`/my-team/${entry}/`, token);
  }
  const team = normaliseMyTeam(raw) as MyTeam;

  // 4. Hands off when you're managing the week yourself.
  const handsOff = async (why: string) => {
    const msg = `GW${dl.event}: ${why} — autopilot is leaving this week alone.`;
    say(msg);
    await notify(msg, "SKIPPED");
    await writeMarker(`${dl.event}:done`);
    return 0;
  };
  const chip = activeChip(raw);
  // A lineup submit carries chip:null and would cancel an active chip — so don't touch anything.
  if (chip) return handsOff(`you've activated **${chip}**`);
  if (team.unlimited) return handsOff("unlimited transfers (wildcard, free hit or pre-season)");
  if (team.made > 0 && !transfersAlreadyDone) return handsOff(`you've already made ${team.made} transfer(s) yourself`);

  // 5. Plan. If transfers already went through on an earlier run, only redo the lineup.
  const week = await planWeek({ boot, fixtures, team, event: dl.event, maxTransfers: transfersAlreadyDone ? 0 : undefined, now });

  // 6. Every FPL rule and guardrail, independently of the planner.
  const d = diffPlan({
    current: team,
    plan: week.plan,
    elements: boot.elements,
    teams: boot.teams,
    event: dl.event,
    maxHits: 0, // rule 1
    now: now.getTime(),
    maxPlanAgeH: 1,
  });
  if (d.hits > 0) d.verdict = "BLOCKED";
  // One gain figure everywhere: the planner's (lineup- and horizon-aware), not
  // the runner's simpler in-minus-out sum.
  d.xpGain = week.transfersUsed ? week.gain : null;

  const summary = [
    `**Rules:** 0 hits · each transfer ≥ +${CONFIG.minGainPerTransfer} xP · within ${CONFIG.windowMaxH}h of deadline · most money within ${CONFIG.bankToleranceXp} xP of best`,
    `**Plan:** ${week.transfersUsed} of ${week.freeTransfers} free transfer(s) · ${week.gain >= 0 ? "+" : ""}${week.gain.toFixed(1)} xP vs rolling · bank ${(week.bankBefore / 10).toFixed(1)}m → ${(week.bankAfter / 10).toFixed(1)}m` +
      (week.bankSavedByTieBreak > 0 ? ` (tie-break kept £${(week.bankSavedByTieBreak / 10).toFixed(1)}m extra)` : ""),
    ...week.notes.map((n) => `- ${n}`),
  ].join("\n");

  const report = (headline: string) =>
    renderReport(dl, d)
      .replace(/^## .*$/m, `## GW${dl.event} autopilot — ${headline}`)
      .replace("Dry run: nothing was sent to FPL.", CONFIG.mode === "live" ? "" : "Dry run: nothing was sent to FPL.") +
    "\n\n" +
    summary;

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `gw${dl.event}-plan.json`), JSON.stringify(week, null, 1));
  await writeFile(join(outDir, `gw${dl.event}-payloads.json`), JSON.stringify(d.payloads, null, 2));

  if (d.verdict === "BLOCKED") {
    const r = report("BLOCKED — nothing submitted");
    say(r);
    await notify(r, "BLOCKED");
    return 1;
  }

  // 7. Dry run stops here.
  if (CONFIG.mode !== "live") {
    const r = report(`DRY RUN — would ${week.transfersUsed ? `make ${week.transfersUsed} transfer(s)` : "roll the transfer"}`);
    say(r);
    const hash = createHash("sha256").update(JSON.stringify([dl.event, d.payloads])).digest("hex");
    if (process.env.AUTOPILOT_LAST_HASH !== hash) {
      await notify(r, "DRY RUN");
      if (process.env.AUTOPILOT_HASH_FILE) await writeFile(process.env.AUTOPILOT_HASH_FILE, hash);
    }
    return 0;
  }

  // 8. Live: transfers, then lineup, then read back and verify.
  const send = offline ? postOffline : postJson;
  if (d.payloads.transfers && d.transfers.length > 0) {
    await send("/transfers/", { ...d.payloads.transfers, entry: Number(entry) }, token);
    await writeMarker(`${dl.event}:transfers`); // if the lineup fails, the retry won't redo transfers
    say(`Submitted ${d.transfers.length} transfer(s).`);
  }
  if (CONFIG.setLineup) {
    await send(`/my-team/${entry}/`, d.payloads.lineup, token);
    say("Submitted lineup.");
  }

  const after = offline ? postOfflineResult(team, week) : await getJson(`/my-team/${entry}/`, token);
  const got = new Set((after.picks ?? []).map((p: any) => p.element));
  const want = week.plan.picks.map((p) => p.element);
  const wantCaptain = week.plan.picks.find((p) => p.is_captain)?.element;
  const gotCaptain = (after.picks ?? []).find((p: any) => p.is_captain)?.element;
  const squadOk = want.every((id) => got.has(id)) && got.size === 15;
  const captainOk = !CONFIG.setLineup || gotCaptain === wantCaptain;
  if (!squadOk || !captainOk) {
    const r = report("SUBMITTED BUT NOT CONFIRMED") +
      `\n\n**Check your team in the FPL app.** Squad matches: ${squadOk} · captain matches: ${captainOk}.`;
    say(r);
    await notify(r, "CHECK TEAM");
    return 1;
  }

  await writeMarker(`${dl.event}:done`);
  const r = report(week.transfersUsed ? `EXECUTED ${week.transfersUsed} transfer(s)` : "ROLLED — lineup set");
  say(r);
  await notify(r, "EXECUTED");
  if (process.env.AUTOPILOT_PUBLISH_PATH) {
    await writeFile(process.env.AUTOPILOT_PUBLISH_PATH, JSON.stringify({ ...toProposal(dl, d), verdict: "EXECUTED" }, null, 1) + "\n");
  }
  return 0;
}

// Offline (test) stand-ins for the two POSTs and the read-back.
const offlinePosts: Array<{ path: string; body: unknown }> = [];
async function postOffline(path: string, body: unknown) {
  offlinePosts.push({ path, body });
  if (process.env.OFFLINE_POSTS_FILE) await writeFile(process.env.OFFLINE_POSTS_FILE, JSON.stringify(offlinePosts, null, 1));
  return {};
}
function postOfflineResult(_team: MyTeam, week: WeekPlan) {
  return { picks: week.plan.picks };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/autopick.ts");
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof AuthError) {
        console.error(`AUTH: ${err.message}`);
        return notify(`Autopilot can't log in to FPL: ${err.message}. Re-copy the refresh token.`, "LOGIN").finally(() => process.exit(2));
      }
      if (err instanceof TemporaryError) {
        console.error(`TEMPORARY: ${err.message} — retrying next hour`);
        process.exit(75);
      }
      console.error(err);
      return notify(`Autopilot error: ${String(err?.message ?? err)}`, "ERROR").finally(() => process.exit(1));
    },
  );
}
