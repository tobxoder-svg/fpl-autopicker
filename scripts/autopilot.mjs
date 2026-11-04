#!/usr/bin/env node
/**
 * FPL autopilot — scheduled runner, propose-only build.
 *
 * Runs on a schedule (hourly is fine). Each run:
 *
 *   1. Reads `events` from bootstrap-static and finds the next deadline.
 *      Outside the action window it exits immediately — no auth, no noise.
 *   2. Inside the window, exchanges the stored OIDC refresh token for an
 *      access token and PERSISTS THE ROTATED REFRESH TOKEN before doing
 *      anything else (see "Token rotation" below).
 *   3. Fetches the live squad from my-team/{entry}/ — selling prices, bank,
 *      free transfers, chips.
 *   4. Diffs it against a target plan (plan.json, from the solver), checks
 *      every rule FPL would enforce plus your own guardrails, and writes a
 *      report and the exact request bodies it *would* send.
 *
 * It never writes to your FPL account. `--apply` refuses on purpose: the
 * request bodies are produced so you can check them by eye for a dozen
 * gameweeks before the write path is wired up.
 *
 * Token rotation
 * --------------
 * FPL's login is PingOne OIDC. Every refresh-token exchange returns a NEW
 * refresh token and retires the old one. If the runner exchanges a token and
 * then crashes before saving the new one, the account is locked out of the
 * runner until you copy a fresh token from the browser. So the new token is
 * written to disk (atomically, mode 600) immediately after the exchange, and
 * optionally to a file the CI workflow uses to update its secret.
 *
 * Getting the first token: log in at fantasy.premierleague.com, open DevTools
 * → Application → Local storage, and copy `refresh_token` from the key that
 * starts with `oidc.user:`. Log out of that browser afterwards or simply let
 * the browser session lapse — the first exchange here retires its copy.
 *
 * Usage
 * -----
 *   node scripts/autopilot.mjs --plan plan.json
 *   node scripts/autopilot.mjs --plan plan.json --force          # ignore the window
 *   node scripts/autopilot.mjs --plan plan.json --offline fixtures/ --now 2026-11-07T06:00:00Z
 *
 * Environment
 * -----------
 *   FPL_REFRESH_TOKEN            first-run token (the state file wins afterwards)
 *   FPL_ENTRY_ID                 optional; otherwise read from /me/
 *   FPL_OIDC_CLIENT_ID           override if FPL changes its OIDC client
 *   FPL_OIDC_AUTHORITY           default https://account.premierleague.com/as
 *   AUTOPILOT_ROTATED_TOKEN_FILE where to drop the rotated token for CI write-back
 *   AUTOPILOT_LAST_HASH          last proposal hash, for CI where the state file is lost
 *   AUTOPILOT_HASH_FILE          where to write the new hash after notifying
 *   AUTOPILOT_PUBLISH_PATH       also write proposal.json here, for the app's Autopilot screen
 *   NOTIFY_WEBHOOK               ntfy / Discord / Slack webhook for the report
 *   GITHUB_STEP_SUMMARY          set by Actions; the report is appended to it
 *
 * Field names on the authenticated endpoints (me, my-team) have not been
 * verified against a live response from this sandbox. They are read
 * defensively and the first real run prints what it found.
 */

import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API = "https://fantasy.premierleague.com/api";
const UA = { "User-Agent": "fantasy-drafter-autopilot/0.1 (personal use)" };
const OIDC_AUTHORITY = process.env.FPL_OIDC_AUTHORITY ?? "https://account.premierleague.com/as";
const OIDC_CLIENT_ID = process.env.FPL_OIDC_CLIENT_ID ?? "1f243d70-a140-4035-8c41-341f5af5aa12";
const OIDC_TOKEN_URL = process.env.FPL_TOKEN_URL ?? `${OIDC_AUTHORITY}/token`;

const POS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
const SQUAD_SHAPE = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
const XI_MIN = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
const XI_MAX = { GK: 1, DEF: 5, MID: 5, FWD: 3 };
const MAX_PER_CLUB = 3;
const HIT_COST = 4;
const FREE_TRANSFER_CHIPS = new Set(["wildcard", "freehit"]);

