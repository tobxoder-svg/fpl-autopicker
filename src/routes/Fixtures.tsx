import { useMemo, useState, type ReactNode } from "react";
import { useDataset } from "../lib/useDataset";
import type { Dataset } from "../lib/data";
import {
  backtest,
  buildMatchModel,
  predictAll,
  streakFor,
  type MatchModel,
  type MatchPrediction,
} from "../model/matches";
import { Card, Chip, Slider } from "../components/ui";

const pct = (p: number, d = 0) => `${(p * 100).toFixed(d)}%`;

/** Small probabilities read better as "1 in N" than as 0.07%. */
const oneIn = (p: number) => (p > 0 ? `1 in ${Math.round(1 / p).toLocaleString()}` : "—");

function kickoffLabel(iso: string | null): string {
  if (!iso) return "TBC";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "TBC";
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="max-w-[1180px] mx-auto px-4 sm:px-5 pt-8 pb-4">{children}</div>;
}

export default function Fixtures() {
  const state = useDataset();

  if (state.status === "loading") {
    return <Shell><p className="text-ink-2">Loading the data snapshot…</p></Shell>;
  }
  if (state.status === "error") {
    return (
      <Shell>
        <Card className="p-6 max-w-xl">
          <h2 className="text-lg font-semibold mb-2">No data snapshot yet</h2>
          <p className="text-[13.5px] text-ink-2">{state.message}</p>
        </Card>
      </Shell>
    );
  }
  return <FixturesPage ds={state.dataset} />;
}

function FixturesPage({ ds }: { ds: Dataset }) {
  const { bundle, teamsById } = ds;
  const model = useMemo(() => buildMatchModel(bundle), [bundle]);
  const predictions = useMemo(() => predictAll(bundle, model), [bundle, model]);
  const test = useMemo(() => backtest(bundle), [bundle]);

  const events = useMemo(() => [...new Set(predictions.map((p) => p.event))], [predictions]);
  const [event, setEvent] = useState<number | null>(null);
  const [teamFilter, setTeamFilter] = useState<number | 0>(0);
  const activeEvent = event ?? events[0] ?? null;

  const shown = predictions.filter((p) =>
    teamFilter ? p.teamH === teamFilter || p.teamA === teamFilter : p.event === activeEvent,
  );
  const teamsSorted = [...bundle.teams].sort((a, b) => a.name.localeCompare(b.name));
  const short = (id: number) => teamsById.get(id)?.short ?? `#${id}`;
  const name = (id: number) => teamsById.get(id)?.name ?? `Team ${id}`;
  const hasResults = (bundle.results?.length ?? 0) > 0;

  return (
    <Shell>
      {ds.isSample && (
        <div className="mb-5 rounded-lg border border-loss/40 bg-loss-soft px-4 py-3 text-[13px]">
          <b className="font-semibold text-loss">Sample data.</b>{" "}
          <span className="text-ink-2">
            Invented clubs and results, so these probabilities show how the model works and aren't
            predictions. A build with network access replaces them with the live league.
          </span>
        </div>
      )}

      <header className="mb-6">
        <p className="eyebrow">Match predictions</p>
        <h1 className="font-display text-[clamp(26px,4vw,38px)] font-bold tracking-tight mt-1">
          Every remaining fixture, win · draw · loss
        </h1>
        <p className="mt-2 text-[14px] text-ink-2 max-w-[70ch] leading-relaxed">
          Each club gets an attack and a defence rating, fitted from goals and xG and adjusted
          for who they played. A fixture's expected goals come from both sides' ratings plus
          home advantage, then a Poisson score grid gives the three outcomes, which always add
          up to 100%.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          <Chip tone="accent">{model.source === "goals+xG" ? "goals + xG" : "goals only"}</Chip>
          <Chip>{model.nResults} results fitted</Chip>
          {!hasResults && <Chip tone="loss">no results in snapshot — prior only</Chip>}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] gap-5 items-start">
        {/* --------------------------------------------------------- fixtures */}
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-line flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by club"
              value={teamFilter}
              onChange={(e) => setTeamFilter(Number(e.target.value))}
              className="bg-surface border border-line-strong rounded px-2 py-1.5 text-[13px]"
            >
              <option value={0}>All clubs, by gameweek</option>
              {teamsSorted.map((t) => (
                <option key={t.id} value={t.id}>{t.name}: all fixtures</option>
              ))}
            </select>
            {!teamFilter && activeEvent !== null && (
              <div className="flex items-center gap-1 ml-auto">
                <GwButton
                  label="Previous gameweek"
                  disabled={events.indexOf(activeEvent) <= 0}
                  onClick={() => setEvent(events[events.indexOf(activeEvent) - 1])}
                >
                  ‹
                </GwButton>
                <select
                  aria-label="Gameweek"
                  value={activeEvent}
                  onChange={(e) => setEvent(Number(e.target.value))}
                  className="bg-surface border border-line-strong rounded px-2 py-1.5 text-[13px] font-mono"
                >
                  {events.map((ev) => <option key={ev} value={ev}>GW{ev}</option>)}
                </select>
                <GwButton
                  label="Next gameweek"
                  disabled={events.indexOf(activeEvent) >= events.length - 1}
                  onClick={() => setEvent(events[events.indexOf(activeEvent) + 1])}
                >
                  ›
                </GwButton>
              </div>
            )}
          </div>

          <Legend />

          {shown.length === 0 ? (
            <p className="px-4 py-8 text-[13px] text-ink-muted">No upcoming fixtures in the snapshot.</p>
          ) : (
            <ul>
              {shown.map((p, i) => (
                <FixtureRow
                  key={`${p.event}-${p.teamH}-${p.teamA}-${i}`}
                  p={p}
                  home={name(p.teamH)}
                  away={name(p.teamA)}
                  homeShort={short(p.teamH)}
                  awayShort={short(p.teamA)}
                  showEvent={Boolean(teamFilter)}
                  focus={teamFilter || null}
                />
              ))}
            </ul>
          )}
        </Card>

        {/* -------------------------------------------------------- side cards */}
        <div className="grid gap-5">
          <StreakCard ds={ds} predictions={predictions} defaultTeam={teamFilter || teamsSorted[0]?.id} />
          <BacktestCard test={test} />
        </div>
      </div>

      <RatingsCard ds={ds} model={model} />
    </Shell>
  );
}

