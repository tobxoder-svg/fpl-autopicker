#!/usr/bin/env tsx
/**
 * FPL autopilot — fully automatic weekly transfers, no confirmation.
 *
 * Runs hourly from GitHub Actions. Inside the window before each deadline it
 * works out the week's transfers and lineup from live FPL data, checks every
 * FPL rule, and submits them. The owner's rules are enforced in code:
 *
 *   1. Never go minus on points: no hits ever (transfers capped at the free
 *      transfers), and each transfer must add at least minGainPerTransfer xP.
 *   2. Execute 12 hours or less before the deadline (windowMaxH, hard cap 12).
 *   3. Best expected points first; among squads within bankToleranceXp of the
 *      best, the one that leaves the most money.
 *
 * The criteria live in autopilot/criteria.json — the same file the Autopilot
 * tab reads, so its preview matches what runs here. The planning itself is
 * src/lib/autoplan.ts, shared with the tab.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import highsLoader from "highs";
import { buildBundle } from "../shared/build-bundle.mjs";
import { indexBundle } from "../src/lib/data.ts";
import { projectAll } from "../src/lib/projections.ts";
import { buildSquadLp, type Candidate, type SolveParams } from "../src/solver/lp.ts";
import { DEFAULT_STRATEGY } from "../src/model/types.ts";
import { normaliseCriteria, planWeek, type Solved, type TeamPick, type WeekPlan } from "../src/lib/autoplan.ts";
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

function loadCriteria() {
  try {
    const raw = JSON.parse(readFileSync(new URL("../autopilot/criteria.json", import.meta.url), "utf8"));
    return normaliseCriteria(raw);
  } catch (err) {
    console.warn(`autopilot/criteria.json unreadable (${(err as Error).message}) — using defaults`);
    return normaliseCriteria(null);
  }
}

export const CRITERIA = loadCriteria();

export const CONFIG = {
  mode: process.env.AUTOPILOT_MODE === "live" ? "live" : "dry-run",
  setLineup: process.env.SET_LINEUP !== "false",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MyTeam {
  picks: TeamPick[];
  bank: number;
  freeTransfers: number;
  unlimited: boolean;
  made: number;
  chips: Array<{ name: string; available: boolean; status?: string }>;
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

async function solve(cands: Candidate[], params: SolveParams): Promise<Solved | null> {
  const h = await solver();
  const r = h.solve(buildSquadLp(cands, params), { time_limit: 30, mip_rel_gap: 0.0001, output_flag: false });
  if (r.Status !== "Optimal") return null;
  const squad = picked(r.Columns, "x");
  if (squad.length !== 15) return null;
  return { objective: r.ObjectiveValue ?? 0, squad, xi: picked(r.Columns, "y"), captain: picked(r.Columns, "c")[0] ?? null };
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

/** Opt-in: the outcome for the app's Autopilot tab (live runs only). */
async function publish(dl: any, d: any, verdict: string) {
  if (CONFIG.mode !== "live" || !process.env.AUTOPILOT_PUBLISH_PATH) return;
  await writeFile(process.env.AUTOPILOT_PUBLISH_PATH, JSON.stringify({ ...toProposal(dl, d), verdict }, null, 1) + "\n");
}

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
  const inWindow = dl.hoursLeft <= CRITERIA.windowMaxH && dl.hoursLeft >= CRITERIA.windowMinH;
  // --force previews outside the window, but never in live mode: rule 2 is absolute.
  const forced = Boolean(args.force) && CONFIG.mode !== "live";
  if (!inWindow && !forced) {
    say(`GW${dl.event} deadline in ${dl.hoursLeft.toFixed(1)}h — acts only between ${CRITERIA.windowMaxH}h and ${CRITERIA.windowMinH}h before.`);
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
  const bundle = buildBundle(boot, fixtures, { includeIds: team.picks.map((p) => p.element), generatedAt: now.toISOString() });
  const ds = indexBundle(bundle, "live");
  const week = await planWeek({
    projections: projectAll(ds, { ...DEFAULT_STRATEGY }),
    team,
    criteria: CRITERIA,
    solve,
    event: dl.event,
    maxTransfers: transfersAlreadyDone ? 0 : undefined,
    now,
  });
  if (ds.startEvent !== dl.event) week.notes.push(`Model's next gameweek is ${ds.startEvent}; deadline is GW${dl.event}.`);

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
    `**Rules:** 0 hits · each transfer ≥ +${CRITERIA.minGainPerTransfer} xP · within ${CRITERIA.windowMaxH}h of deadline · most money within ${CRITERIA.bankToleranceXp} xP of best`,
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
    await publish(dl, d, "BLOCKED");
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
    await publish(dl, d, "CHECK TEAM");
    return 1;
  }

  await writeMarker(`${dl.event}:done`);
  const r = report(week.transfersUsed ? `EXECUTED ${week.transfersUsed} transfer(s)` : "ROLLED — lineup set");
  say(r);
  await notify(r, "EXECUTED");
  await publish(dl, d, "EXECUTED");
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