// Exit codes. A skipped run is a success; an auth failure is not, so CI's
// own failed-run email becomes the "re-copy your token" notification.
const EXIT = { OK: 0, ERROR: 1, AUTH: 2, TEMPORARY: 75 };

const { values: args } = parseArgs({
  // Not strict: scripts/autopick.ts imports this module, and its own flags
  // must not be rejected here.
  strict: false,
  options: {
    plan: { type: "string" },
    state: { type: "string", default: ".autopilot/state.json" },
    out: { type: "string", default: ".autopilot/out" },
    "window-min": { type: "string", default: "1.5" },   // hours before deadline
    "window-max": { type: "string", default: "8" },
    "max-hits": { type: "string", default: "1" },        // spec: max_hits_per_gw
    "max-plan-age": { type: "string", default: "36" },   // hours
    force: { type: "boolean", default: false },
    offline: { type: "string" },                         // dir with bootstrap.json, my-team.json
    now: { type: "string" },                             // ISO override, for tests
    apply: { type: "boolean", default: false },
  },
});

export class AuthError extends Error {}
export class TemporaryError extends Error {}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const money = (tenths) => `£${(tenths / 10).toFixed(1)}m`;
const hours = (ms) => ms / 3_600_000;
const fmtUtc = (d) =>
  d.toLocaleString("en-GB", {
    timeZone: "UTC", weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit",
  }) + " UTC";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Write via temp + rename so a crash mid-write never leaves half a token. */
export async function writeSecretJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});   // no-op on Windows
}

