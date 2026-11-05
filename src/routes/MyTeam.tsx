import { useCallback, useEffect, useMemo, useState } from "react";
import { useDataset } from "../lib/useDataset";
import { projectAll, toCandidates } from "../lib/projections";
import { solveSquad } from "../solver/client";
import { DEFAULT_STRATEGY, type Position } from "../model/types";
import { Card, Chip, StatTile } from "../components/ui";
import Pitch from "../components/Pitch";
import { pitchPlayersFor } from "../lib/pitch";
import { formationOf, fromSolution, setCaptain, swap, type SquadState } from "../lib/squad";
import { fetchEntry, ID_KEY, readStore, writeStore, type Loaded } from "../lib/entry";

const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;
const MAX_TRANSFERS = 3;
const HIT = 4;
const POS_ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];

interface Option {
  transfers: Array<{ pos: Position; out: number; in: number }>;
  squadIds: number[];
  xiIds: number[];
  captainId: number | null;
  gain: number;
  hits: number;
  net: number;
}

export default function MyTeam() {
  const state = useDataset();
  const dataset = state.status === "ready" ? state.dataset : null;
  const strategy = DEFAULT_STRATEGY;

  const [teamId, setTeamId] = useState<string>(() => readStore<string>(ID_KEY) ?? "");
  const [draftId, setDraftId] = useState(teamId);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ft, setFt] = useState(1);
  const [options, setOptions] = useState<Option[]>([]);
  const [solving, setSolving] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [squad, setSquad] = useState<SquadState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const projections = useMemo(() => (dataset ? projectAll(dataset, strategy) : []), [dataset, strategy]);
  const byId = useMemo(() => new Map(projections.map((p) => [p.player.id, p])), [projections]);

  // ---------------------------------------------------------------- loading
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchEntry(teamId)
      .then((l) => {
        if (cancelled) return;
        setLoaded(l);
        setFt(l.entry.freeTransfersEstimate);
      })
      .catch((err: Error) => !cancelled && setLoadError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const currentIds = useMemo(() => loaded?.entry.picks.map((p) => p.element) ?? [], [loaded]);
  const missing = currentIds.filter((id) => !byId.has(id));

  // ---------------------------------------------------------------- solving
  const solve = useCallback(async () => {
    if (!dataset || !loaded) return;
    setSolving(true);
    setSolveError(null);
    try {
      const candidates = toCandidates(projections, strategy, currentIds);
      const squadValue = currentIds.reduce((s, id) => s + (byId.get(id)?.player.cost ?? 0), 0);
      const benchWeight = (strategy.benchWeights[0] + strategy.benchWeights[1] + strategy.benchWeights[2]) / 3;
      const base = {
        budget: loaded.entry.bank + squadValue,
        minBank: 0,
        maxPerClub: strategy.maxPerClub,
        benchWeight,
        benchGkWeight: strategy.benchGkWeight,
        startShare: 0.85,
        riskLambda: strategy.riskLambda,
        ownershipWeight: strategy.ownershipWeight,
        forceIn: [],
        forceOut: [],
      };

      const raw: Array<Omit<Option, "hits" | "net" | "gain"> & { objective: number }> = [];
      for (let k = 0; k <= MAX_TRANSFERS; k++) {
        const out = await solveSquad(candidates, { ...base, keep: { ids: currentIds, minKept: 15 - k } }, 1, 2);
        const s = out.solutions[0];
        if (!s) continue;
        const squadIds = s.squad.map((i) => candidates[i].id);
        const inSet = new Set(squadIds);
        const curSet = new Set(currentIds);
        const outs = currentIds.filter((id) => !inSet.has(id));
        const ins = squadIds.filter((id) => !curSet.has(id));
        // Pair like-for-like, dearest with dearest, as FPL requires.
        const transfers: Option["transfers"] = [];
        for (const pos of POS_ORDER) {
          const o = outs.filter((id) => byId.get(id)?.player.pos === pos);
          const i = ins.filter((id) => byId.get(id)?.player.pos === pos);
          const cost = (id: number) => byId.get(id)?.player.cost ?? 0;
          o.sort((a, b) => cost(b) - cost(a));
          i.sort((a, b) => cost(b) - cost(a));
          o.forEach((id, n) => i[n] !== undefined && transfers.push({ pos, out: id, in: i[n] }));
        }
        // "At most k" can return fewer moves than k; keep one option per count.
        if (raw.some((r) => r.transfers.length === transfers.length)) continue;
        raw.push({
          transfers,
          squadIds,
          xiIds: s.xi.map((i) => candidates[i].id),
          captainId: s.captain != null ? candidates[s.captain].id : null,
          objective: s.objective,
        });
      }
      const baseObj = raw.find((r) => r.transfers.length === 0)?.objective ?? raw[0]?.objective ?? 0;
      setOptions(
        raw.map((r) => {
          const gain = r.objective - baseObj;
          return { ...r, gain, hits: 0, net: gain };
        }),
      );
    } catch (err) {
      setSolveError(err instanceof Error ? err.message : "The solver failed.");
    } finally {
      setSolving(false);
    }
  }, [byId, currentIds, dataset, loaded, projections, strategy]);

  useEffect(() => {
    void solve();
  }, [solve]);

  // Hits depend on the free-transfer count, which the user can correct, so
  // they're applied here rather than baked into the solve.
  const scored = useMemo(
    () =>
      options.map((o) => {
        const hits = Math.max(0, o.transfers.length - ft);
        return { ...o, hits, net: o.gain - hits * HIT };
      }),
    [options, ft],
  );
  const recommended = useMemo(() => {
    let best = 0;
    scored.forEach((o, i) => {
      // A move has to clear half a point net to be worth more than a rolled transfer.
      if (o.transfers.length > 0 && o.net > 0.5 && o.net > scored[best].net) best = i;
    });
    return best;
  }, [scored]);

  useEffect(() => setActive(recommended), [recommended]);

  useEffect(() => {
    const o = scored[active];
    if (!o) return;
    setSquad(fromSolution(o.squadIds, o.xiIds, o.captainId, (id) => byId.get(id)?.player.pos, (id) => byId.get(id)?.xpNext ?? 0));
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, options]);

  const pitchPlayers = useMemo(
    () => (dataset && squad ? pitchPlayersFor(squad.squad, dataset, byId) : new Map()),
    [byId, dataset, squad],
  );

  const onSwap = useCallback(
    (a: number, b: number) =>
      setSquad((prev) => {
        if (!prev) return prev;
        const r = swap(prev, a, b, (id) => byId.get(id)?.player.pos);
        if (!r.ok || !r.next) {
          setNotice(r.reason ?? null);
          window.setTimeout(() => setNotice(null), 2600);
          return prev;
        }
        return r.next;
      }),
    [byId],
  );

  // ---------------------------------------------------------------- export
  const buildPlan = useCallback(() => {
    if (!squad || !dataset) return null;
    const pos = (id: number) => POS_ORDER.indexOf(byId.get(id)?.player.pos ?? "FWD");
    const xi = [...squad.xi].sort((a, b) => pos(a) - pos(b));
    const captain = squad.captain ?? xi[0];
    const vice = xi.filter((id) => id !== captain).sort((a, b) => (byId.get(b)?.xpNext ?? 0) - (byId.get(a)?.xpNext ?? 0))[0];
    const order = [...xi, ...squad.bench];
    const xp: Record<string, number> = {};
    for (const id of new Set([...currentIds, ...squad.squad])) {
      const p = byId.get(id);
      if (p) xp[id] = Number(p.xpHorizon.toFixed(2));
    }
    return {
      event: dataset.startEvent,
      generated_at: new Date().toISOString(),
      params_version: "1.0",
      source: "fantasy-drafter/my-team",
      chip: null,
      picks: order.map((element, i) => ({
        element,
        position: i + 1,
        is_captain: element === captain,
        is_vice_captain: element === vice,
      })),
      xp,
    };
  }, [byId, currentIds, dataset, squad]);

  const downloadPlan = () => {
    const plan = buildPlan();
    if (!plan) return;
    const blob = new Blob([JSON.stringify(plan, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plan.json";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ---------------------------------------------------------------- render
  const name = (id: number) => byId.get(id)?.player.webName ?? `#${id}`;
  const club = (id: number) => {
    const teamId = byId.get(id)?.player.teamId;
    return teamId != null ? (dataset?.teamsById.get(teamId)?.short ?? "") : "";
  };
  const cost = (id: number) => byId.get(id)?.player.cost ?? 0;
  const posOf = (id: number) => byId.get(id)?.player.pos;
  const chosen = scored[active];

  return (
    <div className="max-w-[1180px] mx-auto px-4 sm:px-5 py-6 sm:py-7">
      <div className="mb-5">
        <h1 className="font-display text-[clamp(24px,3.5vw,32px)] font-bold tracking-tight">My team</h1>
        <p className="text-[13.5px] text-ink-2 mt-1 max-w-[62ch]">
          Your squad, its best lineup this gameweek, and the transfers worth making — scored over the
          next {strategy.horizon} gameweeks with hits deducted.
        </p>
      </div>

      <Card className="p-4 mb-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const id = draftId.trim();
            writeStore(ID_KEY, id || null);
            setOptions([]);
            setLoaded(null);
            setTeamId(id);
          }}
        >
          <label className="grid gap-1.5 flex-1 min-w-[180px]">
            <span className="text-[12.5px] text-ink-2">FPL team ID</span>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 1234567"
              className="font-mono text-[15px] bg-surface-2 border border-line-strong rounded-md px-3 py-2 focus:outline-2 focus:outline-accent"
            />
          </label>
          <button
            type="submit"
            disabled={!draftId || loading}
            className="bg-accent text-accent-ink font-medium text-[14px] rounded-md px-4 py-2 disabled:opacity-50"
          >
            {loading ? "Loading…" : teamId && teamId === draftId ? "Refresh" : "Load"}
          </button>
        </form>
        <p className="text-[12px] text-ink-muted mt-2.5">
          Find it on the FPL site under <b className="font-semibold">Points</b> — it's the number in the
          address, <span className="font-mono">/entry/<b>1234567</b>/event/…</span>. No login: only
          public data is read, so no password ever leaves your phone.
        </p>
        {loadError && (
          <p className="text-[13px] text-loss mt-2" role="alert">
            {loadError}
          </p>
        )}
      </Card>

      {state.status === "loading" && <p className="text-ink-2">Loading player data…</p>}
      {state.status === "error" && <p className="text-loss">{state.message}</p>}

      {loaded && dataset && (
        <>
          <div className="mb-4 rounded-lg border border-line bg-surface-2 px-4 py-3 text-[12.5px] text-ink-2 grid gap-1">
            <span>
              Squad as of the <b className="font-semibold text-ink">GW{loaded.entry.squadEvent}</b> deadline —
              transfers you've made since won't show. Budgets use current prices, not your selling
              prices, so a suggestion can be a few £0.1m out.
            </span>
            {loaded.cachedAt && (
              <span className="text-loss">
                Offline: showing the copy saved {new Date(loaded.cachedAt).toLocaleString()}.
              </span>
            )}
            {missing.length > 0 && (
              <span className="text-loss">
                {missing.length} player{missing.length > 1 ? "s are" : " is"} missing from the player
                data (no minutes and flagged) and treated as must-sell.
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,470px)_minmax(0,1fr)] gap-5 items-start">
            <div className="grid gap-3">
              <Card className="overflow-hidden">
                <div className="px-4 pt-3 pb-2 flex items-baseline gap-2 flex-wrap">
                  <h2 className="font-display font-semibold text-[17px] tracking-tight">{loaded.entry.teamName}</h2>
                  <span className="text-[12.5px] text-ink-muted">{loaded.entry.managerName}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-[var(--border)] border-y border-line">
                  <StatTile label="Bank" value={money(loaded.entry.bank)} hint={`GW${loaded.entry.squadEvent}`} />
                  <StatTile label="Value" value={loaded.entry.value != null ? money(loaded.entry.value) : "—"} />
                  <StatTile
                    label="Rank"
                    value={loaded.entry.overallRank ? loaded.entry.overallRank.toLocaleString() : "—"}
                    hint={loaded.entry.overallPoints != null ? `${loaded.entry.overallPoints} pts` : undefined}
                  />
                  <StatTile label="Formation" value={squad ? formationOf(squad.xi, posOf) : "—"} hint={`GW${dataset.startEvent}`} />
                </div>
                {squad && (
                  <Pitch
                    players={pitchPlayers}
                    state={squad}
                    selectedId={selected}
                    onSwap={onSwap}
                    onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
                    onCaptain={(id) => setSquad((prev) => (prev ? setCaptain(prev, id) : prev))}
                  />
                )}
              </Card>
              <div className="flex items-center gap-3 flex-wrap min-h-[24px]">
                <p className="text-[12px] text-ink-muted">
                  Drag to swap, <b className="font-semibold">C</b> to captain. The lineup shown is the
                  selected option's best XI.
                </p>
                {notice && <span className="text-[12px] text-loss" role="status">Can't do that — {notice}.</span>}
              </div>
            </div>

            <div className="grid gap-4">
              <Card className="p-4">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h2 className="font-display font-semibold text-[16px]">Transfers</h2>
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] text-ink-2">Free transfers</span>
                    <button type="button" aria-label="Fewer free transfers" onClick={() => setFt((v) => Math.max(0, v - 1))}
                      className="w-8 h-8 rounded border border-line-strong text-ink-2 hover:bg-surface-2">−</button>
                    <span className="font-mono tnum w-4 text-center">{ft}</span>
                    <button type="button" aria-label="More free transfers" onClick={() => setFt((v) => Math.min(5, v + 1))}
                      className="w-8 h-8 rounded border border-line-strong text-ink-2 hover:bg-surface-2">+</button>
                  </div>
                </div>
                <p className="text-[11.5px] text-ink-muted -mt-1.5 mb-3">
                  Estimated {loaded.entry.freeTransfersEstimate} from your history — correct it if FPL
                  shows a different number.
                </p>

                {solving && <p className="text-[13px] text-ink-2">Solving 0–{MAX_TRANSFERS} transfers…</p>}
                {solveError && <p className="text-[13px] text-loss">{solveError}</p>}

                <div className="grid gap-2">
                  {scored.map((o, i) => (
                    <button
                      key={o.transfers.length}
                      type="button"
                      onClick={() => setActive(i)}
                      className={[
                        "text-left rounded-lg border px-3.5 py-3 transition-colors",
                        i === active ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-[14px]">
                          {o.transfers.length === 0 ? "Roll the transfer" : `${o.transfers.length} transfer${o.transfers.length > 1 ? "s" : ""}`}
                        </span>
                        {i === recommended && <Chip tone="accent">best</Chip>}
                        {o.hits > 0 && <Chip tone="loss">−{o.hits * HIT} hit</Chip>}
                        <span className={`ml-auto font-mono tnum text-[13px] ${o.net >= 0 ? "text-accent" : "text-loss"}`}>
                          {o.transfers.length === 0 ? "±0.0" : `${o.net >= 0 ? "+" : "−"}${Math.abs(o.net).toFixed(1)}`} xP
                        </span>
                      </div>
                      {o.transfers.length > 0 && (
                        <ul className="mt-2 grid gap-1">
                          {o.transfers.map((t) => (
                            <li key={t.out} className="text-[12.5px] flex items-center gap-1.5 flex-wrap">
                              <span className="font-mono text-[10.5px] text-ink-muted w-7">{t.pos}</span>
                              <span className="text-loss">{name(t.out)}</span>
                              <span className="font-mono text-[10px] text-ink-muted">{club(t.out)}</span>
                              <span className="text-ink-muted" aria-label="replaced by">→</span>
                              <span className="text-accent font-medium">{name(t.in)}</span>
                              <span className="font-mono text-[10px] text-ink-muted">{club(t.in)}</span>
                              <span className="font-mono text-[11px] text-ink-muted ml-auto tnum">
                                {money(cost(t.out))} → {money(cost(t.in))}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {o.transfers.length > 0 && o.hits > 0 && (
                        <p className="text-[11px] text-ink-muted mt-1.5 font-mono tnum">
                          gain {o.gain.toFixed(1)} − hits {o.hits * HIT} = {o.net.toFixed(1)}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              </Card>

              {chosen && (
                <Card className="p-4">
                  <h2 className="font-display font-semibold text-[16px] mb-1">Hand it to the autopilot</h2>
                  <p className="text-[12.5px] text-ink-2 mb-3">
                    Saves the selected option, with your lineup edits, as <span className="font-mono">plan.json</span>.
                    Commit it to <span className="font-mono">autopilot/plan.json</span> and the next
                    scheduled run checks it against your real selling prices and free transfers.
                  </p>
                  <button
                    type="button"
                    onClick={downloadPlan}
                    className="border border-accent text-accent font-medium text-[14px] rounded-md px-4 py-2 hover:bg-accent-soft"
                  >
                    Download plan.json
                  </button>
                </Card>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

