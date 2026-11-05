import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Chip, Slider } from "../components/ui";
import { useDataset, refreshDataset } from "../lib/useDataset";
import { projectAll } from "../lib/projections";
import { solveSquad } from "../solver/client";
import { DEFAULT_STRATEGY } from "../model/types";
import { fetchEntry, ID_KEY, readStore, writeStore, type Loaded } from "../lib/entry";
import {
  CRITERIA_LIMITS,
  HARD_WINDOW_CAP_H,
  RUN_MINUTE,
  buildContext,
  finishPlan,
  normaliseCriteria,
  sameCriteria,
  scoreCurve,
  transferCurve,
  windowState,
  type AutoCriteria,
  type CurvePoint,
  type ExtraOwned,
  type PlanContext,
  type SolveFn,
  type WeekPlan,
} from "../lib/autoplan";
import savedCriteriaFile from "../../autopilot/criteria.json";

const REPO = "https://github.com/tobxoder-svg/fpl-autopicker";
const EDIT_CRITERIA_URL = `${REPO}/edit/main/autopilot/criteria.json`;
const SAVED = normaliseCriteria(savedCriteriaFile as unknown as Partial<Record<keyof AutoCriteria, unknown>>);

/** Emphasis by inversion, spelled out. (Don't use a bare `invert` class: Tailwind's
 * built-in filter utility of the same name also applies and photo-negates it.) */
const INV = "bg-accent text-accent-ink";