export async function getJson(path, accessToken) {
  const headers = { ...UA };
  if (accessToken) headers["X-API-Authorization"] = `Bearer ${accessToken}`;
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers });
  } catch (err) {
    throw new TemporaryError(`network error on ${path}: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`${path} -> HTTP ${res.status}; the access token was refused`);
  }
  if (res.status >= 500) throw new TemporaryError(`${path} -> HTTP ${res.status}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  const text = await res.text();
  // Around deadlines and price changes the API answers 200 with a plain-text
  // "The game is being updated." That is a retry-next-hour, not a crash.
  try {
    return JSON.parse(text);
  } catch {
    throw new TemporaryError(`${path} returned non-JSON (game updating?): ${text.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Deadline detection
// ---------------------------------------------------------------------------

/**
 * The next deadline is the `is_next` event. Fallback: the first unfinished
 * event whose deadline is still ahead — covers the hours after a deadline
 * when FPL has not yet flipped the flags.
 */
export function nextDeadline(events, now) {
  const upcoming = (e) => Date.parse(e.deadline_time) > now;
  const ev =
    events.find((e) => e.is_next && upcoming(e)) ??
    events.find((e) => !e.finished && upcoming(e));
  if (!ev) return null;
  const deadline = new Date(ev.deadline_time);
  return { event: ev.id, deadline, hoursLeft: hours(deadline - now) };
}

export function windowDecision(dl, { min, max, force }) {
  if (!dl) return { act: false, reason: "No upcoming deadline — season over?" };
  if (force) return { act: true, reason: "--force" };
  if (dl.hoursLeft < min) {
    return { act: false, reason: `Too close to the deadline (${dl.hoursLeft.toFixed(1)}h < ${min}h margin)` };
  }
  if (dl.hoursLeft > max) {
    return { act: false, reason: `GW${dl.event} deadline in ${dl.hoursLeft.toFixed(1)}h — window opens ${max}h before` };
  }
  return { act: true, reason: `Inside window (${dl.hoursLeft.toFixed(1)}h to deadline)` };
}

// ---------------------------------------------------------------------------
// 2. Auth: refresh-token exchange with rotation persistence
// ---------------------------------------------------------------------------

async function loadState(path) {
  if (existsSync(path)) return readJson(path);
  return {};
}

export async function exchangeRefreshToken(state, statePath) {
  // The state file holds the most recently rotated token, so it beats the env
  // var, which may be the long-retired token you pasted on day one.
  const refreshToken = state.refresh_token ?? process.env.FPL_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new AuthError("No refresh token. Set FPL_REFRESH_TOKEN (see header for how to copy it).");
  }

  const res = await fetch(OIDC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...UA },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OIDC_CLIENT_ID,
    }),
  }).catch((err) => {
    throw new TemporaryError(`token endpoint unreachable: ${err.message}`);
  });

  if (res.status === 400 || res.status === 401) {
    const body = await res.text();
    throw new AuthError(
      `Refresh token rejected (${res.status}: ${body.slice(0, 120)}). It has been rotated ` +
        "elsewhere, revoked, or expired — copy a fresh one from the browser.",
    );
  }
  if (!res.ok) throw new TemporaryError(`token endpoint -> HTTP ${res.status}`);

  const tok = await res.json();
  if (!tok.access_token) throw new AuthError("Token response had no access_token");

  // Persist BEFORE any other call. If this write fails, stop: carrying on with
  // an unsaved rotated token is how you get locked out.
  const rotated = tok.refresh_token ?? refreshToken;
  const next = { ...state, refresh_token: rotated, rotated_at: new Date().toISOString() };
  await writeSecretJson(statePath, next);

  const handoff = process.env.AUTOPILOT_ROTATED_TOKEN_FILE;
  if (handoff && rotated !== refreshToken) {
    await writeFile(handoff, rotated, { mode: 0o600 });
  }
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::add-mask::${tok.access_token}`);
    console.log(`::add-mask::${rotated}`);
  }

  return { accessToken: tok.access_token, state: next };
}

// ---------------------------------------------------------------------------
// 3. Current squad
// ---------------------------------------------------------------------------

/**
 * Normalise my-team/{entry}/. Expected shape (unverified live):
 *   picks[]:   { element, position, multiplier, is_captain, is_vice_captain,
 *                selling_price, purchase_price }
 *   transfers: { limit, made, bank, value, cost, status }
 *   chips[]:   { name, status_for_entry, ... }
 */
export function normaliseMyTeam(raw) {
  if (!Array.isArray(raw?.picks) || raw.picks.length !== 15) {
    throw new Error(`my-team: expected 15 picks, got ${raw?.picks?.length ?? "none"} — field names changed?`);
  }
  const picks = raw.picks
    .map((p) => ({
      element: p.element,
      position: p.position,
      isCaptain: !!p.is_captain,
      isVice: !!p.is_vice_captain,
      sellingPrice: p.selling_price,
      purchasePrice: p.purchase_price,
    }))
    .sort((a, b) => a.position - b.position);

  const t = raw.transfers ?? {};
  const unlimited = t.status === "unlimited" || t.limit == null;
  const freeTransfers = unlimited ? Infinity : Math.max(0, (t.limit ?? 0) - (t.made ?? 0));

  const chips = (raw.chips ?? []).map((c) => ({
    name: c.name,
    available: (c.status_for_entry ?? c.status) === "available",
  }));

  return { picks, bank: t.bank ?? 0, freeTransfers, unlimited, made: t.made ?? 0, chips };
}

async function loadCurrentSquad(state, statePath) {
  if (args.offline) {
    return { team: normaliseMyTeam(await readJson(join(args.offline, "my-team.json"))), state };
  }
  const auth = await exchangeRefreshToken(state, statePath);
  let entry = auth.state.entry ?? process.env.FPL_ENTRY_ID;
  if (!entry) {
    const me = await getJson("/me/", auth.accessToken);
    entry = me?.player?.entry;
    if (!entry) throw new AuthError("/me/ returned no entry — the token is valid but not for an FPL team?");
    auth.state.entry = entry;
    await writeSecretJson(statePath, auth.state);
  }
  const raw = await getJson(`/my-team/${entry}/`, auth.accessToken);
  return { team: normaliseMyTeam(raw), state: auth.state };
}

// ---------------------------------------------------------------------------
// 4. Plan, diff and checks
// ---------------------------------------------------------------------------

/**
 * plan.json — what the solver hands over. Same shape as FPL's lineup payload,
 * plus the gameweek it was solved for and optional per-player xP.
 *   { "event": 10, "generated_at": "...", "chip": null,
 *     "picks": [{ "element": 1, "position": 1, "is_captain": false, "is_vice_captain": false }, ...15],
 *     "xp": { "<element>": <xP over horizon> }  // optional, for the gain-vs-hit check
 *   }
 */
export function diffPlan({ current, plan, elements, teams = [], event, maxHits, now, maxPlanAgeH }) {
  const clubName = (id) => teams.find((t) => t.id === id)?.short_name ?? `club ${id}`;
  const byId = new Map(elements.map((e) => [e.id, e]));
  const info = (id) => byId.get(id) ?? { id, web_name: `#${id}`, element_type: 0, team: 0, now_cost: 0 };
  const name = (id) => info(id).web_name;
  const pos = (id) => POS[info(id).element_type] ?? "?";
  const checks = [];
  const check = (level, msg) => checks.push({ level, msg });   // ok | warn | fail

  // --- plan sanity
  const target = [...plan.picks].sort((a, b) => a.position - b.position);
  if (plan.event !== event) check("fail", `Plan was solved for GW${plan.event}, next deadline is GW${event} — re-solve`);
  if (plan.generated_at) {
    const age = hours(now - Date.parse(plan.generated_at));
    if (age > maxPlanAgeH) check("warn", `Plan is ${age.toFixed(0)}h old — prices and team news may have moved`);
  }
  if (target.length !== 15) check("fail", `Plan has ${target.length} picks, needs 15`);

  // --- transfers
  const curIds = new Set(current.picks.map((p) => p.element));
  const tgtIds = new Set(target.map((p) => p.element));
  const outs = current.picks.filter((p) => !tgtIds.has(p.element));
  const ins = target.filter((p) => !curIds.has(p.element)).map((p) => p.element);

  // FPL transfers are like-for-like by position; pair dearest-with-dearest.
  const transfers = [];
  for (const P of Object.keys(SQUAD_SHAPE)) {
    const o = outs.filter((p) => pos(p.element) === P).sort((a, b) => b.sellingPrice - a.sellingPrice);
    const i = ins.filter((id) => pos(id) === P).sort((a, b) => info(b).now_cost - info(a).now_cost);
    if (o.length !== i.length) {
      check("fail", `${P}: ${o.length} out but ${i.length} in — plan breaks the 2-5-5-3 shape`);
    }
    for (let k = 0; k < Math.min(o.length, i.length); k++) {
      transfers.push({ pos: P, out: o[k], in: i[k] });
    }
  }

  // --- budget, with live selling prices (not the buy price, not now_cost)
  const proceeds = outs.reduce((s, p) => s + p.sellingPrice, 0);
  const spend = ins.reduce((s, id) => s + info(id).now_cost, 0);
  const bankAfter = current.bank + proceeds - spend;
  if (bankAfter < 0) check("fail", `Over budget by ${money(-bankAfter)}`);
  else check("ok", `Budget: ${money(current.bank)} bank → ${money(bankAfter)} after transfers`);

  // --- squad shape and club limit
  const shape = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map();
  for (const p of target) {
    const P = pos(p.element);
    if (P in shape) shape[P]++;
    const club = info(p.element).team;
    clubs.set(club, (clubs.get(club) ?? 0) + 1);
  }
  const shapeOk = Object.entries(SQUAD_SHAPE).every(([P, n]) => shape[P] === n);
  check(shapeOk ? "ok" : "fail", `Squad shape ${shape.GK}-${shape.DEF}-${shape.MID}-${shape.FWD}`);
  const overClub = [...clubs].filter(([, n]) => n > MAX_PER_CLUB);
  check(overClub.length ? "fail" : "ok",
    overClub.length ? `More than ${MAX_PER_CLUB} from ${overClub.map(([c, n]) => `${clubName(c)} (${n})`).join(", ")}` : `Max ${MAX_PER_CLUB} per club`);

  // --- XI, bench, armband
  const xi = target.filter((p) => p.position <= 11);
  const bench = target.filter((p) => p.position > 11);
  const xiShape = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of xi) xiShape[pos(p.element)]++;
  const xiOk = Object.keys(XI_MIN).every((P) => xiShape[P] >= XI_MIN[P] && xiShape[P] <= XI_MAX[P]);
  check(xiOk ? "ok" : "fail", `Formation ${xiShape.DEF}-${xiShape.MID}-${xiShape.FWD}`);
  if (bench[0] && pos(bench[0].element) !== "GK") check("fail", "Bench slot 1 (position 12) must be the goalkeeper");
  const cap = target.filter((p) => p.is_captain);
  const vice = target.filter((p) => p.is_vice_captain);
  if (cap.length !== 1 || vice.length !== 1) check("fail", "Need exactly one captain and one vice");
  else if (cap[0].element === vice[0].element) check("fail", "Captain and vice are the same player");
  else if (cap[0].position > 11 || vice[0].position > 11) check("fail", "Captain and vice must both start");

  // --- availability of the starters
  for (const p of xi) {
    const e = info(p.element);
    const chance = e.chance_of_playing_next_round;
    if (e.status === "u") check("fail", `${e.web_name} is unavailable (left the league?)`);
    else if (chance != null && chance < 75) check("warn", `${e.web_name} starts with ${chance}% chance of playing`);
  }

  // --- chip
  const chip = plan.chip ?? null;
  if (chip) {
    const c = current.chips.find((x) => x.name === chip);
    if (!c) check("warn", `Chip "${chip}" not listed on my-team — cannot confirm it is available`);
    else if (!c.available) check("fail", `Chip "${chip}" is not available this gameweek`);
  }

  // --- free transfers, hits, and whether the hits pay for themselves
  const freeChip = chip && FREE_TRANSFER_CHIPS.has(chip);
  const free = freeChip || current.unlimited ? Infinity : current.freeTransfers;
  const hits = Number.isFinite(free) ? Math.max(0, transfers.length - free) : 0;
  const hitCost = hits * HIT_COST;
  if (hits > maxHits) check("fail", `${hits} hits (−${hitCost}) exceeds your max of ${maxHits}`);
  else if (hits) check("warn", `Takes ${hits} hit${hits > 1 ? "s" : ""}: −${hitCost} pts`);
  else check("ok", "No hits");

  let xpGain = null;
  if (plan.xp && transfers.length) {
    xpGain = transfers.reduce((s, t) => s + (plan.xp[t.in] ?? 0) - (plan.xp[t.out.element] ?? 0), 0);
    if (hits && xpGain < hitCost) {
      check("warn", `Transfers gain ${xpGain.toFixed(1)} xP but cost ${hitCost} — the hit does not pay for itself`);
    }
  }

  // --- lineup changes that are not transfers
  const curXi = new Set(current.picks.filter((p) => p.position <= 11).map((p) => p.element));
  const benched = [...curXi].filter((id) => tgtIds.has(id) && !xi.some((p) => p.element === id));
  const promoted = xi.filter((p) => curIds.has(p.element) && !curXi.has(p.element)).map((p) => p.element);
  const curCap = current.picks.find((p) => p.isCaptain)?.element;
  const curVice = current.picks.find((p) => p.isVice)?.element;

  const lineup = {
    benched, promoted,
    captain: cap[0] ? { from: curCap, to: cap[0].element } : null,
    vice: vice[0] ? { from: curVice, to: vice[0].element } : null,
    benchOrder: bench.map((p) => p.element),
  };

  const verdict = checks.some((c) => c.level === "fail")
    ? "BLOCKED"
    : checks.some((c) => c.level === "warn")
      ? "NEEDS REVIEW"
      : "READY";

  // The exact bodies a future --apply would POST. Unverified field names;
  // these are here to be eyeballed against what the FPL site sends.
  const payloads = {
    transfers: transfers.length
      ? {
          chip,
          entry: null, // filled at apply time
          event,
          transfers: transfers.map((t) => ({
            element_in: t.in,
            element_out: t.out.element,
            purchase_price: info(t.in).now_cost,
            selling_price: t.out.sellingPrice,
          })),
        }
      : null,
    lineup: {
      chip: freeChip ? null : chip,   // WC/FH are played with the transfers
      picks: target.map((p) => ({
        element: p.element, position: p.position,
        is_captain: !!p.is_captain, is_vice_captain: !!p.is_vice_captain,
      })),
    },
  };

  return { verdict, transfers, bankAfter, hits, hitCost, free, xpGain, lineup, checks, payloads, name, pos, info, clubName };
}

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------

