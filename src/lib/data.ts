import type { DataBundle, Player, Team, TeamFixture } from "../model/types";

export interface Dataset {
  bundle: DataBundle;
  teamsById: Map<number, Team>;
  playersById: Map<number, Player>;
  /** Upcoming fixtures per club, ascending by gameweek. Doubles appear twice. */
  fixturesByTeam: Map<number, TeamFixture[]>;
  isSample: boolean;
  startEvent: number;
  /**
   * live = built from the FPL API just now (via /api/bundle); snapshot = the
   * committed file; offline = the last copy the service worker kept.
   */
  source: "live" | "snapshot" | "offline";
}

const LIVE_TIMEOUT_MS = 8000;

/**
 * Live first, snapshot second. /api/bundle exists only on Vercel; on GitHub
 * Pages, in `npm run dev`, offline, or when FPL is mid-update it fails fast and
 * the committed snapshot takes over, so the app always opens.
 */
export async function loadDataset(): Promise<Dataset> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIVE_TIMEOUT_MS);
    const res = await fetch(`${import.meta.env.BASE_URL}api/bundle`, { signal: ctrl.signal });
    clearTimeout(timer);
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.includes("json")) {
      const bundle = (await res.json()) as DataBundle;
      if (bundle.players?.length) return indexBundle(bundle, res.headers.has("x-fd-offline") ? "offline" : "live");
    }
  } catch {
    /* fall through to the snapshot */
  }
  const res = await fetch(`${import.meta.env.BASE_URL}data/bundle.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`No data snapshot found (HTTP ${res.status}).`);
  const bundle = (await res.json()) as DataBundle;
  return indexBundle(bundle, res.headers.has("x-fd-offline") ? "offline" : "snapshot");
}

export function indexBundle(bundle: DataBundle, source: Dataset["source"] = "snapshot"): Dataset {
  const teamsById = new Map(bundle.teams.map((t) => [t.id, t]));
  const playersById = new Map(bundle.players.map((p) => [p.id, p]));

  const fixturesByTeam = new Map<number, TeamFixture[]>();
  for (const t of bundle.teams) fixturesByTeam.set(t.id, []);
  for (const f of bundle.fixtures) {
    if (f.event === null || f.finished) continue;
    fixturesByTeam.get(f.teamH)?.push({ event: f.event, opponentId: f.teamA, home: true });
    fixturesByTeam.get(f.teamA)?.push({ event: f.event, opponentId: f.teamH, home: false });
  }
  for (const list of fixturesByTeam.values()) list.sort((a, b) => a.event - b.event);

  const startEvent =
    bundle.nextEvent ??
    Math.min(
      ...[...fixturesByTeam.values()].flatMap((l) => (l.length ? [l[0].event] : [38])),
    );

  return {
    bundle,
    teamsById,
    playersById,
    fixturesByTeam,
    isSample: bundle.season === "sample",
    startEvent: Number.isFinite(startEvent) ? startEvent : 1,
    source,
  };
}

/** How many fixtures a club has in a given gameweek: 0 = blank, 2 = double. */
export function fixtureCount(ds: Dataset, teamId: number, event: number): number {
  return (ds.fixturesByTeam.get(teamId) ?? []).filter((f) => f.event === event).length;
}
