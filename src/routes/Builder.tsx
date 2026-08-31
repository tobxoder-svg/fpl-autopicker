import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataset } from "../lib/useDataset";
import { projectAll, toCandidates, type Projection } from "../lib/projections";
import { solveSquad } from "../solver/client";
import { DEFAULT_STRATEGY, type Strategy, type Team } from "../model/types";
import { Card, Chip, Slider, StatTile, Waterfall } from "../components/ui";
import Pitch, { type PitchPlayer } from "../components/Pitch";
import {
  formationOf,
  fromSolution,
  hasDiverged,
  setCaptain,
  swap,
  type SquadState,
} from "../lib/squad";

const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;

/** Solver output, converted from candidate indices to player ids at the edge. */
interface Solution {
  squadIds: number[];
  xiIds: number[];
  captainId: number | null;
  objective: number;
}

/**
 * Fixture difficulty on the familiar 1–5 scale, but derived from this model's
 * own team ratings rather than the official one — which means it agrees with
 * the projections shown beside it.
 */
function difficultyOf(opponent: Team): number {
  const s = (opponent.attack + (1.6 - opponent.defence)) / 2;
  if (s < 0.68) return 1;
  if (s < 0.76) return 2;
  if (s < 0.84) return 3;
  if (s < 0.94) return 4;
  return 5;
}

