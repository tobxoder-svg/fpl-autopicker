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
 * Captain: ranked on our model blended with bookmaker odds (ODDS_API_KEY),
 * FPL's own projection and form — src/lib/captain.ts.
 * Chips: plays Triple Captain and Bench Boost itself when the week is right;
 * Wildcard and Free Hit are only suggested (you play them) — src/lib/chips.ts.
 * A heads-up with the plan, captain and chips goes out `alertLeadH` hours
 * before the deadline, so there's time to play a suggested chip yourself.
 *
 * Also: it buys only fully available players, leaves the week alone if you
 * have already made transfers or activated a chip yourself, executes at most
 * once per gameweek, and re-reads your team afterwards to confirm FPL
 * accepted it (squad, captain and chip).
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
import {
  buildContext,
  finishPlan,
  normaliseCriteria,
  transferCurve,
  type Solved,
  type TeamPick,
  type WeekPlan,
} from "../src/lib/autoplan.ts";
import { finishWeek, type WeekExtras } from "../src/lib/weekly.ts";
import { CHIP_LABEL, chipWindows, statesFromMyTeam } from "../src/lib/chips.ts";
import { fetchOddsEvents, oddsIndex, parseOdds, type OddsSnapshot } from "../src/lib/odds.ts";
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
  chips: Array<{ name: string; available: boolean; active: boolean; startEvent: number | null; stopEvent: number | null }>;
}

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

const ODDS_FILE = new URL("../public/data/odds.json", import.meta.url);
const ODDS_FRESH_H = 6;

/**
 * Bookmaker odds for the captain pick. The data-refresh job's snapshot if it's
 * recent (saves API credits), else a live fetch when ODDS_API_KEY is set, else
 * an older snapshot, else none — the captain is then picked without odds.
 */
