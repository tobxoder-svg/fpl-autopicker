/**
 * GET /api/bundle — the live data bundle, built from the FPL API on request.
 *
 * Same transformation as the committed snapshot (shared/build-bundle.mjs), so
 * the app can't tell them apart except by `generatedAt`. Cached at Vercel's
 * edge for 15 minutes: thousands of opens cost FPL four requests an hour.
 * On any failure the app falls back to /data/bundle.json.
 */

import { buildBundle } from "../shared/build-bundle.mjs";
import { fplGet, sendError } from "./_lib/fpl.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  try {
    const [boot, fixtures] = await Promise.all([fplGet("/bootstrap-static/"), fplGet("/fixtures/")]);
    const bundle = buildBundle(boot, fixtures);
    // Browsers always revalidate; only Vercel's edge holds a copy (15 min, then
    // serves stale for an hour while it refreshes). One header for each.
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.setHeader("Vercel-CDN-Cache-Control", "max-age=900, stale-while-revalidate=3600");
    res.status(200).json({ ...bundle, source: "live" });
  } catch (err) {
    sendError(res, err);
  }
}
