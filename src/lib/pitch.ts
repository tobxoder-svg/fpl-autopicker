import type { PitchPlayer } from "../components/Pitch";
import type { Team } from "../model/types";
import type { Dataset } from "./data";
import type { Projection } from "./projections";

/**
 * Fixture difficulty on the familiar 1–5 scale, but derived from this model's
 * own team ratings rather than the official one — which means it agrees with
 * the projections shown beside it.
 */
export function difficultyOf(opponent: Team): number {
  const s = (opponent.attack + (1.6 - opponent.defence)) / 2;
  if (s < 0.68) return 1;
  if (s < 0.76) return 2;
  if (s < 0.84) return 3;
  if (s < 0.94) return 4;
  return 5;
}

/** Everything the pitch needs to draw these players for the next gameweek. */
export function pitchPlayersFor(
  ids: number[],
  dataset: Dataset,
  byId: Map<number, Projection>,
): Map<number, PitchPlayer> {
  const map = new Map<number, PitchPlayer>();
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    const team = dataset.teamsById.get(p.player.teamId);
    const fixtures = (dataset.fixturesByTeam.get(p.player.teamId) ?? []).filter(
      (f) => f.event === dataset.startEvent,
    );
    const opponents = fixtures.map((f) => dataset.teamsById.get(f.opponentId));
    map.set(id, {
      id,
      name: p.player.webName,
      pos: p.player.pos,
      teamId: p.player.teamId,
      teamShort: team?.short ?? "—",
      cost: p.player.cost,
      xp: p.xpNext,
      fixture: fixtures
        .map((f, i) => `${opponents[i]?.short ?? "?"} (${f.home ? "H" : "A"})`)
        .join(" · "),
      difficulty: opponents[0] ? difficultyOf(opponents[0]) : null,
    });
  }
  return map;
}