export function renderReport(dl, d) {
  const L = [];
  const icon = { ok: "✓", warn: "⚠", fail: "✗" };
  L.push(`## GW${dl.event} autopilot — ${d.verdict}`);
  L.push(`Deadline ${fmtUtc(dl.deadline)} (in ${dl.hoursLeft.toFixed(1)}h). Dry run: nothing was sent to FPL.`);
  L.push("");

  if (d.transfers.length) {
    const ftLabel = Number.isFinite(d.free) ? `${d.free} free` : "unlimited";
    L.push(`### Transfers (${d.transfers.length}, ${ftLabel}${d.hits ? `, −${d.hitCost} hit` : ""})`);
    L.push("| Pos | Out | Sell | In | Buy |");
    L.push("|---|---|---|---|---|");
    for (const t of d.transfers) {
      L.push(`| ${t.pos} | ${d.name(t.out.element)} | ${money(t.out.sellingPrice)} | ${d.name(t.in)} | ${money(d.info(t.in).now_cost)} |`);
    }
    L.push(`Bank after: ${money(d.bankAfter)}${d.xpGain != null ? ` · xP gain ${d.xpGain >= 0 ? "+" : ""}${d.xpGain.toFixed(1)}` : ""}`);
  } else {
    L.push("### Transfers\nNone — roll the free transfer.");
  }
  L.push("");

  L.push("### Lineup");
  const lu = d.lineup;
  const lines = [];
  if (lu.captain && lu.captain.from !== lu.captain.to) {
    lines.push(`Captain: ${lu.captain.from ? d.name(lu.captain.from) : "—"} → **${d.name(lu.captain.to)}**`);
  } else if (lu.captain) lines.push(`Captain: ${d.name(lu.captain.to)} (unchanged)`);
  if (lu.vice && lu.vice.from !== lu.vice.to) {
    lines.push(`Vice: ${lu.vice.from ? d.name(lu.vice.from) : "—"} → ${d.name(lu.vice.to)}`);
  }
  if (lu.promoted.length) lines.push(`Into the XI from the bench: ${lu.promoted.map(d.name).join(", ")}`);
  if (lu.benched.length) lines.push(`Dropped to the bench: ${lu.benched.map(d.name).join(", ")}`);
  lines.push(`Bench order: ${lu.benchOrder.map(d.name).join(" · ")}`);
  L.push(...lines.map((s) => `- ${s}`));
  L.push("");

  L.push("### Checks");
  for (const c of d.checks) L.push(`- ${icon[c.level]} ${c.msg}`);
  return L.join("\n");
}

