import { expectedPoints, horizonXp, pointsStdDev } from "../model/xp";
import type { Player, Strategy, XpResult } from "../model/types";
import type { Candidate } from "../solver/lp";
import type { Dataset } from "./data";

export interface Projection {
  player: Player;
  /** xP for the next gameweek, summed across a double and zero on a blank. */
  xpNext: number;
  /** Decay-weighted xP for gameweeks 2..horizon. */
  xpFuture: number;
  /** Undecayed total across the whole horizon — the number worth showing. */
  xpHorizon: number;
  sigma: number;
  /** Detail for the next fixture, for the breakdown panel. */
  detail: XpResult | null;
  fixtures: number;
}

export function projectAll(ds: Dataset, strategy: Strategy): Projection[] {
  const { teamsById, fixturesByTeam, startEvent } = ds;
  const out: Projection[] = [];

  for (const player of ds.bundle.players) {
    const team = teamsById.get(player.teamId);
    if (!team) continue;
    const fixtures = fixturesByTeam.get(player.teamId) ?? [];

    const { total, perEvent } = horizonXp(
      player,
      team,
      teamsById,
      fixtures,
      strategy.horizon,
      strategy.decay,
      startEvent,
    );

    const xpNext = perEvent.get(startEvent) ?? 0;
    const xpFuture = total - xpNext;
    const xpHorizon = [...perEvent.values()].reduce((a, b) => a + b, 0);

    const nextFixture = fixtures.find((f) => f.event === startEvent);
    const opponent = nextFixture ? teamsById.get(nextFixture.opponentId) : undefined;
    const detail =
      nextFixture && opponent ? expectedPoints(player, team, opponent, nextFixture.home) : null;

    out.push({
      player,
      xpNext,
      xpFuture,
      xpHorizon,
      sigma: detail ? pointsStdDev(player, detail) : 0,
      detail,
      fixtures: fixtures.filter(
        (f) => f.event >= startEvent && f.event < startEvent + strategy.horizon,
      ).length,
    });
  }

  return out;
}

/**
 * Trims the candidate pool before it reaches the solver. 600+ players is fine
 * for HiGHS, but most of them are 4.0m bench fodder that can never be optimal;
 * keeping the best few per position-and-price band cuts solve time without
 * changing the answer, and keeps a genuine budget-enabler bench available.
 */
export function toCandidates(projections: Projection[], strategy: Strategy): Candidate[] {
  const forced = new Set(strategy.forceIn);
  const banned = new Set(strategy.forceOut);

  const buckets = new Map<string, Projection[]>();
  for (const p of projections) {
    if (banned.has(p.player.id)) continue;
    if (p.player.status === "u") continue; // unavailable — gone from the game
    const band = Math.floor(p.player.cost / 5); // 0.5m bands
    const key = `${p.player.pos}:${band}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(p);
  }

  const kept: Projection[] = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => b.xpHorizon - a.xpHorizon);
    kept.push(...list.slice(0, 8));
  }
  for (const p of projections) {
    if (forced.has(p.player.id) && !kept.includes(p)) kept.push(p);
  }

  return kept.map((p) => ({
    id: p.player.id,
    pos: p.player.pos,
    teamId: p.player.teamId,
    cost: p.player.cost,
    xpNext: round(p.xpNext),
    xpFuture: round(p.xpFuture),
    sigma: round(p.sigma),
    ownership: p.player.ownership,
  }));
}

const round = (n: number) => Number(n.toFixed(4));
