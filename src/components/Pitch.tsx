import { useCallback, useRef, useState } from "react";
import type { Position } from "../model/types";
import { canSwap, type SquadState } from "../lib/squad";
import { kitFor } from "../lib/kits";

export interface PitchPlayer {
  id: number;
  name: string;
  pos: Position;
  teamId: number;
  teamShort: string;
  cost: number;
  xp: number;
  /** e.g. "EVE (A)" — blank on a blank gameweek. */
  fixture: string;
  /** Official fixture difficulty, 1 (easiest) to 5. */
  difficulty: number | null;
}

const ROWS: Position[] = ["GK", "DEF", "MID", "FWD"];

/* ------------------------------------------------------------------ shirt */

function Shirt({ teamShort, teamId, compact }: { teamShort: string; teamId: number; compact?: boolean }) {
  const kit = kitFor(teamShort, teamId);
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden
      focusable="false"
      className={
        compact
          ? "w-[30px] h-[30px] sm:w-[38px] sm:h-[38px]"
          : "w-[34px] h-[34px] sm:w-[44px] sm:h-[44px]"
      }
    >
      <g
        stroke={kit.outline ? "rgba(20,24,31,.5)" : "rgba(0,0,0,.25)"}
        strokeWidth="0.9"
        strokeLinejoin="round"
      >
        {/* sleeves sit behind the body */}
        <path d="M11.5 8 L3.5 12.5 L7 21.5 L11.5 18.5 Z" fill={kit.sleeve} />
        <path d="M28.5 8 L36.5 12.5 L33 21.5 L28.5 18.5 Z" fill={kit.sleeve} />
        <path
          d="M11.5 8 L16 8 Q20 12.8 24 8 L28.5 8 L28.5 32.5 Q28.5 34.5 26.5 34.5 L13.5 34.5 Q11.5 34.5 11.5 32.5 Z"
          fill={kit.base}
        />
        <path d="M16 8 Q20 12.8 24 8 Z" fill={kit.sleeve} />
      </g>
    </svg>
  );
}

/* --------------------------------------------------------------- fixtures */

/** Fixture difficulty as a subtle tint. Not a chart colour — a status band. */
function difficultyTone(d: number | null): string {
  if (d === null) return "text-white/70";
  if (d <= 2) return "text-emerald-200";
  if (d === 3) return "text-white/80";
  if (d === 4) return "text-amber-200";
  return "text-rose-200";
}

/* ------------------------------------------------------------------- card */

interface CardProps {
  player: PitchPlayer;
  isCaptain: boolean;
  isSelected: boolean;
  dragState: "idle" | "dragging" | "valid" | "invalid" | "over";
  onPointerDown: (e: React.PointerEvent, id: number) => void;
  onCaptain: (id: number) => void;
  compact?: boolean;
}

function PlayerCard({
  player,
  isCaptain,
  isSelected,
  dragState,
  onPointerDown,
  onCaptain,
  compact,
}: CardProps) {
  const dim = dragState === "invalid";
  return (
    <div
      data-player-id={player.id}
      onPointerDown={(e) => onPointerDown(e, player.id)}
      role="button"
      tabIndex={0}
      aria-label={`${player.name}, ${player.pos}, ${player.xp.toFixed(1)} expected points`}
      className={[
        "relative flex flex-col items-center select-none cursor-grab active:cursor-grabbing",
        "touch-none transition-[opacity,transform] duration-150",
        compact ? "w-[54px] sm:w-[68px]" : "w-[58px] sm:w-[76px]",
        dragState === "dragging" ? "opacity-30" : "",
        dim ? "opacity-35" : "",
        dragState === "over" ? "scale-110 z-20" : "",
      ].join(" ")}
    >
      {/* expected points — the number FPL's own pitch does not show you */}
      <span
        className={[
          "absolute -top-1 left-0 z-10 font-mono text-[9px] sm:text-[10px] font-semibold tnum",
          "px-1 sm:px-1.5 py-[1px] rounded-[3px] shadow-sm",
          "bg-[var(--surface)] text-[var(--ink)] border border-black/10",
        ].join(" ")}
      >
        {player.xp.toFixed(1)}
      </span>

      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onCaptain(player.id);
        }}
        title={isCaptain ? "Captain" : "Make captain"}
        className={[
          "absolute -top-1 right-0 z-10 w-[15px] h-[15px] sm:w-[17px] sm:h-[17px] rounded-full grid place-items-center",
          "font-mono text-[9px] font-bold border transition-colors",
          // Gated on hover *capability*, not screen width: a pointer device
          // reveals it on hover so eleven pale badges don't clutter the pitch,
          // while a touch device — which can never hover — keeps it visible,
          // because a control you cannot discover by touch may as well not exist.
          isCaptain
            ? "bg-[var(--ink)] text-[var(--surface)] border-transparent"
            : [
                "bg-white/80 text-black/45 border-black/10 hover:bg-white",
                "[@media(hover:hover)]:opacity-0",
                "[@media(hover:hover)]:group-hover:opacity-100",
                "focus-visible:opacity-100",
              ].join(" "),
        ].join(" ")}
      >
        C
      </button>

      <Shirt teamShort={player.teamShort} teamId={player.teamId} compact={compact} />

      <div
        className={[
          "w-full -mt-1 rounded-[3px] text-center overflow-hidden shadow-sm",
          isSelected ? "ring-2 ring-[var(--accent)]" : "",
          dragState === "over" ? "ring-2 ring-white" : "",
        ].join(" ")}
      >
        <div className="bg-[var(--surface)] text-[var(--ink)] text-[9px] sm:text-[10.5px] font-semibold leading-[14px] sm:leading-[15px] px-1 truncate">
          {player.name}
        </div>
        <div className="bg-black/45 text-[8px] sm:text-[9.5px] leading-[13px] sm:leading-[14px] px-1 truncate font-mono">
          <span className={difficultyTone(player.difficulty)}>{player.fixture || "—"}</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pitch */

