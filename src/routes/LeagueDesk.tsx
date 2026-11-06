/**
 * League Desk — what's happening in the Premier League itself, as opposed to
 * what's happening in your fantasy team. Four boards: live scores, the table,
 * top scorers, top assists.
 *
 * None of this comes from a standings endpoint, because FPL doesn't publish
 * one. The table is counted from finished fixtures and the scorer lists are
 * season totals carried on each player (src/lib/league.ts). Live scores come
 * from /api/live, which exists only on Vercel; everywhere else the board falls
 * back to the data snapshot and says so.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDataset } from "../lib/useDataset";
import type { Dataset } from "../lib/data";
import {
  boardFromBundle,
  fetchBoard,
  hasMatchInPlay,
  leagueTable,
  matchDay,
  matchStatus,
  topBy,
  type LiveBoard,
  type LiveMatch,
  type ScorerRow,
  type TableRow,
} from "../lib/league";
import { Card, Chip } from "../components/ui";

/** The theme's emphasis block. Never the bare `invert` class — Tailwind owns that one. */
const INV = "bg-accent text-accent-ink";

/** How often to re-check while a match is being played. */
const POLL_MS = 60_000;

const LAST_EVENT = 38;

function Shell({ children }: { children: ReactNode }) {
  return <div className="max-w-[1180px] mx-auto px-4 sm:px-5 pt-8 pb-4">{children}</div>;
}

