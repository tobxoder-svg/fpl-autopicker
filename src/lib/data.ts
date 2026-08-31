import type { DataBundle, Player, Team, TeamFixture } from "../model/types";

export interface Dataset {
  bundle: DataBundle;
  teamsById: Map<number, Team>;
  playersById: Map<number, Player>;
  /** Upcoming fixtures per club, ascending by gameweek. Doubles appear twice. */
  fixturesByTeam: Map<number, TeamFixture[]>;
  isSample: boolean;
  startEvent: number;
}

export async function loadDataset(): Promise<Dataset> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/bundle.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`No data snapshot found (HTTP ${res.status}).`);
  const bundle = (await res.json()) as DataBundle;
  return indexBundle(bundle);
}

export function indexBundle(bundle: DataBundle): Dataset {
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
  };
}

/** How many fixtures a club has in a given gameweek: 0 = blank, 2 = double. */
export function fixtureCount(ds: Dataset, teamId: number, event: number): number {
  return (ds.fixturesByTeam.get(teamId) ?? []).filter((f) => f.event === event).length;
}