async function loadOdds(bundle: any, now: Date, offline: string | null): Promise<OddsSnapshot | null> {
  const age = (s: OddsSnapshot) => (now.getTime() - Date.parse(s.fetchedAt)) / 3_600_000;
  if (offline) {
    const rawEvents = await readJson(join(offline, "odds.json")).catch(() => null);
    return rawEvents ? parseOdds(rawEvents, bundle, now.toISOString()) : null;
  }
  const snap: OddsSnapshot | null = await readFile(ODDS_FILE, "utf8").then(JSON.parse).catch(() => null);
  if (snap && age(snap) <= ODDS_FRESH_H) return snap;
  const key = process.env.ODDS_API_KEY;
  if (key) {
    try {
      return parseOdds(await fetchOddsEvents(key), bundle, now.toISOString());
    } catch (err) {
      console.warn(`odds: ${(err as Error).message}`);
    }
  }
  return snap && age(snap) <= 48 ? snap : null;
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
async function publish(dl: any, d: any, verdict: string, extra: object) {
  if (CONFIG.mode !== "live" || !process.env.AUTOPILOT_PUBLISH_PATH) return;
  await writeFile(process.env.AUTOPILOT_PUBLISH_PATH, JSON.stringify({ ...toProposal(dl, d, extra), verdict }, null, 1) + "\n");
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
  const marker = process.env.AUTOPILOT_DONE_EVENT ?? "";
  const mine = (m: string) => m.startsWith(`${dl.event}:`);
  // The heads-up: once, between alertLeadH and the window, before anything else happens.
  const headsUp = !inWindow && !forced && dl.hoursLeft <= CRITERIA.alertLeadH && dl.hoursLeft > CRITERIA.windowMaxH && !mine(marker);
  if (!inWindow && !forced && !headsUp) {
    say(`GW${dl.event} deadline in ${dl.hoursLeft.toFixed(1)}h — acts only between ${CRITERIA.windowMaxH}h and ${CRITERIA.windowMinH}h before` +
      (mine(marker) ? "." : ` (heads-up from ${CRITERIA.alertLeadH}h).`));
    return 0;
  }
  say(`GW${dl.event}: ${dl.hoursLeft.toFixed(1)}h to deadline. Mode: ${CONFIG.mode}.${headsUp ? " Heads-up only." : ""}`);

  // 2. Once per gameweek.
  if (marker === `${dl.event}:done`) return say(`Already executed for GW${dl.event}.`), 0;
  // `N:chip-bboost` = transfers went through and the lineup with that chip was sent
  // on an earlier run, but not confirmed. Its chip shows as active: that's ours.
  const botChip = marker.startsWith(`${dl.event}:chip-`) ? marker.slice(`${dl.event}:chip-`.length) : null;
  const transfersAlreadyDone = marker === `${dl.event}:transfers` || botChip != null;

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
  const chip = activeChip(raw);
  const userChip = chip && chip !== botChip ? chip : null;
  if (headsUp) {
    // Nothing to warn about if you've already taken the week over; the window run will say so.
    if (userChip || team.unlimited || team.made > 0) return say("You're managing this week yourself — no heads-up."), 0;
  } else {
    const handsOff = async (why: string) => {
      const msg = `GW${dl.event}: ${why} — autopilot is leaving this week alone.`;
      say(msg);
      await notify(msg, "SKIPPED");
      await writeMarker(`${dl.event}:done`);
      return 0;
    };
    // A lineup submit carries the chip field and would cancel yours — so don't touch anything.
    if (userChip) return handsOff(`you've activated **${userChip}**`);
    if (team.unlimited) return handsOff("unlimited transfers (wildcard, free hit or pre-season)");
    if (team.made > 0 && !transfersAlreadyDone) return handsOff(`you've already made ${team.made} transfer(s) yourself`);
  }

  // 5. Plan. If transfers already went through on an earlier run, only redo the lineup.
  const bundle = buildBundle(boot, fixtures, { includeIds: team.picks.map((p) => p.element), generatedAt: now.toISOString() });
  const ds = indexBundle(bundle, "live");
  const ctx = buildContext({ projections: projectAll(ds, { ...DEFAULT_STRATEGY }), team });
  const curve = await transferCurve(ctx, solve, transfersAlreadyDone ? 0 : undefined);
  const base = await finishPlan({ ctx, curve, criteria: CRITERIA, solve, event: dl.event, now });
  if (ds.startEvent !== dl.event) base.notes.push(`Model's next gameweek is ${ds.startEvent}; deadline is GW${dl.event}.`);

  // 5b. Captain and chips.
  const odds = await loadOdds(bundle, now, offline);
  const states = statesFromMyTeam(team.chips, chipWindows(bundle.chips), dl.event);
  const { plan: week, extras } = await finishWeek({
    ds,
    ctx,
    plan: base,
    criteria: CRITERIA,
    states,
    odds: oddsIndex(odds),
    solve,
    keepChip: botChip,
  });

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
    ...extrasLines(week, extras, ctx.nameOf, odds),
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

  const proposalExtra = proposalExtras(week, extras, ctx.nameOf, odds);

  if (headsUp) {
    const r = report(`HEADS-UP — executes in the window (${CRITERIA.windowMaxH}h–${CRITERIA.windowMinH}h before the deadline)`)
      .replace("Dry run: nothing was sent to FPL.", "Nothing sent yet.");
    say(r);
    await notify(r, extras.chips.suggest.length ? "CHIP SUGGESTED" : "HEADS-UP");
    await writeMarker(`${dl.event}:alerted`);
    return 0;
  }

  if (d.verdict === "BLOCKED") {
    const r = report("BLOCKED — nothing submitted");
    say(r);
    await notify(r, "BLOCKED");
    await publish(dl, d, "BLOCKED", proposalExtra);
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
  if (CONFIG.setLineup || week.plan.chip) {
    // Remember the chip first: on a retry it shows as active, and must read as ours.
    if (week.plan.chip) await writeMarker(`${dl.event}:chip-${week.plan.chip}`);
    await send(`/my-team/${entry}/`, d.payloads.lineup, token);
    say(`Submitted lineup${week.plan.chip ? ` with ${CHIP_LABEL[week.plan.chip as keyof typeof CHIP_LABEL] ?? week.plan.chip}` : ""}.`);
  }

  const after = offline ? postOfflineResult(team, week) : await getJson(`/my-team/${entry}/`, token);
  const got = new Set((after.picks ?? []).map((p: any) => p.element));
  const want = week.plan.picks.map((p) => p.element);
  const wantCaptain = week.plan.picks.find((p) => p.is_captain)?.element;
  const gotCaptain = (after.picks ?? []).find((p: any) => p.is_captain)?.element;
  const squadOk = want.every((id) => got.has(id)) && got.size === 15;
  const captainOk = !(CONFIG.setLineup || week.plan.chip) || gotCaptain === wantCaptain;
  const chipOk = !week.plan.chip || activeChip(after) === week.plan.chip;
  if (!squadOk || !captainOk || !chipOk) {
    const r = report("SUBMITTED BUT NOT CONFIRMED") +
      `\n\n**Check your team in the FPL app.** Squad matches: ${squadOk} · captain matches: ${captainOk}` +
      (week.plan.chip ? ` · ${week.plan.chip} active: ${chipOk}` : "") + ".";
    say(r);
    await notify(r, "CHECK TEAM");
    await publish(dl, d, "CHECK TEAM", proposalExtra);
    return 1;
  }

  await writeMarker(`${dl.event}:done`);
  const chipNote = week.plan.chip ? ` + ${CHIP_LABEL[week.plan.chip as keyof typeof CHIP_LABEL]}` : "";
  const r = report((week.transfersUsed ? `EXECUTED ${week.transfersUsed} transfer(s)` : "ROLLED — lineup set") + chipNote);
  say(r);
  await notify(r, "EXECUTED");
  await publish(dl, d, "EXECUTED", proposalExtra);
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
  return {
    picks: week.plan.picks,
    chips: week.plan.chip ? [{ name: week.plan.chip, status_for_entry: "active" }] : [],
  };
}

// ---------------------------------------------------------------------------
// Report pieces for captain and chips
// ---------------------------------------------------------------------------

const fmt = (n: number | null | undefined, d = 1) => (n == null ? "—" : n.toFixed(d));

function extrasLines(week: WeekPlan, x: WeekExtras, nameOf: (id: number) => string, odds: OddsSnapshot | null): string[] {
  const L: string[] = [];
  const top = x.captains.filter((c) => c.eligible).slice(0, 3);
  const c = x.captains.find((r) => r.id === week.captain);
  L.push(`**Captain:** ${nameOf(week.captain)}${week.plan.chip === "3xc" ? " (TRIPLE)" : ""} · vice ${nameOf(week.vice)}` +
    (c ? ` — ${fmt(c.mean)} xP blended (model ${fmt(c.model)}, odds ${fmt(c.withOdds)}, FPL ${fmt(c.ep)}, form ${fmt(c.form)})` : ""));
  if (c?.reasons.length) L.push(`  ${c.reasons.join(" · ")}`);
  if (top.length > 1) L.push(`  Next: ${top.slice(1).map((r) => `${r.name} ${fmt(r.mean)}`).join(" · ")}`);
  if (!odds) L.push("  (no bookmaker odds this run — model, FPL projection and form only)");
  const play = x.chips.play;
  const row = (n: string) => x.chips.rows.find((r) => r.name === n);
  if (play) L.push(`**Chip:** playing **${CHIP_LABEL[play]}** — ${row(play)?.why}`);
  else L.push("**Chip:** none this week");
  for (const s of x.chips.suggest) {
    L.push(`**Suggested for you:** ${CHIP_LABEL[s]} — ${row(s)?.why}. Play it in the FPL app before the window; the autopilot will then leave the week to you.`);
  }
  for (const r of x.chips.rows) {
    if (r.decision === "hold" && r.state.available) L.push(`- ${r.label}: hold — ${r.why}`);
  }
  return L;
}

function proposalExtras(week: WeekPlan, x: WeekExtras, nameOf: (id: number) => string, odds: OddsSnapshot | null) {
  return {
    chip: week.plan.chip,
    chipsSuggested: x.chips.suggest,
    chipRows: x.chips.rows.map((r) => ({ name: r.name, label: r.label, decision: r.decision, why: r.why, now: r.now, best: r.best })),
    captainPick: x.captains
      .filter((c) => c.eligible)
      .slice(0, 5)
      .map((c) => ({ id: c.id, name: nameOf(c.id), mean: Number(c.mean.toFixed(2)), reasons: c.reasons })),
    oddsAt: odds?.fetchedAt ?? null,
  };
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
