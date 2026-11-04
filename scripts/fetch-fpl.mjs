#!/usr/bin/env node
/**
 * Snapshots the FPL API into public/data/bundle.json.
 *
 * Why this exists: fantasy.premierleague.com/api sends no CORS headers, so a
 * browser cannot call it. A scheduled Action runs this, commits the result, and
 * the host serves it as a static file. No backend, no proxy, no hosting bill.
 * Prices move once a day at ~02:30 UK, so a few hours of staleness costs nothing.
 *
 * The bundle transformation lives in shared/build-bundle.mjs so the live Vercel
 * function (api/bundle.js) produces byte-for-byte the same shape — the two can
 * never drift apart.
 *
 * Usage:  node scripts/fetch-fpl.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { buildBundle } from "../shared/build-bundle.mjs";

const API = "https://fantasy.premierleague.com/api";
const UA = { "User-Agent": "fantasy-drafter/0.1 (+https://github.com/tobxoder-svg/fantasy-drafter)" };

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers: UA });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log("fetching bootstrap-static and fixtures…");
  const [boot, fixturesRaw] = await Promise.all([
    getJson("/bootstrap-static/"),
    getJson("/fixtures/"),
  ]);

  const bundle = buildBundle(boot, fixturesRaw);
  const { teams, players, fixtures, results } = bundle;

  await mkdir("public/data", { recursive: true });
  await writeFile("public/data/bundle.json", JSON.stringify(bundle));

  const poss = teams.map((t) => t.possession);
  const strongest = [...teams].sort((a, b) => b.attack - a.attack).slice(0, 3);
  console.log(
    `wrote public/data/bundle.json — ${players.length} players, ${teams.length} teams, ` +
      `${fixtures.length} upcoming fixtures, ${results.length} results, next GW ${bundle.nextEvent ?? "?"}`,
  );
  console.log(`possession proxy ${Math.min(...poss).toFixed(2)}–${Math.max(...poss).toFixed(2)}`);
  console.log(`strongest attacks: ${strongest.map((t) => `${t.short} ${t.attack.toFixed(2)}`).join(", ")}`);
}

main().catch((err) => {
  console.error("fetch failed:", err.message);
  process.exit(1);
});
