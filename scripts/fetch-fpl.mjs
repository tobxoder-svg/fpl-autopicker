#!/usr/bin/env node
/**
 * Snapshots the FPL API into public/data/bundle.json.
 *
 * Why this exists: fantasy.premierleague.com/api sends no CORS headers, so a
 * browser on a github.io origin cannot call it. A scheduled Action runs this,
 * commits the result, and Pages serves it as a static file. No backend, no
 * proxy, no hosting bill. Prices move once a day at ~02:30 UK, so a few hours
 * of staleness costs nothing.
 *
 * Usage:  node scripts/fetch-fpl.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";

const API = "https://fantasy.premierleague.com/api";
const UA = { "User-Agent": "fantasy-drafter/0.1 (+https://github.com/tobxoder-svg/fantasy-drafter)" };
const POSITIONS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers: UA });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

const num = (v) => {
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};
const per90 = (total, minutes) => (minutes > 0 ? (num(total) * 90) / minutes : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Count of qualifying defensive actions, with fallbacks across API shapes. */
function defensiveActions(el) {
  const cbit = num(el.clearances_blocks_interceptions);
  const tackles = num(el.tackles);
  const recoveries = num(el.recoveries);
  const pos = POSITIONS[el.element_type];
  const explicit = num(el.defensive_contribution);
  const derived = pos === "DEF" ? cbit + tackles : cbit + tackles + recoveries;
  return derived > 0 ? derived : explicit;
}

/**
 * Possession share, 0-1. The FPL API does not publish possession, so this is a
 * proxy: a side that spends more of the match defending racks up more
 * clearances, blocks, interceptions, tackles and recoveries per 90. Early in the
 * season, when minutes are thin, it is blended toward a prior derived from the
 * API's own team-strength ratings.
 *
 * Replace this with a real feed (FBref, Opta) and every DEFCON projection
 * improves at once — it is the single highest-value data upgrade available.
 */
function derivePossession(teams, elements) {
  const agg = new Map(teams.map((t) => [t.id, { actions: 0, minutes: 0 }]));
  for (const el of elements) {
    const bucket = agg.get(el.team);
    if (!bucket) continue;
    bucket.actions += defensiveActions(el);
    bucket.minutes += num(el.minutes);
  }

  const rates = new Map();
  for (const [id, b] of agg) rates.set(id, b.minutes > 0 ? (b.actions * 90) / b.minutes : 0);
  const leagueRate = mean([...rates.values()].filter((r) => r > 0)) || 1;

  const strengths = teams.map((t) => (num(t.strength_overall_home) + num(t.strength_overall_away)) / 2);
  const leagueStrength = mean(strengths) || 1;

  const out = new Map();
  for (const t of teams) {
    const rate = rates.get(t.id) ?? 0;
    // More defensive work than average -> less of the ball.
    const fromActions = 0.5 - 0.55 * (rate / leagueRate - 1);
    const strength = (num(t.strength_overall_home) + num(t.strength_overall_away)) / 2;
    const fromStrength = 0.5 + 0.4 * (strength / leagueStrength - 1);

    const minutes = agg.get(t.id)?.minutes ?? 0;
    const w = minutes / (minutes + 900 * 6); // ~6 full matches to trust the data
    const blended = fromActions * w + fromStrength * (1 - w);
    out.set(t.id, clamp(blended, 0.3, 0.68));
  }
  return out;
}

function teamRatings(teams) {
  const atk = teams.map((t) => (num(t.strength_attack_home) + num(t.strength_attack_away)) / 2);
  const def = teams.map((t) => (num(t.strength_defence_home) + num(t.strength_defence_away)) / 2);
  const avgAtk = mean(atk) || 1;
  const avgDef = mean(def) || 1;
  return teams.map((t, i) => ({
    attack: clamp(atk[i] / avgAtk, 0.6, 1.6),
    // A *higher* defence rating means a better defence, which concedes less —
    // so the model's "leakiness" multiplier is the inverse.
    defence: clamp(avgDef / (def[i] || avgDef), 0.55, 1.6),
  }));
}

function penaltyShare(order) {
  if (order === 1) return 0.85;
  if (order === 2) return 0.12;
  if (order === 3) return 0.03;
  return 0;
}

async function main() {
  console.log("fetching bootstrap-static and fixtures…");
  const [boot, fixturesRaw] = await Promise.all([getJson("/bootstrap-static/"), getJson("/fixtures/")]);

  const possession = derivePossession(boot.teams, boot.elements);
  const ratings = teamRatings(boot.teams);

  const teams = boot.teams.map((t, i) => ({
    id: t.id,
    name: t.name,
    short: t.short_name,
    attack: Number(ratings[i].attack.toFixed(4)),
    defence: Number(ratings[i].defence.toFixed(4)),
    possession: Number((possession.get(t.id) ?? 0.5).toFixed(4)),
  }));

  const players = boot.elements
    .filter((el) => num(el.minutes) > 0 || el.status === "a")
    .map((el) => {
      const minutes = num(el.minutes);
      const appearances = Math.max(num(el.starts), minutes > 0 ? 1 : 0);
      return {
        id: el.id,
        name: `${el.first_name} ${el.second_name}`.trim(),
        webName: el.web_name,
        pos: POSITIONS[el.element_type],
        teamId: el.team,
        cost: el.now_cost,
        status: el.status,
        chanceOfPlaying: el.chance_of_playing_next_round ?? null,
        ownership: num(el.selected_by_percent),
        minutes,
        starts: num(el.starts),
        appearances,
        npxg90: Number(per90(num(el.expected_goals) - num(el.penalties_scored) * 0.79, minutes).toFixed(4)),
        xa90: Number(per90(el.expected_assists, minutes).toFixed(4)),
        defcon90: Number(per90(defensiveActions(el), minutes).toFixed(4)),
        saves90: Number(per90(el.saves, minutes).toFixed(4)),
        yellow90: Number(per90(el.yellow_cards, minutes).toFixed(4)),
        red90: Number(per90(el.red_cards, minutes).toFixed(4)),
        penShare: penaltyShare(el.penalties_order),
        totalPoints: num(el.total_points),
      };
    });

  const fixtures = fixturesRaw.map((f) => ({
    event: f.event ?? null,
    teamH: f.team_h,
    teamA: f.team_a,
    finished: Boolean(f.finished),
  }));

  const current = boot.events.find((e) => e.is_current);
  const next = boot.events.find((e) => e.is_next);

  const bundle = {
    generatedAt: new Date().toISOString(),
    season: "2026/27",
    currentEvent: current?.id ?? null,
    nextEvent: next?.id ?? null,
    teams,
    players,
    fixtures,
  };

  await mkdir("public/data", { recursive: true });
  await writeFile("public/data/bundle.json", JSON.stringify(bundle));

  console.log(
    `wrote public/data/bundle.json — ${players.length} players, ${teams.length} teams, ` +
      `${fixtures.length} fixtures, next GW ${bundle.nextEvent ?? "?"}`,
  );

  const possessions = teams.map((t) => t.possession);
  console.log(
    `possession proxy range ${Math.min(...possessions).toFixed(2)}–${Math.max(...possessions).toFixed(2)}`,
  );
}

main().catch((err) => {
  console.error("fetch failed:", err.message);
  process.exit(1);
});
