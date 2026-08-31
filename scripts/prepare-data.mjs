#!/usr/bin/env node
/**
 * Runs before every build. Tries to snapshot the live FPL API; if that fails,
 * falls back to whatever bundle is already committed, and only generates the
 * synthetic sample if there is nothing at all.
 *
 * The point is that a build never fails because the FPL API had a bad minute,
 * and never silently ships a stale-but-present bundle without saying so.
 *
 * On Vercel and Netlify this means every deploy carries fresh data with no
 * configuration. The scheduled GitHub Action stays useful independently: it
 * commits a snapshot, which both refreshes the fallback and triggers a redeploy.
 *
 * Set SKIP_DATA_FETCH=1 to use the committed bundle as-is (fast local builds).
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const BUNDLE = "public/data/bundle.json";

const run = (script) =>
  spawnSync(process.execPath, [script], { stdio: "inherit", timeout: 90_000 }).status === 0;

function describeExisting() {
  if (!existsSync(BUNDLE)) return null;
  const ageHours = (Date.now() - statSync(BUNDLE).mtimeMs) / 3_600_000;
  return `${(statSync(BUNDLE).size / 1024).toFixed(0)} KB, ${ageHours.toFixed(1)}h old`;
}

if (process.env.SKIP_DATA_FETCH) {
  console.log(`[data] SKIP_DATA_FETCH set — using committed bundle (${describeExisting() ?? "missing"})`);
} else if (run("scripts/fetch-fpl.mjs")) {
  console.log("[data] live FPL snapshot written");
} else {
  const existing = describeExisting();
  if (existing) {
    console.warn(`[data] live fetch failed — falling back to the committed bundle (${existing})`);
  } else {
    console.warn("[data] live fetch failed and no bundle is committed — generating the sample");
    if (!run("scripts/make-sample.mjs")) {
      console.error("[data] could not produce any bundle");
      process.exit(1);
    }
  }
}