/**
 * The same proposal as structured JSON, for the app's Autopilot screen.
 * Names and prices are resolved here so the app needs no lookups.
 */
export function toProposal(dl, d) {
  const who = (id) => (id == null ? null : { id, name: d.name(id), pos: d.pos(id), club: d.clubName(d.info(id).team) });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    event: dl.event,
    deadline: dl.deadline.toISOString(),
    verdict: d.verdict,
    transfers: d.transfers.map((t) => ({
      pos: t.pos,
      out: { ...who(t.out.element), price: t.out.sellingPrice },
      in: { ...who(t.in), price: d.info(t.in).now_cost },
    })),
    bankAfter: d.bankAfter,
    freeTransfers: Number.isFinite(d.free) ? d.free : null,
    hits: d.hits,
    hitCost: d.hitCost,
    xpGain: d.xpGain,
    lineup: {
      captain: d.lineup.captain && { from: who(d.lineup.captain.from), to: who(d.lineup.captain.to) },
      vice: d.lineup.vice && { from: who(d.lineup.vice.from), to: who(d.lineup.vice.to) },
      promoted: d.lineup.promoted.map(who),
      benched: d.lineup.benched.map(who),
      benchOrder: d.lineup.benchOrder.map(who),
    },
    checks: d.checks,
  };
}

