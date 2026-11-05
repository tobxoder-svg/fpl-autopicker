/**
 * GET /api/entry?id=1234567 — a manager's squad from public endpoints only.
 *
 * No login: entry/{id}/, entry/{id}/history/ and entry/{id}/event/{gw}/picks/
 * are all public, so no password or refresh token ever reaches the phone or
 * this proxy. The cost of that choice, surfaced in the UI:
 *   - the squad is as of the LAST deadline (transfers made since are invisible)
 *   - selling prices are private, so budgets use current prices
 *   - free transfers are an estimate from the transfer history
 */

import { fplGet, sendError, UpstreamError } from "./_lib/fpl.js";

const FT_CAP = 5;
const POS = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

/**
 * Free transfers available for the next deadline, replayed from history.
 * One FT from GW2, +1 after every gameweek, capped at 5; transfers made under
 * a Wildcard or Free Hit don't consume any (and the bank is kept since 2024/25).
 * Special one-off top-ups FPL sometimes grants are not modelled — hence "estimate".
 */
export function estimateFreeTransfers(history) {
  const rows = [...(history?.current ?? [])].sort((a, b) => a.event - b.event);
  if (!rows.length) return 1;
  const chipsByEvent = new Map((history?.chips ?? []).map((c) => [c.event, c.name]));
  let ft = 0;
  for (const row of rows) {
    const chip = chipsByEvent.get(row.event);
    const first = row === rows[0];
    if (!first && chip !== "wildcard" && chip !== "freehit") {
      const paid = Math.round((row.event_transfers_cost ?? 0) / 4);
      const freeUsed = Math.max(0, (row.event_transfers ?? 0) - paid);
      ft = Math.max(0, ft - freeUsed);
    }
    ft = Math.min(FT_CAP, ft + 1);   // +1 rolls in after each deadline
  }
  return ft;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const id = String(req.query?.id ?? "");
  if (!/^\d{1,9}$/.test(id)) return res.status(400).json({ error: "Team ID must be a number" });

  try {
    const [entry, history, boot] = await Promise.all([
      fplGet(`/entry/${id}/`),
      fplGet(`/entry/${id}/history/`),
      fplGet("/bootstrap-static/"),
    ]);
    const event = entry.current_event;
    if (!event) throw new UpstreamError("This team has not played a gameweek yet", 404);
    const picks = await fplGet(`/entry/${id}/event/${event}/picks/`);

    // A Free Hit squad reverts after its gameweek; the squad that carries into
    // the next deadline is the one from the gameweek before.
    let squadPicks = picks;
    let squadEvent = event;
    if (picks.active_chip === "freehit" && event > 1) {
      squadPicks = await fplGet(`/entry/${id}/event/${event - 1}/picks/`);
      squadEvent = event - 1;
    }

    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.setHeader("Vercel-CDN-Cache-Control", "max-age=300, stale-while-revalidate=900");
    res.status(200).json({
      id: entry.id,
      teamName: entry.name,
      managerName: `${entry.player_first_name ?? ""} ${entry.player_last_name ?? ""}`.trim(),
      overallRank: entry.summary_overall_rank ?? null,
      overallPoints: entry.summary_overall_points ?? null,
      event,
      squadEvent,
      bank: picks.entry_history?.bank ?? entry.last_deadline_bank ?? 0,
      value: picks.entry_history?.value ?? entry.last_deadline_value ?? null,
      freeTransfersEstimate: estimateFreeTransfers(history),
      chipsUsed: (history.chips ?? []).map((c) => ({ name: c.name, event: c.event })),
      picks: squadPicks.picks.map((p) => ({
        element: p.element,
        position: p.position,
        isCaptain: !!p.is_captain,
        isVice: !!p.is_vice_captain,
      })),
      // Price, position and club for each squad player — the Autopilot tab needs
      // them for a player the projection data leaves out (injured, never played).
      players: squadPicks.picks.map((p) => {
        const el = (boot.elements ?? []).find((e) => e.id === p.element) ?? {};
        return {
          id: p.element,
          webName: el.web_name ?? `#${p.element}`,
          pos: POS[el.element_type] ?? "MID",
          teamId: el.team ?? 0,
          nowCost: el.now_cost ?? 0,
          status: el.status ?? "a",
        };
      }),
    });
  } catch (err) {
    if (err.status === 404 && /^Not found: \/entry\/\d+\/$/.test(err.message)) {
      err.message = `No FPL team with ID ${id}`;
    }
    sendError(res, err);
  }
}
