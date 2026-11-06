/**
 * League Desk data: the Premier League table, the top scorers and assisters,
 * and one gameweek's matches.
 *
 * All of it is derived, not fetched from a standings endpoint — FPL doesn't
 * publish one. The table is counted from finished fixtures (`bundle.results`),
 * which is exact: those carry the real scores. Goals and assists are season
 * totals that ride along on each player in the bundle.
 *
 * Kept free of React so it can be unit-tested on its own.
 */

import type { DataBundle, Player, Team } from "../model/types";

// ---------------------------------------------------------------------------
// League table
// ---------------------------------------------------------------------------

export interface TableRow {
  position: number;
  team: Team;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  /** Most recent first: "W" | "D" | "L", up to five. */
  form: string[];
}

const POINTS_WIN = 3;
const POINTS_DRAW = 1;

/**
 * Counts the table from played matches.
 *
 * Ordering is the one tables are printed in: points, goal difference, goals
 * scored, then name. (The league's own deeper tie-breaks — head-to-head, away
 * goals, a play-off — only ever matter for a title or a relegation place, and
 * never while the season is running.)
 */
export function leagueTable(bundle: Pick<DataBundle, "teams" | "results">): TableRow[] {
  const rows = new Map<number, Omit<TableRow, "position" | "team" | "goalDiff"> & { teamId: number }>();
  for (const t of bundle.teams) {
    rows.set(t.id, { teamId: t.id, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, points: 0, form: [] });
  }

  // Oldest first, so pushing onto `form` and then reversing gives most-recent-first.
  const played = [...(bundle.results ?? [])].sort(
    (a, b) => a.event - b.event || (a.kickoff ?? "").localeCompare(b.kickoff ?? ""),
  );

  for (const m of played) {
    const home = rows.get(m.teamH);
    const away = rows.get(m.teamA);
    if (!home || !away) continue; // a club not in this season's list — skip rather than invent a row

    home.played++;
    away.played++;
    home.goalsFor += m.scoreH;
    home.goalsAgainst += m.scoreA;
    away.goalsFor += m.scoreA;
    away.goalsAgainst += m.scoreH;

    if (m.scoreH > m.scoreA) {
      home.won++;
      away.lost++;
      home.points += POINTS_WIN;
      home.form.push("W");
      away.form.push("L");
    } else if (m.scoreH < m.scoreA) {
      away.won++;
      home.lost++;
      away.points += POINTS_WIN;
      away.form.push("W");
      home.form.push("L");
    } else {
      home.drawn++;
      away.drawn++;
      home.points += POINTS_DRAW;
      away.points += POINTS_DRAW;
      home.form.push("D");
      away.form.push("D");
    }
  }

  const byId = new Map(bundle.teams.map((t) => [t.id, t]));
  return [...rows.values()]
    .map((r) => {
      const team = byId.get(r.teamId)!;
      return { ...r, team, goalDiff: r.goalsFor - r.goalsAgainst, form: r.form.slice(-5).reverse(), position: 0 };
    })
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goalDiff - a.goalDiff ||
        b.goalsFor - a.goalsFor ||
        a.team.name.localeCompare(b.team.name),
    )
    .map((r, i) => ({ ...r, position: i + 1 }));
}

// ---------------------------------------------------------------------------
// Top scorers and assisters
// ---------------------------------------------------------------------------

export interface ScorerRow {
  /** Shared by players on the same total, so 1, 2, 2, 4 — as printed tables do. */
  rank: number;
  player: Player;
  team: Team | undefined;
  count: number;
  /** Rate per 90 minutes, for context. Null under half a match played. */
  per90: number | null;
}

const MIN_MINUTES_FOR_RATE = 45;

/**
 * The leading `limit` players by goals or assists.
 *
 * Early in a season dozens of players are level on two goals, so the list is
 * hard-capped rather than extended to keep a tie whole — that would print the
 * entire league. Ties are broken by minutes played (fewer first, the more
 * telling return) and then by name, so the order is stable between renders.
 * Players on the same total still share a position number.
 */
export function topBy(
  bundle: Pick<DataBundle, "players" | "teams">,
  field: "goals" | "assists",
  limit = 10,
): ScorerRow[] {
  const byId = new Map(bundle.teams.map((t) => [t.id, t]));
  return bundle.players
    .map((player) => ({ player, count: player[field] ?? 0 }))
    .filter((r) => r.count > 0)
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.player.minutes - b.player.minutes ||
        a.player.webName.localeCompare(b.player.webName),
    )
    .slice(0, limit)
    .map((r, i, all) => ({
      // 1, 2, 2, 4 — a shared total is a shared position.
      rank: i > 0 && r.count === all[i - 1].count ? -1 : i + 1,
      player: r.player,
      team: byId.get(r.player.teamId),
      count: r.count,
      per90: r.player.minutes >= MIN_MINUTES_FOR_RATE ? (r.count * 90) / r.player.minutes : null,
    }))
    .map((row, i, all) => {
      // Resolve the shared positions in a second pass, now that order is fixed.
      let rank = row.rank;
      for (let j = i; j >= 0 && rank === -1; j--) if (all[j].rank !== -1) rank = all[j].rank;
      return { ...row, rank: rank === -1 ? i + 1 : rank };
    });
}