export default function Builder() {
  const state = useDataset();
  const [strategy, setStrategy] = useState<Strategy>(DEFAULT_STRATEGY);
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [active, setActive] = useState(0);
  const [squad, setSquad] = useState<SquadState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [solving, setSolving] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const optimal = useRef<SquadState | null>(null);
  const autoRan = useRef(false);

  const set = <K extends keyof Strategy>(key: K, value: Strategy[K]) =>
    setStrategy((s) => ({ ...s, [key]: value }));

  const dataset = state.status === "ready" ? state.dataset : null;

  const projections = useMemo(
    () => (dataset ? projectAll(dataset, strategy) : []),
    [dataset, strategy],
  );
  const byId = useMemo(() => new Map(projections.map((p) => [p.player.id, p])), [projections]);

  const run = useCallback(async () => {
    if (!dataset) return;
    setSolving(true);
    setError(null);
    try {
      const candidates = toCandidates(projections, strategy);
      const benchWeight =
        (strategy.benchWeights[0] + strategy.benchWeights[1] + strategy.benchWeights[2]) / 3;
      const outcome = await solveSquad(
        candidates,
        {
          budget: strategy.budget,
          minBank: strategy.minBank,
          maxPerClub: strategy.maxPerClub,
          benchWeight,
          benchGkWeight: strategy.benchGkWeight,
          startShare: 0.85,
          riskLambda: strategy.riskLambda,
          ownershipWeight: strategy.ownershipWeight,
          forceIn: strategy.forceIn,
          forceOut: strategy.forceOut,
        },
        strategy.nSolutions,
        strategy.minDifference,
      );
      setSolutions(
        outcome.solutions.map((s) => ({
          squadIds: s.squad.map((i) => candidates[i].id),
          xiIds: s.xi.map((i) => candidates[i].id),
          captainId: s.captain != null ? candidates[s.captain].id : null,
          objective: s.objective,
        })),
      );
      setMs(outcome.ms);
      setActive(0);
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The solver failed.");
    } finally {
      setSolving(false);
    }
  }, [dataset, projections, strategy]);

  useEffect(() => {
    if (dataset && !autoRan.current) {
      autoRan.current = true;
      void run();
    }
  }, [dataset, run]);

  // Rebuild the editable squad whenever the solver answers or the user switches
  // to a different alternative.
  useEffect(() => {
    const solution = solutions[active];
    if (!solution) return;
    const next = fromSolution(
      solution.squadIds,
      solution.xiIds,
      solution.captainId,
      (id) => byId.get(id)?.player.pos,
      (id) => byId.get(id)?.xpNext ?? 0,
    );
    setSquad(next);
    optimal.current = next;
    // byId changes on every strategy tweak; the squad should only reset on a
    // new solve, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solutions, active]);

  const pitchPlayers = useMemo(() => {
    const map = new Map<number, PitchPlayer>();
    if (!dataset || !squad) return map;
    for (const id of squad.squad) {
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
  }, [byId, dataset, squad]);

  const onSwap = useCallback(
    (a: number, b: number) => {
      setSquad((prev) => {
        if (!prev) return prev;
        const result = swap(prev, a, b, (id) => byId.get(id)?.player.pos);
        if (!result.ok || !result.next) {
          setNotice(result.reason ?? null);
          window.setTimeout(() => setNotice(null), 2600);
          return prev;
        }
        setNotice(null);
        return result.next;
      });
    },
    [byId],
  );

  if (state.status === "loading") {
    return <Shell><p className="text-ink-2">Loading the data snapshot…</p></Shell>;
  }
  if (state.status === "error") {
    return (
      <Shell>
        <Card className="p-6 max-w-xl">
          <h2 className="text-lg font-semibold mb-2">No data snapshot yet</h2>
          <p className="text-[13.5px] text-ink-2 mb-3">{state.message}</p>
          <p className="text-[13.5px] text-ink-2">
            Run <code className="font-mono text-[12.5px] bg-surface-3 px-1.5 py-0.5 rounded">npm run fetch:data</code>,
            or let the scheduled workflow publish one.
          </p>
        </Card>
      </Shell>
    );
  }

  const ds = state.dataset;
  const posOf = (id: number) => byId.get(id)?.player.pos;

  const spend = squad ? squad.squad.reduce((a, id) => a + (byId.get(id)?.player.cost ?? 0), 0) : 0;
  const xiXp = squad ? squad.xi.reduce((a, id) => a + (byId.get(id)?.xpNext ?? 0), 0) : 0;
  const captainXp = squad?.captain ? (byId.get(squad.captain)?.xpNext ?? 0) : 0;
  const horizonXp = squad
    ? squad.squad.reduce((a, id) => a + (byId.get(id)?.xpHorizon ?? 0), 0)
    : 0;
  const diverged = squad && optimal.current ? hasDiverged(squad, optimal.current) : false;
  const selectedProjection = selected != null ? byId.get(selected) : null;

  return (
    <Shell>
      {ds.isSample && (
        <div className="mb-5 rounded-lg border border-loss/40 bg-loss-soft px-4 py-3 text-[13px]">
          <b className="font-semibold text-loss">Sample data.</b>{" "}
          <span className="text-ink-2">
            These clubs and players are invented, so the squad below demonstrates the machinery
            rather than advising anything. A build with network access replaces it with the live
            league.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,470px)_minmax(0,1fr)] gap-5 items-start">
        {/* ------------------------------------------------------- the pitch */}
        <div className="grid gap-3">
          {solutions.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {solutions.map((s, i) => {
                const changed =
                  i === 0
                    ? 0
                    : 15 - s.squadIds.filter((id) => solutions[0].squadIds.includes(id)).length;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => { setActive(i); setSelected(null); }}
                    className={[
                      "rounded-md border px-3 py-1.5 text-left transition-colors",
                      i === active ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2",
                    ].join(" ")}
                  >
                    <span className="text-[12.5px] font-medium">
                      {i === 0 ? "Optimal" : `Alt ${i}`}
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-muted tnum ml-2">
                      {s.objective.toFixed(1)}
                      {i > 0 && ` · ${changed} changed`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <Card className="overflow-hidden">
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-[var(--border)] border-b border-line">
              <StatTile
                label="Formation"
                value={squad ? formationOf(squad.xi, posOf) : "—"}
                hint={`GW ${ds.startEvent}`}
              />
              <StatTile label="Cost" value={money(spend)} hint={`of ${money(strategy.budget)}`} />
              <StatTile label="Bank" value={money(strategy.budget - spend)} hint="unspent" />
              <StatTile
                label="xPts"
                value={(xiXp + captainXp).toFixed(1)}
                hint="XI + captain"
              />
            </div>

            {squad && (
              <Pitch
                players={pitchPlayers}
                state={squad}
                selectedId={selected}
                onSwap={onSwap}
                onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
                onCaptain={(id) =>
                  setSquad((prev) => (prev ? setCaptain(prev, id) : prev))
                }
              />
            )}
          </Card>

          <div className="flex items-center gap-3 flex-wrap min-h-[24px]">
            <p className="text-[12px] text-ink-muted">
              Drag a player onto another to swap. Tap to inspect, <b className="font-semibold">C</b> to captain.
            </p>
            {notice && (
              <span className="text-[12px] text-loss" role="status">
                Can't do that — {notice}.
              </span>
            )}
            {diverged && (
              <button
                type="button"
                onClick={() => optimal.current && setSquad(optimal.current)}
                className="ml-auto font-mono text-[11px] uppercase tracking-wide border border-line-strong rounded px-2 py-1 hover:bg-surface-2"
              >
                Reset to optimal
              </button>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------ right rail */}
        <div className="grid gap-5">
          <Card className="divide-y divide-[var(--border)]">
            <div className="px-4 py-3.5 flex items-center justify-between">
              <span className="eyebrow">Strategy</span>
              <button
                type="button"
                onClick={() => void run()}
                disabled={solving}
                className="rounded-md bg-accent text-accent-ink font-medium text-[13px] px-4 py-1.5 hover:opacity-90 disabled:opacity-55 transition-opacity"
              >
                {solving ? "Solving…" : "Optimise"}
              </button>
            </div>

            <div className="px-4 py-4 grid sm:grid-cols-2 gap-4">
              <Slider
                id="horizon" label="Horizon" value={strategy.horizon} min={1} max={8}
                display={`${strategy.horizon} GW`} scale={["1", "8"]}
                onChange={(v) => set("horizon", v)}
              />
              <Slider
                id="decay" label="Per-gameweek decay" value={strategy.decay} min={0.6} max={1} step={0.01}
                display={strategy.decay.toFixed(2)} scale={["short-term", "flat"]}
                onChange={(v) => set("decay", v)}
              />
              <Slider
                id="budget" label="Budget" value={strategy.budget} min={900} max={1050}
                display={money(strategy.budget)} scale={["£90.0m", "£105.0m"]}
                onChange={(v) => set("budget", v)}
              />
              <Slider
                id="bank" label="Keep in the bank" value={strategy.minBank} min={0} max={50}
                display={money(strategy.minBank)} scale={["£0.0m", "£5.0m"]}
                onChange={(v) => set("minBank", v)}
              />
            </div>

            <div className="px-4 py-4 grid sm:grid-cols-2 gap-4">
              <Slider
                id="risk" label="Risk aversion" value={strategy.riskLambda} min={0} max={1.5} step={0.05}
                display={strategy.riskLambda.toFixed(2)} scale={["chase upside", "protect floor"]}
                onChange={(v) => set("riskLambda", v)}
              />
              <Slider
                id="own" label="Ownership pull" value={strategy.ownershipWeight} min={-2} max={2} step={0.1}
                display={
                  strategy.ownershipWeight === 0
                    ? "neutral"
                    : strategy.ownershipWeight > 0
                      ? `template +${strategy.ownershipWeight.toFixed(1)}`
                      : `differential ${strategy.ownershipWeight.toFixed(1)}`
                }
                scale={["differential", "template"]}
                onChange={(v) => set("ownershipWeight", v)}
              />
              <Slider
                id="bench" label="Bench weight" value={strategy.benchWeights[0]} min={0} max={0.5} step={0.01}
                display={strategy.benchWeights[0].toFixed(2)} scale={["ignore bench", "bench boost"]}
                onChange={(v) => set("benchWeights", [v, v * 0.55, v * 0.27] as [number, number, number])}
              />
              <Slider
                id="nsol" label="Alternatives" value={strategy.nSolutions} min={1} max={5}
                display={String(strategy.nSolutions)} scale={["1", "5"]}
                onChange={(v) => set("nSolutions", v)}
              />
            </div>

            {strategy.forceIn.length + strategy.forceOut.length > 0 && (
              <div className="px-4 py-3">
                <div className="eyebrow mb-2">Locks</div>
                <div className="flex flex-wrap gap-1.5">
                  {strategy.forceIn.map((id) => (
                    <button key={`in${id}`} type="button"
                      onClick={() => set("forceIn", strategy.forceIn.filter((x) => x !== id))}>
                      <Chip tone="accent">must start · {byId.get(id)?.player.webName ?? id} ✕</Chip>
                    </button>
                  ))}
                  {strategy.forceOut.map((id) => (
                    <button key={`out${id}`} type="button"
                      onClick={() => set("forceOut", strategy.forceOut.filter((x) => x !== id))}>
                      <Chip tone="loss">excluded · {byId.get(id)?.player.webName ?? id} ✕</Chip>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="px-4 py-2.5">
              <p className="text-[11.5px] text-ink-muted tnum">
                {error ? (
                  <span className="text-loss">{error}</span>
                ) : ms != null ? (
                  `HiGHS · ${solutions.length} squad${solutions.length === 1 ? "" : "s"} · ${ms} ms · squad xP ${horizonXp.toFixed(0)} over ${strategy.horizon} GW`
                ) : (
                  " "
                )}
              </p>
            </div>
          </Card>

          {selectedProjection ? (
            <Breakdown projection={selectedProjection} strategy={strategy} onLock={set} />
          ) : (
            <Card className="px-4 py-6">
              <p className="text-[13px] text-ink-2">
                Select a player on the pitch to see their expected points broken into the eight
                model components, and to lock them in or rule them out of the next solve.
              </p>
            </Card>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Breakdown({
  projection,
  strategy,
  onLock,
}: {
  projection: Projection;
  strategy: Strategy;
  onLock: <K extends keyof Strategy>(key: K, value: Strategy[K]) => void;
}) {
  const { player, detail } = projection;
  const locked = strategy.forceIn.includes(player.id);
  const banned = strategy.forceOut.includes(player.id);

  return (
    <Card>
      <div className="px-4 py-3.5 border-b border-line flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-[18px] font-semibold">{player.name}</h2>
        <span className="text-[12.5px] text-ink-2">
          {player.pos} · {money(player.cost)} · {player.ownership.toFixed(1)}% owned
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button"
            onClick={() => onLock("forceIn", locked ? strategy.forceIn.filter((x) => x !== player.id) : [...strategy.forceIn, player.id])}
            className="font-mono text-[11px] uppercase tracking-wide border border-line-strong rounded px-2 py-1 hover:bg-surface-2">
            {locked ? "Unlock" : "Lock in"}
          </button>
          <button type="button"
            onClick={() => onLock("forceOut", banned ? strategy.forceOut.filter((x) => x !== player.id) : [...strategy.forceOut, player.id])}
            className="font-mono text-[11px] uppercase tracking-wide border border-line-strong rounded px-2 py-1 hover:bg-surface-2">
            {banned ? "Allow" : "Exclude"}
          </button>
        </div>
      </div>

      {!detail ? (
        <p className="px-4 py-5 text-[13px] text-ink-2">
          {player.webName} has no fixture this gameweek — a blank. They contribute nothing here,
          which is exactly why the optimiser is happy to leave them on the bench.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-[var(--border)] border-b border-line">
            <StatTile label="Exp. minutes" value={detail.xmins.toFixed(0)} />
            <StatTile label="P(clean sheet)" value={`${(detail.pCleanSheet * 100).toFixed(0)}%`} />
            <StatTile
              label="P(DEFCON)"
              value={player.pos === "GK" ? "n/a" : `${(detail.pDefcon * 100).toFixed(0)}%`}
              hint={player.pos === "GK" ? undefined : `${detail.expActions.toFixed(1)} actions`}
            />
            <StatTile label={`xP · ${strategy.horizon} GW`} value={projection.xpHorizon.toFixed(1)} />
          </div>
          <div className="p-4">
            <Waterfall
              items={[
                ["Appearance", detail.breakdown.appearance],
                ["Attacking", detail.breakdown.attacking],
                ["Clean sheet", detail.breakdown.cleanSheet],
                ["Conceded", detail.breakdown.conceded],
                ["DEFCON", detail.breakdown.defcon],
                ["Saves", detail.breakdown.saves],
                ["Bonus", detail.breakdown.bonus],
                ["Discipline", detail.breakdown.discipline],
              ]}
              total={detail.xp}
            />
          </div>
        </>
      )}
    </Card>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[1180px] mx-auto px-5 py-7">
      <div className="mb-5">
        <h1 className="font-display text-[clamp(24px,3.5vw,32px)] font-bold tracking-tight">
          Squad builder
        </h1>
        <p className="text-[13.5px] text-ink-2 mt-1 max-w-[62ch]">
          The optimiser picks the fifteen, the starting eleven and the captain, subject to every FPL
          rule. Rearrange it by hand afterwards — the formation rules are enforced as you drag, so an
          illegal side cannot be built.
        </p>
      </div>
      {children}
    </div>
  );
}