export default function LeagueDesk() {
  const state = useDataset();

  if (state.status === "loading") {
    return (
      <Shell>
        <p className="text-ink-2">Loading the data snapshot…</p>
      </Shell>
    );
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
  return <DeskPage ds={state.dataset} />;
}

function DeskPage({ ds }: { ds: Dataset }) {
  const { bundle } = ds;
  const defaultEvent = bundle.currentEvent ?? bundle.nextEvent ?? 1;
  const [event, setEvent] = useState(defaultEvent);

  const table = useMemo(() => leagueTable(bundle), [bundle]);
  const scorers = useMemo(() => topBy(bundle, "goals"), [bundle]);
  const assisters = useMemo(() => topBy(bundle, "assists"), [bundle]);

  // The board starts from the snapshot so something is on screen immediately,
  // then /api/live replaces it if it answers.
  const [board, setBoard] = useState<LiveBoard>(() => boardFromBundle(bundle, defaultEvent));
  const [loading, setLoading] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(
    async (ev: number) => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setLoading(true);
      const next = await fetchBoard(bundle, ev, ctrl.signal);
      if (!ctrl.signal.aborted) {
        setBoard(next);
        setLoading(false);
      }
    },
    [bundle],
  );

  useEffect(() => {
    setBoard(boardFromBundle(bundle, event));
    void load(event);
    return () => abort.current?.abort();
  }, [event, bundle, load]);

  // Only poll while something is actually being played — an idle tab on a
  // Tuesday shouldn't call anything.
  const inPlay = hasMatchInPlay(board);
  useEffect(() => {
    if (!inPlay) return;
    const id = setInterval(() => void load(event), POLL_MS);
    return () => clearInterval(id);
  }, [inPlay, event, load]);

  const totalGoals = table.reduce((s, r) => s + r.goalsFor, 0);
  const played = Math.round(table.reduce((s, r) => s + r.played, 0) / 2);

  return (
    <Shell>
      {ds.isSample && (
        <Card className="p-4 mb-5">
          <p className="text-[13px] text-ink-2">
            <b className="text-ink font-semibold">Sample data.</b> These are invented clubs and players — the
            table and the scorer lists are real arithmetic on made-up results.
          </p>
        </Card>
      )}

      <header className="mb-6">
        <span className="eyebrow">League desk</span>
        <h1 className="text-[26px] sm:text-[32px] font-semibold tracking-tight mt-1">Premier League</h1>
        <p className="text-[13px] text-ink-2 mt-1">
          {bundle.season} · {played} {played === 1 ? "match" : "matches"} played · {totalGoals} goals
        </p>
      </header>

      <div className="grid gap-5 [&>*]:min-w-0">
        <LiveScores
          board={board}
          ds={ds}
          event={event}
          loading={loading}
          onEvent={setEvent}
          onRefresh={() => void load(event)}
        />
        <LeagueTable rows={table} />
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <ScorerBoard title="Top scorers" unit="goals" rows={scorers} />
          <ScorerBoard title="Top assists" unit="assists" rows={assisters} />
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Live scores
// ---------------------------------------------------------------------------

function LiveScores({
  board,
  ds,
  event,
  loading,
  onEvent,
  onRefresh,
}: {
  board: LiveBoard;
  ds: Dataset;
  event: number;
  loading: boolean;
  onEvent: (e: number) => void;
  onRefresh: () => void;
}) {
  const live = hasMatchInPlay(board);
  const days = useMemo(() => {
    const out: Array<{ day: string; matches: LiveMatch[] }> = [];
    for (const m of board.matches) {
      const day = matchDay(m);
      const last = out[out.length - 1];
      if (last && last.day === day) last.matches.push(m);
      else out.push({ day, matches: [m] });
    }
    return out;
  }, [board]);

  return (
    <Card className="p-4">
      <div className="flex items-baseline gap-2 flex-wrap mb-3">
        <span className="eyebrow">Live scores</span>
        {live ? <Chip tone="accent">live</Chip> : null}
        {board.source === "offline" ? <Chip>offline</Chip> : null}
        <div className="ml-auto flex items-center gap-1">
          <StepButton label="Previous gameweek" onClick={() => onEvent(event - 1)} disabled={event <= 1}>
            ‹
          </StepButton>
          <span className={`${INV} px-2.5 py-1 text-[11px] tracking-[0.12em] uppercase tnum`}>GW{event}</span>
          <StepButton label="Next gameweek" onClick={() => onEvent(event + 1)} disabled={event >= LAST_EVENT}>
            ›
          </StepButton>
        </div>
      </div>

      {board.matches.length === 0 ? (
        <p className="text-[13px] text-ink-2">No matches scheduled for gameweek {event}.</p>
      ) : (
        days.map(({ day, matches }) => (
          <section key={day} className="mt-3 first:mt-0">
            <h3 className="eyebrow border-b border-line pb-1.5 mb-1">{day}</h3>
            <ul>
              {matches.map((m, i) => (
                <MatchRow key={m.id ?? `${m.teamH}-${m.teamA}-${i}`} m={m} ds={ds} />
              ))}
            </ul>
          </section>
        ))
      )}

      <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-line">
        <p className="text-[11.5px] text-ink-muted">
          {board.source === "live" && (
            <>
              Live from FPL{board.generatedAt ? ` · ${timeOf(board.generatedAt)}` : ""}
              {live ? " · refreshing every minute" : ""} · scorers appear once FPL confirms them, usually a few
              minutes after the goal.
            </>
          )}
          {board.source === "offline" && (
            <>
              Offline — showing the last copy this device saved
              {board.generatedAt ? `, from ${timeOf(board.generatedAt)}` : ""}. Scores may have moved on.
            </>
          )}
          {board.source === "bundle" && (
            <>From the data snapshot — final scores only. Live minutes and scorers need the hosted version of the app.</>
          )}
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="ml-auto border-[1.5px] border-line-strong px-2.5 py-1 text-[10.5px] tracking-[0.12em] uppercase text-ink-2 hover:bg-accent hover:text-accent-ink hover:border-accent transition-colors disabled:opacity-50"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>
    </Card>
  );
}

function StepButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="border-[1.5px] border-line-strong w-7 h-7 grid place-items-center text-[15px] leading-none text-ink-2 hover:bg-accent hover:text-accent-ink hover:border-accent transition-colors disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-2 disabled:hover:border-line-strong"
    >
      {children}
    </button>
  );
}