export async function notify(markdown, verdict) {
  const url = process.env.NOTIFY_WEBHOOK;
  if (!url) return;
  let init;
  if (url.includes("discord.com")) {
    init = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: markdown.slice(0, 1900) }) };
  } else if (url.includes("hooks.slack.com")) {
    init = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: markdown }) };
  } else {
    // ntfy.sh and anything that takes a plain body
    init = { headers: { Title: `FPL autopilot: ${verdict}`, Markdown: "yes" }, body: markdown };
  }
  const res = await fetch(url, { method: "POST", ...init }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) console.warn(`notify failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (args.apply) {
    console.error(
      "--apply is deliberately not wired in this build. Run in propose mode for a run of " +
        "gameweeks, compare payloads.json with what the FPL site sends, then wire the write path.",
    );
    return EXIT.ERROR;
  }
  const now = args.now ? Date.parse(args.now) : Date.now();

  // 1. Deadline — public data only, so an out-of-window run costs one GET.
  const bootstrap = args.offline
    ? await readJson(join(args.offline, "bootstrap.json"))
    : await getJson("/bootstrap-static/");
  const dl = nextDeadline(bootstrap.events, now);
  const decision = windowDecision(dl, {
    min: Number(args["window-min"]), max: Number(args["window-max"]), force: args.force,
  });
  console.log(decision.reason);
  if (!decision.act) return EXIT.OK;

  if (!args.plan) throw new Error("--plan is required inside the window");
  const plan = await readJson(args.plan);

  // 2 + 3. Auth and live squad
  let state = await loadState(args.state);
  const loaded = await loadCurrentSquad(state, args.state);
  state = loaded.state;
  const current = loaded.team;
  console.log(`Squad loaded: ${current.picks.length} players, bank ${money(current.bank)}, ` +
    `${Number.isFinite(current.freeTransfers) ? current.freeTransfers : "unlimited"} FT, ` +
    `chips available: ${current.chips.filter((c) => c.available).map((c) => c.name).join(", ") || "none listed"}`);

  // 4. Diff
  const d = diffPlan({
    current, plan, elements: bootstrap.elements, teams: bootstrap.teams, event: dl.event,
    maxHits: Number(args["max-hits"]), now, maxPlanAgeH: Number(args["max-plan-age"]),
  });
  const report = renderReport(dl, d);

  // 5. Outputs
  await mkdir(args.out, { recursive: true });
  await writeFile(join(args.out, `gw${dl.event}-report.md`), report + "\n");
  await writeFile(join(args.out, `gw${dl.event}-payloads.json`), JSON.stringify(d.payloads, null, 2) + "\n");
  const proposal = JSON.stringify(toProposal(dl, d), null, 1) + "\n";
  await writeFile(join(args.out, `gw${dl.event}-proposal.json`), proposal);
  console.log("\n" + report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report + "\n");

  // Only notify when the proposal changed — hourly runs inside the window
  // would otherwise send the same message six times.
  // In CI the state file dies with the runner, so the last hash also comes in
  // through AUTOPILOT_LAST_HASH and goes back out through AUTOPILOT_HASH_FILE.
  const hash = createHash("sha256").update(JSON.stringify([dl.event, d.payloads, d.checks])).digest("hex");
  const lastHash = state.last_report_hash ?? process.env.AUTOPILOT_LAST_HASH;
  if (lastHash !== hash || args.force) {
    await notify(report, d.verdict);
    // Opt-in: publish to the app (e.g. public/data/proposal.json) — only on a
    // real change, so CI commits once per new proposal, not every hour. It
    // reveals your planned transfers to anyone who opens the site.
    if (process.env.AUTOPILOT_PUBLISH_PATH) {
      await mkdir(dirname(process.env.AUTOPILOT_PUBLISH_PATH), { recursive: true });
      await writeFile(process.env.AUTOPILOT_PUBLISH_PATH, proposal);
    }
    if (!args.offline) {
      await writeSecretJson(args.state, { ...state, last_report_hash: hash, last_event: dl.event });
    }
    if (process.env.AUTOPILOT_HASH_FILE) await writeFile(process.env.AUTOPILOT_HASH_FILE, hash);
  } else {
    console.log("(Proposal unchanged since last run — not re-notifying.)");
  }
  return EXIT.OK;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof AuthError) {
        console.error(`AUTH: ${err.message}`);
        process.exit(EXIT.AUTH);
      }
      if (err instanceof TemporaryError) {
        console.error(`TEMPORARY: ${err.message} — will retry next run`);
        process.exit(EXIT.TEMPORARY);
      }
      console.error(err);
      process.exit(EXIT.ERROR);
    },
  );
}