interface PitchProps {
  players: Map<number, PitchPlayer>;
  state: SquadState;
  selectedId: number | null;
  onSwap: (a: number, b: number) => void;
  onSelect: (id: number) => void;
  onCaptain: (id: number) => void;
}

export default function Pitch({
  players,
  state,
  selectedId,
  onSwap,
  onSelect,
  onCaptain,
}: PitchProps) {
  const [drag, setDrag] = useState<{ id: number; x: number; y: number; over: number | null } | null>(
    null,
  );
  const startRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const overRef = useRef<number | null>(null);

  const posOf = useCallback((id: number) => players.get(id)?.pos, [players]);

  const handlePointerDown = useCallback((e: React.PointerEvent, id: number) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startRef.current = { id, x: e.clientX, y: e.clientY, moved: false };
    overRef.current = null;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // A short press is a click; past six pixels it becomes a drag.
    if (!s.moved && Math.hypot(dx, dy) < 6) return;
    s.moved = true;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const slot = el?.closest("[data-player-id]");
    const raw = slot ? Number(slot.getAttribute("data-player-id")) : null;
    const over = raw !== null && raw !== s.id ? raw : null;
    overRef.current = over;
    setDrag({ id: s.id, x: e.clientX, y: e.clientY, over });
  }, []);

  const handlePointerUp = useCallback(() => {
    const s = startRef.current;
    startRef.current = null;
    if (!s) return;
    if (s.moved) {
      // Hand every attempted drop to the caller, including illegal ones — it
      // owns the rules and can explain the refusal rather than silently
      // snapping the card back with no reason given.
      const target = overRef.current;
      if (target !== null) onSwap(s.id, target);
    } else {
      onSelect(s.id);
    }
    overRef.current = null;
    setDrag(null);
  }, [onSelect, onSwap]);

  const cardState = (id: number): CardProps["dragState"] => {
    if (!drag) return "idle";
    if (drag.id === id) return "dragging";
    if (drag.over === id) return canSwap(state, drag.id, id, posOf) ? "over" : "invalid";
    return canSwap(state, drag.id, id, posOf) ? "valid" : "invalid";
  };

  const cardFor = (id: number, compact = false) => {
    const p = players.get(id);
    if (!p) return null;
    return (
      <div key={id} className="group">
        <PlayerCard
          player={p}
          isCaptain={state.captain === id}
          isSelected={selectedId === id}
          dragState={cardState(id)}
          onPointerDown={handlePointerDown}
          onCaptain={onCaptain}
          compact={compact}
        />
      </div>
    );
  };

  const dragged = drag ? players.get(drag.id) : null;

  return (
    <div
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* ---------------------------------------------------------- pitch */}
      <div className="relative rounded-t-lg overflow-hidden pitch-turf">
        <PitchMarkings />
        <div className="relative flex flex-col justify-around py-6 px-2 min-h-[420px] aspect-[10/13]">
          {ROWS.map((row) => {
            const ids = state.xi.filter((id) => players.get(id)?.pos === row);
            if (!ids.length) return <div key={row} className="h-0" />;
            return (
              <div key={row} className="flex justify-center gap-1.5 sm:gap-3">
                {ids.map((id) => cardFor(id))}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------------------------------------------------- bench */}
      <div className="rounded-b-lg pitch-bench border-t border-white/25 px-2 pt-2 pb-3">
        <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
          {state.bench.map((id, i) => (
            <div key={id} className="flex flex-col items-center">
              {/* Slot order matters: substitutions come on in this sequence, and
                  the reserve keeper can only replace the keeper. */}
              <span className="font-mono text-[9px] tracking-[0.08em] text-white/75 mb-1.5">
                {i === 0 ? "GKP" : `${i}. ${players.get(id)?.pos ?? ""}`}
              </span>
              {cardFor(id, true)}
            </div>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------ drag ghost */}
      {drag && dragged && (
        <div
          className="fixed z-50 pointer-events-none -translate-x-1/2 -translate-y-1/2 drop-shadow-lg"
          style={{ left: drag.x, top: drag.y }}
        >
          <div className="w-[76px] scale-110">
            <PlayerCard
              player={dragged}
              isCaptain={state.captain === dragged.id}
              isSelected={false}
              dragState="idle"
              onPointerDown={() => {}}
              onCaptain={() => {}}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Pitch lines, drawn to the real proportions of a portrait-orientation pitch. */
function PitchMarkings() {
  const line = "rgba(255,255,255,0.34)";
  return (
    <svg
      className="absolute inset-0 w-full h-full"
      viewBox="0 0 100 150"
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
    >
      <g fill="none" stroke={line} strokeWidth="0.5" vectorEffect="non-scaling-stroke">
        <rect x="3" y="3" width="94" height="144" />
        <line x1="3" y1="75" x2="97" y2="75" />
        <circle cx="50" cy="75" r="13" />
        <rect x="24" y="3" width="52" height="22" />
        <rect x="38" y="3" width="24" height="9" />
        <path d="M35 25 A 16 16 0 0 0 65 25" />
        <rect x="24" y="125" width="52" height="22" />
        <rect x="38" y="138" width="24" height="9" />
        <path d="M35 125 A 16 16 0 0 1 65 125" />
      </g>
      <g fill={line}>
        <circle cx="50" cy="75" r="0.9" />
        <circle cx="50" cy="18" r="0.9" />
        <circle cx="50" cy="132" r="0.9" />
      </g>
    </svg>
  );
}