function MatchRow({ m, ds }: { m: LiveMatch; ds: Dataset }) {
  const { teamsById, playersById } = ds;
  const short = (id: number) => teamsById.get(id)?.short ?? `#${id}`;
  const full = (id: number) => teamsById.get(id)?.name ?? `Team ${id}`;
  const status = matchStatus(m);
  const hasScore = m.scoreH != null && m.scoreA != null;

  const label = (element: number, count: number) => {
    const name = playersById.get(element)?.webName ?? `#${element}`;
    return count > 1 ? `${name} ×${count}` : name;
  };
  // Scorers sit under the score they produced, so an own goal is listed with
  // the side that benefited — tagged, so nobody thinks their striker got it.
  const scorers = (side: "h" | "a") => [
    ...m.goals.filter((g) => g.team === side).map((g) => label(g.element, g.count)),
    ...m.ownGoals.filter((g) => g.team !== side).map((g) => `${label(g.element, g.count)} (og)`),
  ];

  const home = scorers("h");
  const away = scorers("a");

  return (
    <li className="border-b border-line last:border-b-0 py-2">
      <div className="grid grid-cols-[2.6rem_1fr_auto_1fr] items-center gap-x-2 text-[13px]">
        <span className={`tnum text-[11px] tracking-[0.06em] ${status.live ? "text-ink font-semibold" : "text-ink-muted"}`}>
          {status.label}
        </span>
        <span className="text-right truncate">
          <span className="sm:hidden">{short(m.teamH)}</span>
          <span className="hidden sm:inline">{full(m.teamH)}</span>
        </span>
        <span
          className={`tnum font-semibold px-2 py-0.5 min-w-[3.1rem] text-center ${
            status.live ? INV : hasScore ? "border border-line-strong" : "text-ink-muted"
          }`}
        >
          {hasScore ? `${m.scoreH}–${m.scoreA}` : "v"}
        </span>
        <span className="truncate">
          <span className="sm:hidden">{short(m.teamA)}</span>
          <span className="hidden sm:inline">{full(m.teamA)}</span>
        </span>
      </div>
      {(home.length > 0 || away.length > 0) && (
        <div className="grid grid-cols-[2.6rem_1fr_auto_1fr] gap-x-2 mt-1 text-[11px] text-ink-muted">
          <span />
          <span className="text-right">{home.join(", ")}</span>
          <span className="min-w-[3.1rem]" />
          <span>{away.join(", ")}</span>
        </div>
      )}
    </li>
  );
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
};

// ---------------------------------------------------------------------------
// League table
// ---------------------------------------------------------------------------

/** Top four play in Europe's top competition; the bottom three go down. */
function zoneOf(position: number, total: number): "top" | "drop" | null {
  if (position <= 4) return "top";
  if (position > total - 3) return "drop";
  return null;
}