const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;
const signed = (n: number, d = 1) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}`;

/** The browser's solver, shaped like the runner's. Money-mode objectives are never read. */
const browserSolve: SolveFn = async (candidates, params) => {
  const out = await solveSquad(candidates, params, 1, 2);
  const s = out.solutions[0];
  return s ? { objective: s.objective, squad: s.squad, xi: s.xi, captain: s.captain } : null;
};

function dhm(ms: number): string {
  if (ms <= 0) return "0m";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}
const when = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------------------
// Last run (what the GitHub job actually did) — unchanged shape from toProposal()
// ---------------------------------------------------------------------------

interface Who {
  id: number;
  name: string;
  pos: string;
  club?: string;
}
interface Proposal {
  version: number;
  generatedAt: string;
  event: number;
  deadline: string;
  verdict: "EXECUTED" | "READY" | "NEEDS REVIEW" | "BLOCKED" | "CHECK TEAM";
  transfers: Array<{ pos: string; out: Who & { price: number }; in: Who & { price: number } }>;
  bankAfter: number;
  freeTransfers: number | null;
  xpGain: number | null;
  lineup: { captain: { from: Who | null; to: Who } | null; vice: { from: Who | null; to: Who } | null; benchOrder: Who[] };
  checks: Array<{ level: "ok" | "warn" | "fail"; msg: string }>;
}

function useLastRun(): Proposal | null {
  const [p, setP] = useState<Proposal | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}data/proposal.json`, { cache: "no-cache" })
      .then(async (res) => {
        const isJson = (res.headers.get("content-type") ?? "").includes("json");
        if (!cancelled && res.ok && isJson) setP((await res.json()) as Proposal);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return p;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Autopilot() {
  const data = useDataset();
  const dataset = data.status === "ready" ? data.dataset : null;
  const lastRun = useLastRun();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  // ---- team
  const [teamId, setTeamId] = useState<string>(() => readStore<string>(ID_KEY) ?? "");
  const [draftId, setDraftId] = useState(teamId);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [ft, setFt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [teamNonce, setTeamNonce] = useState(0);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setTeamError(null);
    fetchEntry(teamId)
      .then((l) => {
        if (cancelled) return;
        setLoaded(l);
        setFt((cur) => cur ?? l.entry.freeTransfersEstimate);
      })
      .catch((err: Error) => !cancelled && setTeamError(err.message));
    return () => {
      cancelled = true;
    };
  }, [teamId, teamNonce]);

  // ---- the deadline this plan is for
  const deadline = useMemo(() => {
    const list = dataset?.bundle.deadlines ?? [];
    const next = list.find((d) => Date.parse(d.deadline) > now.getTime());
    return next ? { event: next.event, at: new Date(next.deadline) } : null;
  }, [dataset, now]);

  // ---- criteria: saved (what runs) vs what-if (what you're trying)
  const [criteria, setCriteria] = useState<AutoCriteria>(SAVED);
  const isSaved = sameCriteria(criteria, SAVED);
  const win = deadline ? windowState(deadline.at, criteria, now) : null;
  const savedWin = deadline ? windowState(deadline.at, SAVED, now) : null;

  // ---- phase 1: the transfer curve (criteria-independent)
  const projections = useMemo(() => (dataset ? projectAll(dataset, { ...DEFAULT_STRATEGY }) : []), [dataset]);
  const built = useMemo((): { ctx: PlanContext | null; error: string | null } => {
    if (!dataset || !loaded || ft == null) return { ctx: null, error: null };
    const e = loaded.entry;
    const inPool = new Set(projections.map((p) => p.player.id));
    const price = new Map((e.players ?? []).map((p) => [p.id, p.nowCost]));
    for (const p of projections) price.set(p.player.id, p.player.cost);
    const extraOwned: ExtraOwned[] = (e.players ?? [])
      .filter((p) => !inPool.has(p.id))
      .map((p) => ({ id: p.id, pos: p.pos, teamId: p.teamId, name: p.webName }));
    try {
      const ctx = buildContext({
        projections,
        team: {
          // Public data has no selling prices; today's price stands in for them.
          picks: e.picks.map((p) => ({ ...p, sellingPrice: price.get(p.element) ?? 0 })),
          bank: e.bank,
          freeTransfers: ft,
        },
        extraOwned,
      });
      return { ctx, error: null };
    } catch (err) {
      return { ctx: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [dataset, loaded, ft, projections]);
  const ctx = built.ctx;
  const ctxError = built.error;

  // A curve is only valid for the exact context it was solved from (candidate
  // indices differ between contexts), so they're stored together.
  const [curveFor, setCurveFor] = useState<{ ctx: PlanContext; curve: CurvePoint[] } | null>(null);
  const curve = curveFor && curveFor.ctx === ctx ? curveFor.curve : null;
  const [curveBusy, setCurveBusy] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);
  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    setCurveBusy(true);
    setSolveError(null);
    transferCurve(ctx, browserSolve)
      .then((c) => !cancelled && setCurveFor({ ctx, curve: c }))
      .catch((err: Error) => !cancelled && setSolveError(err.message))
      .finally(() => !cancelled && setCurveBusy(false));
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  // ---- phase 2: apply the criteria (fast; debounced while a slider moves)
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!ctx || !curve) return;
    const mine = ++seq.current;
    setPlanBusy(true);
    const t = window.setTimeout(() => {
      finishPlan({ ctx, curve, criteria, solve: browserSolve, event: deadline?.event ?? dataset?.startEvent ?? 0 })
        .then((p) => mine === seq.current && setPlan(p))
        .catch((err: Error) => mine === seq.current && setSolveError(err.message))
        .finally(() => mine === seq.current && setPlanBusy(false));
    }, 200);
    return () => window.clearTimeout(t);
  }, [ctx, curve, criteria, deadline?.event, dataset?.startEvent]);

  // Instant rule-1 view while the money stage solves.
  const scored = useMemo(() => (curve ? scoreCurve(curve, criteria) : null), [curve, criteria]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await refreshDataset();
    setTeamNonce((n) => n + 1);
    setRefreshing(false);
  }, []);

  const executedThisGw = lastRun && deadline && lastRun.event === deadline.event && lastRun.verdict === "EXECUTED";
  const name = (id: number) => ctx?.nameOf(id) ?? `#${id}`;
  const club = (id: number) => {
    const p = projections.find((x) => x.player.id === id);
    const teamIdOf = p?.player.teamId ?? loaded?.entry.players?.find((x) => x.id === id)?.teamId;
    return teamIdOf != null ? (dataset?.teamsById.get(teamIdOf)?.short ?? "") : "";
  };

  return (
    <div className="max-w-[860px] mx-auto px-4 sm:px-5 py-6 sm:py-7">
      <div className="mb-5">
        <h1 className="font-display text-[clamp(24px,3.5vw,32px)] font-bold tracking-tight">Autopilot</h1>
        <p className="text-[13.5px] text-ink-2 mt-1 max-w-[64ch]">
          This week's plan, worked out live by the same code the autopilot runs. It executes by
          itself inside the window before the deadline — no confirmation. Free transfers only, never
          a points hit; a move only if it earns its keep; and the most money left among near-best
          options.
        </p>
      </div>

      {data.status === "loading" && <p className="text-ink-2">Loading player data…</p>}
      {data.status === "error" && <p className="text-loss">{data.message}</p>}

      {dataset && (
        <div className="grid gap-4">
          {/* ------------------------------------------------------ this week */}
          <Card className="p-4">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="eyebrow">This week</span>
              {deadline && <span className="font-semibold text-[15px]">GW{deadline.event}</span>}
              {deadline && <span className="text-[12.5px] text-ink-muted">deadline {when(deadline.at)}</span>}
            </div>

            {!deadline || !win ? (
              <p className="text-[13px] text-ink-2 mt-3">
                Deadline times arrive with the next data refresh. The plan below still works.
              </p>
            ) : (
              <>
                <StatusLine win={win} now={now} executed={Boolean(executedThisGw)} savedWin={savedWin!} isSaved={isSaved} />
                <Timeline win={win} now={now} />
              </>
            )}
            <div className="mt-3 flex items-center gap-3 flex-wrap">
            <p className="text-[11.5px] text-ink-muted flex-1 min-w-[12rem]">
              Data from {new Date(dataset.bundle.generatedAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
              {dataset.source === "offline" ? " (offline copy)" : dataset.source === "snapshot" ? " (snapshot)" : ""}.
              {dataset.isSample && " Sample data — the plan demonstrates the machinery only."}
            </p>
              <button
                type="button"
                onClick={refresh}
                disabled={refreshing}
                className="text-[11px] tracking-[0.12em] uppercase border-[1.5px] border-line-strong px-2.5 py-1.5 hover:bg-surface-2 disabled:opacity-50"
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </Card>

          {/* ------------------------------------------------------- the plan */}
          <Card className="p-0 overflow-hidden">
            <div className={`${INV} px-4 py-2.5 flex items-center gap-2 flex-wrap`}>
              <span className="text-[10.5px] tracking-[0.16em] uppercase">The plan</span>
              <span className="text-[11px] tracking-[0.12em] uppercase opacity-80">
                {isSaved ? "· what will run" : "· what-if preview"}
              </span>
              {(curveBusy || planBusy) && <span className="ml-auto text-[11px] tracking-[0.12em] uppercase">solving…</span>}
            </div>

            <div className="p-4">
              {!teamId || teamError || !loaded ? (
                <TeamIdForm
                  draft={draftId}
                  setDraft={setDraftId}
                  error={teamError}
                  loading={Boolean(teamId) && !loaded && !teamError}
                  onSubmit={(id) => {
                    writeStore(ID_KEY, id || null);
                    setLoaded(null);
                    setFt(null);
                    setCurveFor(null);
                    setPlan(null);
                    setTeamId(id);
                  }}
                />
              ) : (
                <>
                  <div className="flex items-center gap-2 flex-wrap mb-3">
                    <span className="font-semibold text-[14px]">{loaded.entry.teamName}</span>
                    <span className="text-[12px] text-ink-muted">#{loaded.entry.id}</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <span className="text-[12px] text-ink-2">Free transfers</span>
                      <button type="button" aria-label="Fewer free transfers" onClick={() => setFt((v) => Math.max(0, (v ?? 1) - 1))}
                        className="w-8 h-8 border border-line-strong hover:bg-surface-2">−</button>
                      <span className="tnum w-5 text-center">{ft}</span>
                      <button type="button" aria-label="More free transfers" onClick={() => setFt((v) => Math.min(5, (v ?? 1) + 1))}
                        className="w-8 h-8 border border-line-strong hover:bg-surface-2">+</button>
                    </div>
                  </div>

                  {(ctxError || solveError) && (
                    <p className="text-[13px] text-loss mb-3" role="alert">{ctxError ?? solveError}</p>
                  )}
                  {!plan && !ctxError && !solveError && (
                    <p className="text-[13px] text-ink-2">Working out the best move for 0–{ft} transfers…</p>
                  )}
                  {plan && <PlanView plan={plan} name={name} club={club} dim={planBusy} />}

                  <hr className="rule-dotted my-3" />
                  <p className="text-[11.5px] text-ink-muted">
                    Preview from public data: your squad as of the GW{loaded.entry.squadEvent} deadline,
                    today's prices standing in for your selling prices, and {ft} free transfer{ft === 1 ? "" : "s"}{" "}
                    {ft === loaded.entry.freeTransfersEstimate ? "(estimated — adjust if FPL shows otherwise)" : "(set by you)"}.
                    The autopilot uses the exact figures when it runs, so a move right at your budget
                    limit can differ. If you make transfers yourself this week, it leaves the week alone.
                    {loaded.cachedAt && ` Offline: team saved ${new Date(loaded.cachedAt).toLocaleString()}.`}
                  </p>
                </>
              )}
            </div>
          </Card>

          {/* --------------------------------------------------- why this many */}
          {scored && (
            <Card className="p-4">
              <div className="flex items-baseline gap-2 flex-wrap mb-1">
                <span className="eyebrow">Why this many transfers</span>
              </div>
              <p className="text-[12.5px] text-ink-2 mb-3">
                Each transfer must add at least <b className="font-semibold">{criteria.minGainPerTransfer.toFixed(1)} xP</b>{" "}
                over the next 5 gameweeks. The highlighted row clears the bar by the most.
              </p>
              <CurveTable rows={scored.rows} chosen={scored.best.k} />
              {plan && plan.transfersUsed > 0 && (
                <p className="text-[12.5px] text-ink-2 mt-3">
                  {plan.bankSavedByTieBreak > 0 ? (
                    <>
                      Money rule: gave up <b className="font-semibold tnum">{plan.xpGivenUpForMoney.toFixed(1)} xP</b> to keep{" "}
                      <b className="font-semibold tnum">{money(plan.bankSavedByTieBreak)}</b> more in the bank (allowed:{" "}
                      {criteria.bankToleranceXp} xP).
                    </>
                  ) : (
                    <>Money rule: no cheaper squad within {criteria.bankToleranceXp} xP of the best, so it takes the top-scoring one.</>
                  )}
                </p>
              )}
            </Card>
          )}

          {/* -------------------------------------------------------- criteria */}
          <Card className="p-4">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <span className="eyebrow">Criteria</span>
              {isSaved ? <Chip>saved · will run</Chip> : <Chip tone="loss">what-if · not saved</Chip>}
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Slider
                id="c-gain"
                label="Each transfer must add"
                value={criteria.minGainPerTransfer}
                {...CRITERIA_LIMITS.minGainPerTransfer}
                display={`${criteria.minGainPerTransfer.toFixed(1)} xP`}
                scale={["more moves", "fewer moves"]}
                onChange={(v) => setCriteria((c) => normaliseCriteria({ ...c, minGainPerTransfer: v }))}
              />
              <Slider
                id="c-bank"
                label="Money may give up"
                value={criteria.bankToleranceXp}
                {...CRITERIA_LIMITS.bankToleranceXp}
                display={`${criteria.bankToleranceXp.toFixed(1)} xP`}
                scale={["points first", "money first"]}
                onChange={(v) => setCriteria((c) => normaliseCriteria({ ...c, bankToleranceXp: v }))}
              />
              <Slider
                id="c-window"
                label="Act within"
                value={criteria.windowMaxH}
                {...CRITERIA_LIMITS.windowMaxH}
                display={`${criteria.windowMaxH}h of deadline`}
                scale={["later", `${HARD_WINDOW_CAP_H}h max`]}
                onChange={(v) => setCriteria((c) => normaliseCriteria({ ...c, windowMaxH: v }))}
              />
            </div>
            <p className="text-[11.5px] text-ink-muted mt-3">
              Fixed in code whatever you set: never a points hit, never more than {HARD_WINDOW_CAP_H}h before
              the deadline, and it stops {criteria.windowMinH}h before so it never races the lock.
            </p>
            {!isSaved && (
              <CriteriaActions criteria={criteria} onReset={() => setCriteria(SAVED)} />
            )}
            {isSaved && (
              <p className="text-[12px] text-ink-2 mt-3">
                Move a slider to see how the plan changes. Nothing changes on your team until you save it in{" "}
                <a href={EDIT_CRITERIA_URL} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                  autopilot/criteria.json
                </a>
                .
              </p>
            )}
          </Card>

          {/* -------------------------------------------------------- last run */}
          <Card className="p-4">
            <span className="eyebrow">Last run</span>
            {lastRun ? (
              <LastRun p={lastRun} />
            ) : (
              <p className="text-[12.5px] text-ink-2 mt-2">
                Nothing published here yet. Each run's result always goes to your phone (if{" "}
                <span className="font-mono">NOTIFY_WEBHOOK</span> is set) and to the run log on GitHub.
                To also see it on this tab, set the repository variable{" "}
                <span className="font-mono">AUTOPILOT_PUBLISH</span> to <span className="font-mono">true</span> —
                note that makes the executed transfers visible to anyone who opens the site.
              </p>
            )}
          </Card>

          <Card className="p-4">
            <span className="eyebrow">Alerts on this phone</span>
            <p className="text-[12.5px] text-ink-2 mt-2">
              Install <b className="font-semibold">ntfy</b> from the Play Store, subscribe to a hard-to-guess
              topic, and set the <span className="font-mono">NOTIFY_WEBHOOK</span> secret to{" "}
              <span className="font-mono">https://ntfy.sh/&lt;topic&gt;</span>. You'll hear about every run,
              skip and problem.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function StatusLine({
  win,
  now,
  executed,
  savedWin,
  isSaved,
}: {
  win: ReturnType<typeof windowState>;
  now: Date;
  executed: boolean;
  savedWin: ReturnType<typeof windowState>;
  isSaved: boolean;
}) {
  let big: string;
  let small: string;
  if (executed) {
    big = "Done for this week";
    small = "The autopilot has already executed this gameweek — see Last run.";
  } else if (win.phase === "passed") {
    big = "Deadline passed";
    small = "The next plan appears when FPL opens the next gameweek.";
  } else if (win.phase === "closing") {
    big = "Window closed";
    small = `Too close to the deadline — the autopilot stops ${clock(win.closesAt)} so it never races the lock.`;
  } else if (win.phase === "open") {
    big = win.expectedRun ? `Executes ≈ ${clock(win.expectedRun)}` : "Window open";
    small = `Window open until ${clock(win.closesAt)}. Runs hourly at :${String(RUN_MINUTE).padStart(2, "0")}; GitHub can start a few minutes late.`;
  } else {
    big = `Executes in ${dhm((win.expectedRun ?? win.opensAt).getTime() - now.getTime())}`;
    small = `First run inside the window ≈ ${when(win.expectedRun ?? win.opensAt)} (window opens ${when(win.opensAt)}).`;
  }
  return (
    <div className="mt-3">
      <div className="text-[22px] sm:text-[26px] font-semibold tracking-tight tnum leading-tight">{big}</div>
      <p className="text-[12.5px] text-ink-2 mt-1">{small}</p>
      {!isSaved && savedWin.opensAt.getTime() !== win.opensAt.getTime() && (
        <p className="text-[12px] text-loss mt-1">
          What-if timing. With your saved settings the window opens {when(savedWin.opensAt)}.
        </p>
      )}
    </div>
  );
}

/** The final 24 hours before the deadline, with the window inverted. */
function Timeline({ win, now }: { win: ReturnType<typeof windowState>; now: Date }) {
  const SPAN = 24 * 3_600_000;
  const end = win.deadline.getTime();
  const start = end - SPAN;
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - start) / SPAN) * 100)).toFixed(2)}%`;
  const nowIn = now.getTime() >= start && now.getTime() <= end;
  const before = now.getTime() < start;
  return (
    <div className="mt-4" aria-hidden="false">
      <div className="flex justify-between text-[10.5px] tracking-[0.1em] uppercase text-ink-muted mb-1">
        <span>{before ? `−24h · you are ${dhm(end - now.getTime())} out` : "−24h"}</span>
        <span>deadline</span>
      </div>
      <div className="relative h-7 border-[1.5px] border-line-strong bg-surface-2" role="img"
        aria-label={`Execution window ${when(win.opensAt)} to ${when(win.closesAt)}, deadline ${when(win.deadline)}`}>
        <div className={`${INV} absolute top-0 bottom-0`} style={{ left: pct(win.opensAt.getTime()), width: `calc(${pct(win.closesAt.getTime())} - ${pct(win.opensAt.getTime())})` }}>
          <span className="absolute inset-0 grid place-items-center text-[10px] tracking-[0.14em] uppercase whitespace-nowrap overflow-hidden">window</span>
        </div>
        <div className="absolute top-0 bottom-0 rule-dotted" style={{ left: pct(win.closesAt.getTime()), right: 0, borderTop: 0, borderLeft: "2px dotted var(--border)" }} />
        {nowIn && (
          <div className="absolute -top-1 -bottom-1 w-[3px] bg-[var(--ink)]" style={{ left: `calc(${pct(now.getTime())} - 1px)` }} title="now" />
        )}
      </div>
      <div className="relative h-4 mt-1 text-[10.5px] text-ink-muted tnum">
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pct(win.opensAt.getTime()) }}>{clock(win.opensAt)}</span>
        <span className="absolute right-0 whitespace-nowrap">{clock(win.deadline)}</span>
      </div>
    </div>
  );
}

function TeamIdForm({
  draft,
  setDraft,
  error,
  loading,
  onSubmit,
}: {
  draft: string;
  setDraft: (s: string) => void;
  error: string | null;
  loading: boolean;
  onSubmit: (id: string) => void;
}) {
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft.trim());
      }}
    >
      <label className="text-[12.5px] text-ink-2" htmlFor="ap-team">
        Your FPL team ID (same as on My team — it's the number in your Points page address)
      </label>
      <div className="flex gap-2">
        <input
          id="ap-team"
          inputMode="numeric"
          pattern="[0-9]*"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
          placeholder="e.g. 1234567"
          className="flex-1 min-w-0 tnum text-[15px] bg-surface-2 border-[1.5px] border-line-strong px-3 py-2"
        />
        <button type="submit" disabled={!draft || loading} className={`${INV} px-4 py-2 text-[13px] uppercase tracking-[0.1em] disabled:opacity-50`}>
          {loading ? "Loading…" : "Show plan"}
        </button>
      </div>
      {error && <p className="text-[13px] text-loss" role="alert">{error}</p>}
    </form>
  );
}

function PlanView({
  plan,
  name,
  club,
  dim,
}: {
  plan: WeekPlan;
  name: (id: number) => string;
  club: (id: number) => string;
  dim: boolean;
}) {
  return (
    <div className={dim ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={dim}>
      <div className="text-[20px] sm:text-[22px] font-semibold tracking-tight leading-tight">
        {plan.transfersUsed === 0
          ? "Roll — save the free transfer"
          : `${plan.transfersUsed} transfer${plan.transfersUsed > 1 ? "s" : ""} · ${signed(plan.gain)} xP`}
      </div>
      <p className="text-[12.5px] text-ink-2 mt-1">
        {plan.transfersUsed === 0
          ? plan.notes[0] ?? "No move clears the bar this week."
          : `vs rolling, over the next 5 gameweeks · uses ${plan.transfersUsed} of ${plan.freeTransfers} free · no hits`}
      </p>

      {plan.transfers.length > 0 && (
        <ul className="mt-3 grid">
          {plan.transfers.map((t) => (
            <li key={t.out} className="grid grid-cols-[2.4rem_1fr] gap-x-2 py-2 border-t border-line first:border-t-0 text-[13px]">
              <span className="text-[10.5px] tracking-[0.12em] text-ink-muted pt-0.5">{t.pos}</span>
              <div className="grid gap-0.5 min-w-0">
                <div className="flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-ink-muted w-8 text-[10.5px] tracking-[0.12em]">OUT</span>
                  <span className="line-through decoration-1 text-ink-2">{name(t.out)}</span>
                  <span className="text-[10.5px] text-ink-muted">{club(t.out)}</span>
                  <span className="ml-auto tnum text-[12px] text-ink-muted">{money(t.sell)} · {t.xpOut.toFixed(1)} xP</span>
                </div>
                <div className="flex items-baseline gap-1.5 flex-wrap">
                  <span className={`${INV} px-1 text-[10.5px] tracking-[0.12em]`}>IN</span>
                  <span className="font-semibold">{name(t.in)}</span>
                  <span className="text-[10.5px] text-ink-muted">{club(t.in)}</span>
                  <span className="ml-auto tnum text-[12px]">{money(t.buy)} · {t.xpIn.toFixed(1)} xP</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 border-[1.5px] border-line">
        <Stat label="Bank" value={`${money(plan.bankBefore)} → ${money(plan.bankAfter)}`} />
        <Stat label="vs rolling" value={`${signed(plan.gain)} xP`} />
        <Stat label="Captain" value={name(plan.captain)} />
        <Stat label="Vice" value={name(plan.vice)} />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 border-line [&:not(:nth-child(2n))]:border-r-[1.5px] sm:[&:not(:last-child)]:border-r-[1.5px] [&:nth-child(-n+2)]:border-b-[1.5px] sm:[&:nth-child(-n+2)]:border-b-0 min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="tnum text-[13.5px] font-semibold truncate">{value}</dd>
    </div>
  );
}

function CurveTable({ rows, chosen }: { rows: ReturnType<typeof scoreCurve>["rows"]; chosen: number }) {
  return (
    <div className="scroll-x">
      <table className="w-full text-[12.5px] tnum border-collapse min-w-[300px]">
        <thead>
          <tr className="text-left eyebrow">
            <th className="font-normal py-1 pr-2">Transfers</th>
            <th className="font-normal py-1 pr-2 text-right">Gain</th>
            <th className="font-normal py-1 pr-2 text-right">Needed</th>
            <th className="font-normal py-1 text-right">Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k} className={r.k === chosen ? INV : "border-t border-line"}>
              <td className="py-1.5 px-1">
                {r.k === 0 ? "0 · roll" : r.k}
                {r.k === chosen && <span className="ml-1.5 text-[10px] tracking-[0.12em] uppercase">◂ chosen</span>}
              </td>
              <td className="py-1.5 pr-2 text-right">{r.k === 0 ? "—" : `${signed(r.gainVsRoll)}`}</td>
              <td className="py-1.5 pr-2 text-right">{r.k === 0 ? "—" : r.required.toFixed(1)}</td>
              <td className={`py-1.5 px-1 text-right ${r.k !== chosen && r.k > 0 && !r.passes ? "text-loss" : ""}`}>
                {r.k === 0 ? "—" : signed(r.net)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CriteriaActions({ criteria, onReset }: { criteria: AutoCriteria; onReset: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify({ ...(savedCriteriaFile as object), ...criteria }, null, 2) + "\n";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy these settings:", text);
    }
  };
  return (
    <div className="mt-3 border-[1.5px] border-line p-3 grid gap-2">
      <p className="text-[12.5px] text-ink-2">
        The autopilot still runs with the saved settings ({SAVED.minGainPerTransfer} xP ·{" "}
        {SAVED.bankToleranceXp} xP · {SAVED.windowMaxH}h). To make these stick: copy them, open
        criteria.json on GitHub, select everything, paste, and commit. The next hourly run uses them.
      </p>
      <div className="flex gap-2 flex-wrap">
        <button type="button" onClick={copy} className={`${INV} px-3 py-1.5 text-[12px] uppercase tracking-[0.1em]`}>
          {copied ? "Copied ✓" : "Copy settings"}
        </button>
        <a href={EDIT_CRITERIA_URL} target="_blank" rel="noreferrer noopener"
          className="border-[1.5px] border-line-strong px-3 py-1.5 text-[12px] uppercase tracking-[0.1em] hover:bg-surface-2">
          Edit on GitHub ↗
        </a>
        <button type="button" onClick={onReset} className="border-[1.5px] border-line px-3 py-1.5 text-[12px] uppercase tracking-[0.1em] hover:bg-surface-2">
          Reset
        </button>
      </div>
    </div>
  );
}

const VERDICT_COPY: Record<Proposal["verdict"], string> = {
  EXECUTED: "Submitted to FPL and confirmed on your team.",
  READY: "Every rule passed.",
  "NEEDS REVIEW": "Legal, with a warning worth a look.",
  BLOCKED: "Broke a rule, so nothing was submitted.",
  "CHECK TEAM": "Submitted, but FPL's copy didn't match — check your team in the FPL app.",
};

function LastRun({ p }: { p: Proposal }) {
  const tone = p.verdict === "BLOCKED" || p.verdict === "CHECK TEAM" ? "loss" : "neutral";
  return (
    <div className="mt-2 grid gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Chip tone={tone}>{p.verdict}</Chip>
        <span className="font-semibold">GW{p.event}</span>
        <span className="text-[12px] text-ink-muted ml-auto">{new Date(p.generatedAt).toLocaleString()}</span>
      </div>
      <p className="text-[12.5px] text-ink-2">{VERDICT_COPY[p.verdict] ?? ""}</p>
      {p.transfers.length > 0 ? (
        <ul className="grid gap-1 text-[13px]">
          {p.transfers.map((t) => (
            <li key={t.out.id} className="flex gap-1.5 flex-wrap items-baseline">
              <span className="text-[10.5px] text-ink-muted w-8">{t.pos}</span>
              <span className="line-through decoration-1 text-ink-2">{t.out.name}</span>
              <span className="text-ink-muted">→</span>
              <span className="font-semibold">{t.in.name}</span>
              <span className="ml-auto tnum text-[12px] text-ink-muted">{money(t.out.price)} → {money(t.in.price)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px]">No transfers — rolled.</p>
      )}
      {p.lineup.captain && (
        <p className="text-[12.5px] text-ink-2">
          Captain <b className="font-semibold">{p.lineup.captain.to.name}</b>
          {p.lineup.vice && <> · vice {p.lineup.vice.to.name}</>} · bank after {money(p.bankAfter)}
        </p>
      )}
    </div>
  );
}
