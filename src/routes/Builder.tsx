import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataset } from "../lib/useDataset";
import { projectAll, toCandidates, type Projection } from "../lib/projections";
import { solveSquad, type SolvedSquad } from "../solver/client";
import { DEFAULT_STRATEGY, type Position, type Strategy } from "../model/types";
import { Card, Chip, Slider, StatTile, Waterfall } from "../components/ui";
import type { Candidate } from "../solver/lp";

const ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];
const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;

interface Solution {
  solved: SolvedSquad;
  candidates: Candidate[];
}

export default function Builder() {
  const state = useDataset();
  const [strategy, setStrategy] = useState<Strategy>(DEFAULT_STRATEGY);
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [solving, setSolving] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoRan = useRef(false);

  const set = <K extends keyof Strategy>(key: K, value: Strategy[K]) =>
    setStrategy((s) => ({ ...s, [key]: value }));

  const dataset = state.status === "ready" ? state.dataset : null;

  const projections = useMemo(
    () => (dataset ? projectAll(dataset, strategy) : []),
    [dataset, strategy],
  );

  const byId = useMemo(
    () => new Map(projections.map((p) => [p.player.id, p])),
    [projections],
  );

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
      setSolutions(outcome.solutions.map((solved) => ({ solved, candidates })));
      setMs(outcome.ms);
      setActive(0);
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The solver failed.");
    } finally {
      setSolving(false);
    }
  }, [dataset, projections, strategy]);

  // Solve once on first load so the page is never an empty shell.
  useEffect(() => {
    if (dataset && !autoRan.current) {
      autoRan.current = true;
      void run();
    }
  }, [dataset, run]);

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
            Run <code className="font-mono text-[12.5px] bg-surface-3 px-1.5 py-0.5 rounded">npm run fetch:data</code>{" "}
            locally, or let the scheduled GitHub Action publish one.
          </p>
        </Card>
      </Shell>
    );
  }

  const ds = state.dataset;
  const current = solutions[active];
  const squad = current
    ? current.solved.squad.map((i) => current.candidates[i]).filter(Boolean)
    : [];
  const xiSet = new Set(current?.solved.xi ?? []);
  const captainId =
    current?.solved.captain != null ? current.candidates[current.solved.captain]?.id : undefined;

  const spend = squad.reduce((a, c) => a + c.cost, 0);
  const xiXp = current
    ? current.solved.xi.reduce((a, i) => a + (current.candidates[i]?.xpNext ?? 0), 0)
    : 0;
  const horizonXp = squad.reduce((a, c) => a + (byId.get(c.id)?.xpHorizon ?? 0), 0);

  const selectedProjection = selected != null ? byId.get(selected) : null;

  return (
    <Shell>
      {ds.isSample && (
        <div className="mb-5 rounded-lg border border-loss/40 bg-loss-soft px-4 py-3 text-[13px]">
          <b className="font-semibold text-loss">Sample data.</b>{" "}
          <span className="text-ink-2">
            These clubs and players are invented, so the squads below are a demonstration of the
            machinery, not advice. Run the data workflow to replace this with the live league.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-5 items-start">
        {/* ------------------------------ controls ------------------------------ */}
        <Card className="lg:sticky lg:top-20 divide-y divide-[var(--border)]">
          <div className="px-4 py-3.5 flex items-center justify-between">
            <span className="eyebrow">Strategy</span>
            <Chip>GW {ds.startEvent}</Chip>
          </div>

          <div className="px-4 py-4 grid gap-4">
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
              id="budget" label="Budget" value={strategy.budget} min={900} max={1050} step={1}
              display={money(strategy.budget)} scale={["£90.0m", "£105.0m"]}
              onChange={(v) => set("budget", v)}
            />
            <Slider
              id="bank" label="Keep in the bank" value={strategy.minBank} min={0} max={50} step={1}
              display={money(strategy.minBank)} scale={["£0.0m", "£5.0m"]}
              onChange={(v) => set("minBank", v)}
            />
          </div>

          <div className="px-4 py-4 grid gap-4">
            <div className="eyebrow">Risk & rank</div>
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
              display={strategy.benchWeights[0].toFixed(2)}
              scale={["ignore bench", "bench boost"]}
              onChange={(v) =>
                set("benchWeights", [v, v * 0.55, v * 0.27] as [number, number, number])
              }
            />
          </div>

          <div className="px-4 py-4 grid gap-4">
            <div className="eyebrow">Alternatives</div>
            <Slider
              id="nsol" label="Squads to return" value={strategy.nSolutions} min={1} max={5}
              display={String(strategy.nSolutions)} onChange={(v) => set("nSolutions", v)}
            />
            <Slider
              id="mdiff" label="Must differ by" value={strategy.minDifference} min={1} max={6}
              display={`${strategy.minDifference} player${strategy.minDifference > 1 ? "s" : ""}`}
              onChange={(v) => set("minDifference", v)}
            />
          </div>

          {strategy.forceIn.length + strategy.forceOut.length > 0 && (
            <div className="px-4 py-4">
              <div className="eyebrow mb-2">Locks</div>
              <div className="flex flex-wrap gap-1.5">
                {strategy.forceIn.map((id) => (
                  <button key={`in${id}`} type="button" onClick={() => set("forceIn", strategy.forceIn.filter((x) => x !== id))}>
                    <Chip tone="accent">must start · {byId.get(id)?.player.webName ?? id} ✕</Chip>
                  </button>
                ))}
                {strategy.forceOut.map((id) => (
                  <button key={`out${id}`} type="button" onClick={() => set("forceOut", strategy.forceOut.filter((x) => x !== id))}>
                    <Chip tone="loss">excluded · {byId.get(id)?.player.webName ?? id} ✕</Chip>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="px-4 py-4">
            <button
              type="button"
              onClick={() => void run()}
              disabled={solving}
              className="w-full rounded-md bg-accent text-accent-ink font-medium text-[14px] py-2.5 hover:opacity-90 disabled:opacity-55 transition-opacity"
            >
              {solving ? "Solving…" : "Optimise squad"}
            </button>
            <p className="text-[11.5px] text-ink-muted mt-2 text-center tnum">
              {error
                ? <span className="text-loss">{error}</span>
                : ms != null
                  ? `HiGHS · ${solutions.length} squad${solutions.length === 1 ? "" : "s"} · ${ms} ms`
                  : " "}
            </p>
          </div>
        </Card>

        {/* ------------------------------- results ------------------------------- */}
        <div className="grid gap-5">
          {solutions.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {solutions.map((s, i) => {
                const diff =
                  i === 0
                    ? 0
                    : 15 -
                      s.solved.squad.filter((x) => solutions[0].solved.squad.includes(x)).length;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => { setActive(i); setSelected(null); }}
                    className={[
                      "rounded-md border px-3 py-2 text-left transition-colors",
                      i === active
                        ? "border-accent bg-accent-soft"
                        : "border-line hover:bg-surface-2",
                    ].join(" ")}
                  >
                    <div className="text-[12.5px] font-medium">
                      {i === 0 ? "Optimal" : `Alternative ${i}`}
                    </div>
                    <div className="font-mono text-[11px] text-ink-muted tnum">
                      {s.solved.objective.toFixed(2)} obj
                      {i > 0 && ` · ${diff} changed`}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <Card>
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-[var(--border)] border-b border-line">
              <StatTile label="Spend" value={money(spend)} hint={`${money(strategy.budget - spend)} free`} />
              <StatTile label="XI xP · GW" value={xiXp.toFixed(1)} hint="starters only" />
              <StatTile
                label="Squad xP"
                value={horizonXp.toFixed(0)}
                hint={`all 15, ${strategy.horizon} GW`}
              />
              <StatTile
                label="Clubs"
                value={String(new Set(squad.map((c) => c.teamId)).size)}
                hint={`max ${strategy.maxPerClub} each`}
              />
            </div>

            <div className="p-4 grid gap-3">
              {ORDER.map((pos) => {
                const rows = squad
                  .map((c, idx) => ({ c, idx: current!.solved.squad[idx] }))
                  .filter(({ c }) => c.pos === pos)
                  .sort((a, b) => Number(xiSet.has(b.idx)) - Number(xiSet.has(a.idx)) || b.c.xpNext - a.c.xpNext);
                if (!rows.length) return null;
                return (
                  <div key={pos}>
                    <div className="eyebrow mb-1.5">{pos}</div>
                    <div className="grid gap-1">
                      {rows.map(({ c, idx }) => {
                        const p = byId.get(c.id);
                        const starting = xiSet.has(idx);
                        const team = ds.teamsById.get(c.teamId);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setSelected(selected === c.id ? null : c.id)}
                            aria-expanded={selected === c.id}
                            className={[
                              "w-full text-left grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 border transition-colors",
                              selected === c.id
                                ? "border-accent bg-accent-soft"
                                : starting
                                  ? "border-line hover:bg-surface-2"
                                  : "border-transparent bg-surface-2/60 hover:bg-surface-2",
                            ].join(" ")}
                          >
                            <div className="min-w-0">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="text-[13.5px] font-medium truncate">
                                  {p?.player.webName ?? c.id}
                                </span>
                                {c.id === captainId && <Chip tone="accent">C</Chip>}
                                {!starting && <Chip>bench</Chip>}
                                <span className="font-mono text-[11px] text-ink-muted">
                                  {team?.short ?? "—"}
                                </span>
                                {p && p.fixtures !== strategy.horizon && (
                                  <span className="font-mono text-[11px] text-ink-muted">
                                    {p.fixtures} fix
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-mono text-[14px] tnum">{c.xpNext.toFixed(2)}</div>
                              <div className="font-mono text-[10.5px] text-ink-muted tnum">
                                {money(c.cost)}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {selectedProjection && <Breakdown projection={selectedProjection} strategy={strategy} onLock={set} />}
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
  if (!detail) {
    return (
      <Card className="p-4">
        <p className="text-[13px] text-ink-2">
          {player.webName} has no fixture in gameweek — a blank. They contribute nothing this week,
          which is exactly why the optimiser kept them cheap.
        </p>
      </Card>
    );
  }
  const b = detail.breakdown;
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
          <button
            type="button"
            onClick={() =>
              onLock(
                "forceIn",
                locked
                  ? strategy.forceIn.filter((x) => x !== player.id)
                  : [...strategy.forceIn, player.id],
              )
            }
            className="font-mono text-[11px] uppercase tracking-wide border border-line-strong rounded px-2 py-1 hover:bg-surface-2"
          >
            {locked ? "Unlock" : "Lock in"}
          </button>
          <button
            type="button"
            onClick={() =>
              onLock(
                "forceOut",
                banned
                  ? strategy.forceOut.filter((x) => x !== player.id)
                  : [...strategy.forceOut, player.id],
              )
            }
            className="font-mono text-[11px] uppercase tracking-wide border border-line-strong rounded px-2 py-1 hover:bg-surface-2"
          >
            {banned ? "Allow" : "Exclude"}
          </button>
        </div>
      </div>

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
            ["Appearance", b.appearance],
            ["Attacking", b.attacking],
            ["Clean sheet", b.cleanSheet],
            ["Conceded", b.conceded],
            ["DEFCON", b.defcon],
            ["Saves", b.saves],
            ["Bonus", b.bonus],
            ["Discipline", b.discipline],
          ]}
          total={detail.xp}
        />
      </div>
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
          The optimiser picks the 15, the starting XI and the captain, subject to every FPL rule.
          Change a parameter and re-solve — the point is to see which constraints are actually
          binding, not to be handed one answer.
        </p>
      </div>
      {children}
    </div>
  );
}
