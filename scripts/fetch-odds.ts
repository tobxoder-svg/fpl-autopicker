#!/usr/bin/env tsx
/**
 * Snapshots bookmaker odds into public/data/odds.json, for the Autopilot tab's
 * captain picker (the browser can't hold the API key). Runs right after
 * fetch-fpl.mjs in the data-refresh job, and needs its bundle for the fixture
 * list. No ODDS_API_KEY → does nothing, and the app carries on without odds.
 *
 * Cost: 2 credits per run (h2h + totals, one region). Twice a day ≈ 120 a month.
 *
 * Usage:  ODDS_API_KEY=... npx tsx scripts/fetch-odds.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { fetchOddsEvents, parseOdds } from "../src/lib/odds.ts";

async function main() {
  const key = process.env.ODDS_API_KEY;
  if (!key) {
    console.log("ODDS_API_KEY not set — skipping odds (the app works without them).");
    return;
  }
  const bundle = JSON.parse(await readFile("public/data/bundle.json", "utf8"));
  const events = await fetchOddsEvents(key);
  const snap = parseOdds(events, bundle, new Date().toISOString());
  await writeFile("public/data/odds.json", JSON.stringify(snap, null, 1) + "\n");
  console.log(`wrote public/data/odds.json — ${snap.fixtures.length} fixtures priced`);
  if (snap.unmatched.length) console.warn(`unmatched: ${snap.unmatched.join("; ")}`);
}

main().catch((err) => {
  // Odds are an extra: a failure here must not stop the FPL data from committing.
  console.warn(`odds fetch failed: ${err.message}`);
});
