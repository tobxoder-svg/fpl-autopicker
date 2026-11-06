/**
 * GET /api/live?event=N — one gameweek's matches with live scores.
 *
 * The League Desk's Live Scores board. Deliberately tiny: it fetches only
 * /fixtures/?event=N (a few KB), never bootstrap-static, and returns player
 * IDs rather than names — the app already has the player list from the bundle
 * and maps them itself. That keeps this cheap enough to poll.
 *
 * Cached at Vercel's edge for 45 seconds, so a room full of open tabs costs
 * FPL about one request a minute while still reading as live.
 */

import { fplGet, sendError } from "./_lib/fpl.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * FPL reports per-match events in `stats`, one block per identifier, each with
 * `h` and `a` arrays of `{ value, element }`. `value` is a count, so a hat-trick
 * is one entry with value 3.
 */
function pickStat(stats, identifier) {
  const block = (stats ?? []).find((s) => s.identifier === identifier);
  const side = (arr, team) => (arr ?? []).map((x) => ({ team, element: x.element, count: num(x.value) }));
  return block ? [...side(block.h, "h"), ...side(block.a, "a")] : [];
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const event = Number(req.query?.event);
  if (!Number.isInteger(event) || event < 1 || event > 38) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "event must be a gameweek number, 1-38" });
  }

  try {
    const raw = await fplGet(`/fixtures/?event=${event}`);
    const matches = (Array.isArray(raw) ? raw : []).map((f) => ({
      id: f.id,
      event: f.event,
      teamH: f.team_h,
      teamA: f.team_a,
      kickoff: f.kickoff_time ?? null,
      started: Boolean(f.started),
      // `finished_provisional` flips at full time; `finished` waits for bonus.
      finished: Boolean(f.finished || f.finished_provisional),
      bonusConfirmed: Boolean(f.finished),
      minutes: num(f.minutes),
      scoreH: f.team_h_score == null ? null : num(f.team_h_score),
      scoreA: f.team_a_score == null ? null : num(f.team_a_score),
      goals: pickStat(f.stats, "goals_scored"),
      assists: pickStat(f.stats, "assists"),
      ownGoals: pickStat(f.stats, "own_goals"),
    }));

    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.setHeader("Vercel-CDN-Cache-Control", "max-age=45, stale-while-revalidate=120");
    res.status(200).json({ event, generatedAt: new Date().toISOString(), source: "live", matches });
  } catch (err) {
    sendError(res, err);
  }
}