function LeagueTable({ rows }: { rows: TableRow[] }) {
  const anyPlayed = rows.some((r) => r.played > 0);
  return (
    <Card className="p-4">
      <div className="flex items-baseline gap-2 flex-wrap mb-1">
        <span className="eyebrow">League table</span>
      </div>
      <p className="text-[12.5px] text-ink-2 mb-3">
        Counted from every finished match this season. Ordered by points, then goal difference, then goals scored.
      </p>

      {!anyPlayed ? (
        <p className="text-[13px] text-ink-2">No matches have been played yet.</p>
      ) : (
        <>
          <div className="scroll-x">
            <table className="w-full text-[12.5px] tnum border-collapse sm:min-w-[520px]">
              <thead>
                <tr className="text-left eyebrow">
                  <th className="font-normal py-1 pr-1 w-6 text-right">#</th>
                  <th className="font-normal py-1 pl-2 pr-2">Club</th>
                  <th className="font-normal py-1 px-1.5 text-right">P</th>
                  <th className="font-normal py-1 px-1.5 text-right hidden sm:table-cell">W</th>
                  <th className="font-normal py-1 px-1.5 text-right hidden sm:table-cell">D</th>
                  <th className="font-normal py-1 px-1.5 text-right hidden sm:table-cell">L</th>
                  <th className="font-normal py-1 px-1.5 text-right hidden md:table-cell">GF</th>
                  <th className="font-normal py-1 px-1.5 text-right hidden md:table-cell">GA</th>
                  <th className="font-normal py-1 px-1.5 text-right">GD</th>
                  <th className="font-normal py-1 pl-1.5 pr-2 text-right">Pts</th>
                  <th className="font-normal py-1 text-right hidden lg:table-cell">Last 5</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const zone = zoneOf(r.position, rows.length);
                  return (
                    <tr key={r.team.id} className="border-t border-line">
                      <td
                        className={`py-1.5 pr-1 text-right text-ink-muted border-l-[3px] ${
                          zone === "top" ? "border-l-accent" : zone === "drop" ? "border-l-loss" : "border-l-transparent"
                        }`}
                      >
                        {r.position}
                      </td>
                      <td className="py-1.5 pl-2 pr-2 whitespace-nowrap">
                        <span className="sm:hidden">{r.team.short}</span>
                        <span className="hidden sm:inline">{r.team.name}</span>
                      </td>
                      <td className="py-1.5 px-1.5 text-right text-ink-2">{r.played}</td>
                      <td className="py-1.5 px-1.5 text-right text-ink-2 hidden sm:table-cell">{r.won}</td>
                      <td className="py-1.5 px-1.5 text-right text-ink-2 hidden sm:table-cell">{r.drawn}</td>
                      <td className="py-1.5 px-1.5 text-right text-ink-2 hidden sm:table-cell">{r.lost}</td>
                      <td className="py-1.5 px-1.5 text-right text-ink-2 hidden md:table-cell">{r.goalsFor}</td>
                      <td className="py-1.5 px-1.5 text-right text-ink-2 hidden md:table-cell">{r.goalsAgainst}</td>
                      <td className="py-1.5 px-1.5 text-right text-ink-2">{r.goalDiff > 0 ? `+${r.goalDiff}` : r.goalDiff}</td>
                      <td className="py-1.5 pl-1.5 pr-2 text-right font-semibold">{r.points}</td>
                      <td className="py-1.5 text-right hidden lg:table-cell">
                        <Form results={r.form} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11.5px] text-ink-muted mt-3 flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block w-[3px] h-3 bg-accent align-middle" /> Top four
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block w-[3px] h-3 bg-loss align-middle" /> Relegation
            </span>
          </p>
        </>
      )}
    </Card>
  );
}

function Form({ results }: { results: string[] }) {
  if (results.length === 0) return <span className="text-ink-muted">—</span>;
  return (
    <span className="inline-flex gap-[3px] justify-end">
      {results.map((r, i) => (
        <span
          key={i}
          title={r === "W" ? "Win" : r === "D" ? "Draw" : "Loss"}
          className={`w-[15px] h-[15px] grid place-items-center text-[9.5px] font-semibold leading-none ${
            r === "W" ? INV : r === "L" ? "border border-loss text-loss" : "border border-line-strong text-ink-muted"
          }`}
        >
          {r}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Top scorers / assists
// ---------------------------------------------------------------------------

function ScorerBoard({ title, unit, rows }: { title: string; unit: string; rows: ScorerRow[] }) {
  return (
    <Card className="p-4">
      <span className="eyebrow">{title}</span>
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-2 mt-2">No {unit} recorded yet this season.</p>
      ) : (
        <ul className="mt-2">
          {rows.map((r, i) => (
            <li
              key={r.player.id}
              className="grid grid-cols-[1.6rem_1fr_auto] items-baseline gap-x-2 py-1.5 border-t border-line first:border-t-0 text-[13px]"
            >
              <span className={`tnum text-right text-[11.5px] ${i === 0 ? "text-ink font-semibold" : "text-ink-muted"}`}>
                {r.rank}
              </span>
              <span className="min-w-0 truncate">
                {r.player.webName}
                <span className="text-ink-muted"> · {r.team?.short ?? "—"}</span>
              </span>
              <span className="flex items-baseline gap-2">
                {r.per90 != null && (
                  <span className="tnum text-[11px] text-ink-muted hidden sm:inline">{r.per90.toFixed(2)}/90</span>
                )}
                <span className={`tnum font-semibold px-1.5 ${i === 0 ? INV : ""}`}>{r.count}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11.5px] text-ink-muted mt-3">
        Season totals from FPL. Players level on {unit} share a position.
      </p>
    </Card>
  );
}