function GwButton({ children, label, disabled, onClick }: { children: ReactNode; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="w-8 h-8 rounded border border-line-strong text-ink-2 hover:bg-surface-2 disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function Legend() {
  return (
    <div className="px-4 py-2 border-b border-line flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-muted">
      <span className="flex items-center gap-1.5"><i className="w-3 h-2 rounded-sm bg-accent inline-block" /> home win</span>
      <span className="flex items-center gap-1.5"><i className="w-3 h-2 rounded-sm bg-surface-3 border border-line-strong inline-block" /> draw</span>
      <span className="flex items-center gap-1.5"><i className="w-3 h-2 rounded-sm bg-[var(--ink-2)] inline-block" /> away win</span>
    </div>
  );
}

function FixtureRow({
  p, home, away, homeShort, awayShort, showEvent, focus,
}: {
  p: MatchPrediction; home: string; away: string; homeShort: string; awayShort: string;
  showEvent: boolean; focus: number | null;
}) {
  const fav = p.pHome >= p.pDraw && p.pHome >= p.pAway ? "home" : p.pAway >= p.pDraw ? "away" : "draw";
  const strong = (side: "home" | "away") =>
    focus ? (side === "home" ? p.teamH === focus : p.teamA === focus) : fav === side;

  return (
    <li className="px-4 py-3 border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px] text-ink-muted font-mono">
        {showEvent && <span className="text-ink-2 whitespace-nowrap">GW{p.event}</span>}
        <span className="whitespace-nowrap">{kickoffLabel(p.kickoff)}</span>
        <span className="ml-auto whitespace-nowrap" title="Most likely single scoreline">
          likely {p.score[0]}–{p.score[1]} · btts {pct(p.pBtts)}
        </span>
      </div>

      <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
        <div className={`text-[14px] truncate ${strong("home") ? "font-semibold" : ""}`}>
          <span className="sm:hidden">{homeShort}</span>
          <span className="hidden sm:inline">{home}</span>
        </div>
        <div className="font-mono text-[12px] text-ink-2 tnum text-center" title="Expected goals">
          {p.xgH.toFixed(1)} – {p.xgA.toFixed(1)}
        </div>
        <div className={`text-[14px] truncate text-right ${strong("away") ? "font-semibold" : ""}`}>
          <span className="sm:hidden">{awayShort}</span>
          <span className="hidden sm:inline">{away}</span>
        </div>
      </div>

      <div
        className="mt-2 flex h-[10px] rounded-full overflow-hidden gap-[2px]"
        role="img"
        aria-label={`${home} win ${pct(p.pHome)}, draw ${pct(p.pDraw)}, ${away} win ${pct(p.pAway)}`}
      >
        <i className="block bg-accent" style={{ width: pct(p.pHome, 2) }} />
        <i className="block bg-surface-3" style={{ width: pct(p.pDraw, 2) }} />
        <i className="block bg-[var(--ink-2)]" style={{ width: pct(p.pAway, 2) }} />
      </div>
      <div className="mt-1 grid grid-cols-3 font-mono text-[12px] tnum">
        <span className={fav === "home" ? "text-accent font-semibold" : "text-ink-2"}>{pct(p.pHome)}</span>
        <span className={`text-center ${fav === "draw" ? "text-ink font-semibold" : "text-ink-muted"}`}>draw {pct(p.pDraw)}</span>
        <span className={`text-right ${fav === "away" ? "text-ink font-semibold" : "text-ink-2"}`}>{pct(p.pAway)}</span>
      </div>
    </li>
  );
}

/** The slides' weighted binary tree, with each fork's weight from its own fixture. */
function StreakCard({ ds, predictions, defaultTeam }: { ds: Dataset; predictions: MatchPrediction[]; defaultTeam?: number }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [n, setN] = useState(5);
  const teamId = picked ?? defaultTeam ?? 0;
  const streak = teamId ? streakFor(predictions, teamId, n) : null;
  const short = (id: number) => ds.teamsById.get(id)?.short ?? `#${id}`;
  const teams = [...ds.bundle.teams].sort((a, b) => a.name.localeCompare(b.name));

  let running = 1;
  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b border-line">
        <p className="eyebrow">Streak calculator</p>
        <p className="text-[12.5px] text-ink-2 mt-1 leading-snug">
          P(win the next N in a row) is the product of each fixture's own win chance.
        </p>
      </div>
      <div className="px-4 py-3 grid gap-3">
        <select
          aria-label="Club for the streak"
          value={teamId}
          onChange={(e) => setPicked(Number(e.target.value))}
          className="bg-surface border border-line-strong rounded px-2 py-1.5 text-[13px]"
        >
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <Slider id="streak-n" label="Matches in the run" value={n} min={1} max={10} display={String(n)} onChange={setN} />
      </div>

      {!streak ? (
        <p className="px-4 pb-4 text-[13px] text-ink-muted">Not enough fixtures left for a run that long.</p>
      ) : (
        <>
          <div className="px-4 pb-3 grid grid-cols-2 gap-3">
            <div>
              <div className="eyebrow">win all {n}</div>
              <div className="font-mono text-[20px] tnum">{pct(streak.pWinAll, streak.pWinAll < 0.01 ? 2 : 1)}</div>
              <div className="text-[11.5px] text-ink-muted">{oneIn(streak.pWinAll)}</div>
            </div>
            <div>
              <div className="eyebrow">unbeaten</div>
              <div className="font-mono text-[20px] tnum">{pct(streak.pUnbeaten, 1)}</div>
              <div className="text-[11.5px] text-ink-muted">draws allowed</div>
            </div>
          </div>
          <table className="w-full text-[12.5px] border-t border-line">
            <thead>
              <tr className="text-ink-muted text-left">
                <th className="font-normal px-4 py-1.5">fork</th>
                <th className="font-normal py-1.5">fixture</th>
                <th className="font-normal py-1.5 text-right">win</th>
                <th className="font-normal px-4 py-1.5 text-right">run so far</th>
              </tr>
            </thead>
            <tbody className="font-mono tnum">
              {streak.steps.map((s, i) => {
                running *= s.pWin;
                return (
                  <tr key={i} className="border-t border-line">
                    <td className="px-4 py-1.5 text-ink-muted">GW{s.prediction.event}</td>
                    <td className="py-1.5">{s.home ? "vs" : "@"} {short(s.opponentId)}</td>
                    <td className="py-1.5 text-right">{pct(s.pWin, 1)}</td>
                    <td className="px-4 py-1.5 text-right">{pct(running, running < 0.01 ? 2 : 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

function BacktestCard({ test }: { test: ReturnType<typeof backtest> }) {
  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b border-line">
        <p className="eyebrow">How good is it?</p>
        <p className="text-[12.5px] text-ink-2 mt-1 leading-snug">
          Each finished gameweek re-predicted from earlier results only. Lower is better.
        </p>
      </div>
      {!test ? (
        <p className="px-4 py-4 text-[13px] text-ink-muted">
          Needs results from gameweek 4 onward. It fills in as the season goes.
        </p>
      ) : (
        <>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-ink-muted text-left">
                <th className="font-normal px-4 py-1.5" />
                <th className="font-normal py-1.5 text-right">log loss</th>
                <th className="font-normal py-1.5 text-right">Brier</th>
                <th className="font-normal px-4 py-1.5 text-right">pick</th>
              </tr>
            </thead>
            <tbody className="font-mono tnum">
              {([
                ["this model", test.model],
                ["base rates", test.baseRates],
                ["coin flip", test.coinFlip],
              ] as const).map(([label, s], i) => (
                <tr key={label} className={`border-t border-line ${i === 0 ? "text-accent font-semibold" : ""}`}>
                  <td className="px-4 py-1.5 font-sans">{label}</td>
                  <td className="py-1.5 text-right">{s.logLoss.toFixed(3)}</td>
                  <td className="py-1.5 text-right">{s.brier.toFixed(3)}</td>
                  <td className="px-4 py-1.5 text-right">{pct(s.pickRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 border-t border-line text-[11.5px] text-ink-muted leading-snug">
            {test.n} fixtures, goals only (season xG totals would leak later matches). Bookmakers
            usually land near 0.96–0.98 log loss on the Premier League.
          </p>
        </>
      )}
    </Card>
  );
}

function RatingsCard({ ds, model }: { ds: Dataset; model: MatchModel }) {
  const rows = [...ds.bundle.teams]
    .map((t) => {
      const att = Math.exp(model.att.get(t.id) ?? 0);
      const def = Math.exp(model.def.get(t.id) ?? 0);
      return { t, att, def, overall: att / def, played: model.played.get(t.id) ?? 0 };
    })
    .sort((a, b) => b.overall - a.overall);
  const maxOverall = rows[0]?.overall ?? 1;

  return (
    <Card className="mt-5 overflow-hidden">
      <div className="px-4 py-3 border-b border-line">
        <p className="eyebrow">Team ratings behind the predictions</p>
        <p className="text-[12.5px] text-ink-2 mt-1">
          1.00 = league average. Attack is goals scored relative to average; defence is goals
          conceded, so lower is better.
        </p>
      </div>
      <div className="scroll-x">
        <table className="w-full min-w-[460px] text-[12.5px]">
          <thead>
            <tr className="text-ink-muted text-left">
              <th className="font-normal px-4 py-1.5">#</th>
              <th className="font-normal py-1.5">club</th>
              <th className="font-normal py-1.5 text-right">attack</th>
              <th className="font-normal py-1.5 text-right">defence</th>
              <th className="font-normal py-1.5 pl-4 w-[34%]">overall</th>
              <th className="font-normal px-4 py-1.5 text-right">played</th>
            </tr>
          </thead>
          <tbody className="tnum">
            {rows.map((r, i) => (
              <tr key={r.t.id} className="border-t border-line">
                <td className="px-4 py-1.5 font-mono text-ink-muted">{i + 1}</td>
                <td className="py-1.5">{r.t.name}</td>
                <td className="py-1.5 text-right font-mono">{r.att.toFixed(2)}</td>
                <td className="py-1.5 text-right font-mono">{r.def.toFixed(2)}</td>
                <td className="py-1.5 pl-4">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-[6px] bg-surface-3 rounded-full overflow-hidden">
                      <div className="h-full bg-accent rounded-full" style={{ width: `${((r.overall / maxOverall) * 100).toFixed(1)}%` }} />
                    </div>
                    <span className="font-mono w-9 text-right">{r.overall.toFixed(2)}</span>
                  </div>
                </td>
                <td className="px-4 py-1.5 text-right font-mono text-ink-muted">{r.played}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