// ---------------------------------------------------------------------------
// Live scores
// ---------------------------------------------------------------------------

export interface MatchEvent {
  team: "h" | "a";
  element: number;
  count: number;
}

export interface LiveMatch {
  id: number | null;
  event: number;
  teamH: number;
  teamA: number;
  kickoff: string | null;
  started: boolean;
  finished: boolean;
  bonusConfirmed: boolean;
  minutes: number;
  scoreH: number | null;
  scoreA: number | null;
  goals: MatchEvent[];
  assists: MatchEvent[];
  ownGoals: MatchEvent[];
}

export interface LiveBoard {
  event: number;
  generatedAt: string | null;
  /**
   * "live" = straight from FPL · "offline" = the service worker's last good
   * copy, which may be minutes or hours old · "bundle" = rebuilt from the data
   * snapshot, so final scores only.
   */
  source: "live" | "offline" | "bundle";
  matches: LiveMatch[];
}

/**
 * The fallback board, from the data snapshot alone: final scores for matches
 * that are over, kick-off times for the rest. No minute and no scorers — the
 * snapshot doesn't carry them. Used on GitHub Pages, in `npm run dev` (no
 * functions) and whenever /api/live can't be reached.
 */
export function boardFromBundle(bundle: DataBundle, event: number): LiveBoard {
  const done: LiveMatch[] = (bundle.results ?? [])
    .filter((r) => r.event === event)
    .map((r) => ({
      id: null,
      event,
      teamH: r.teamH,
      teamA: r.teamA,
      kickoff: r.kickoff ?? null,
      started: true,
      finished: true,
      bonusConfirmed: true,
      minutes: 90,
      scoreH: r.scoreH,
      scoreA: r.scoreA,
      goals: [],
      assists: [],
      ownGoals: [],
    }));

  const upcoming: LiveMatch[] = bundle.fixtures
    .filter((f) => f.event === event)
    .map((f) => ({
      id: null,
      event,
      teamH: f.teamH,
      teamA: f.teamA,
      kickoff: f.kickoff ?? null,
      started: false,
      finished: false,
      bonusConfirmed: false,
      minutes: 0,
      scoreH: null,
      scoreA: null,
      goals: [],
      assists: [],
      ownGoals: [],
    }));

  return { event, generatedAt: bundle.generatedAt ?? null, source: "bundle", matches: sortMatches([...done, ...upcoming]) };
}

export function sortMatches(matches: LiveMatch[]): LiveMatch[] {
  return [...matches].sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? "") || a.teamH - b.teamH);
}

/**
 * True while at least one match is being played — what decides whether to poll.
 * A cached board doesn't count: polling can't refresh what has no network.
 */
export function hasMatchInPlay(board: LiveBoard | null): boolean {
  if (board?.source === "offline") return false;
  return (board?.matches ?? []).some((m) => m.started && !m.finished);
}

/**
 * A match's status line. FPL reports elapsed minutes, so a game in the second
 * half reads "67'"; at 90 it waits for the finished flag rather than claiming
 * full time, because stoppage time still counts up.
 */
export function matchStatus(m: LiveMatch): { label: string; live: boolean } {
  if (m.finished) return { label: m.bonusConfirmed ? "FT" : "FT*", live: false };
  if (m.started) return { label: m.minutes > 0 ? `${m.minutes}'` : "LIVE", live: true };
  if (!m.kickoff) return { label: "TBC", live: false };
  const d = new Date(m.kickoff);
  if (Number.isNaN(d.getTime())) return { label: "TBC", live: false };
  return { label: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }), live: false };
}

/** Day heading for the match list, e.g. "Sat 7 Nov". */
export function matchDay(m: LiveMatch): string {
  if (!m.kickoff) return "Date to be confirmed";
  const d = new Date(m.kickoff);
  if (Number.isNaN(d.getTime())) return "Date to be confirmed";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * Fetches the live board, falling back to the snapshot. The caller passes the
 * bundle so a failure still produces a usable board rather than an error.
 */
export async function fetchBoard(bundle: DataBundle, event: number, signal?: AbortSignal): Promise<LiveBoard> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/live?event=${event}`, { cache: "no-cache", signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("json")) throw new Error("not json");
    const data = (await res.json()) as { matches?: LiveMatch[]; generatedAt?: string };
    if (!Array.isArray(data.matches) || data.matches.length === 0) throw new Error("no matches");
    // The service worker answers from its cache when the network is gone, and
    // tags it. Saying "live" over a stale copy would be the one real lie here.
    const source = res.headers.has("x-fd-offline") ? "offline" : "live";
    return { event, generatedAt: data.generatedAt ?? null, source, matches: sortMatches(data.matches) };
  } catch {
    return boardFromBundle(bundle, event);
  }
}
