import type { ReactNode } from "react";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Slider({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  display,
  scale,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  scale?: [string, string];
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[12.5px] text-ink-2 mb-1.5">
        {label} — <b className="text-ink font-semibold">{display}</b>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {scale && (
        <div className="flex justify-between text-[10.5px] text-ink-muted mt-0.5">
          <span>{scale[0]}</span>
          <span>{scale[1]}</span>
        </div>
      )}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="font-mono text-[19px] font-medium tnum mt-0.5 tracking-tight">{value}</div>
      {hint && <div className="text-[11.5px] text-ink-muted mt-0.5">{hint}</div>}
    </div>
  );
}

export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "loss";
}) {
  const tones = {
    neutral: "border-line-strong text-ink-2 bg-surface",
    accent: "border-accent text-accent bg-accent-soft",
    loss: "border-loss text-loss bg-loss-soft",
  };
  return (
    <span
      className={`font-mono text-[10.5px] tracking-[0.09em] uppercase px-2 py-[3px] rounded-[3px] border whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Additive component decomposition. A waterfall, not a stacked bar: the terms
 * include negatives (goals conceded, cards), and a stacked bar cannot show a
 * running total that goes down.
 */
export function Waterfall({ items, total }: { items: Array<[string, number]>; total: number }) {
  const shown = items.filter(([, v]) => Math.abs(v) > 0.004);
  const tops: number[] = [];
  let run = 0;
  for (const [, v] of shown) {
    run += v;
    tops.push(run);
  }
  const scaleMax = Math.max(total, ...tops, 0.001) * 1.04;

  return (
    <div className="grid grid-cols-[86px_1fr_54px] gap-x-2.5 gap-y-[3px] items-center">
      {shown.map(([label, v], i) => {
        const start = i === 0 ? 0 : tops[i - 1];
        const lo = Math.min(start, tops[i]);
        const hi = Math.max(start, tops[i]);
        const pos = v >= 0;
        return (
          <div key={label} className="contents">
            <div className="text-[11.5px] text-ink-2 text-right leading-tight">{label}</div>
            <div className="relative h-[17px]" title={`${label}: ${pos ? "+" : "−"}${Math.abs(v).toFixed(2)} → ${tops[i].toFixed(2)}`}>
              <i
                className={`absolute top-0.5 h-[13px] rounded-[2px] block ${pos ? "bg-accent" : "bg-loss"}`}
                style={{
                  left: `${((lo / scaleMax) * 100).toFixed(2)}%`,
                  width: `${Math.max(0.5, ((hi - lo) / scaleMax) * 100).toFixed(2)}%`,
                }}
              />
            </div>
            <div className={`font-mono text-[11.5px] text-right tnum ${pos ? "text-accent" : "text-loss"}`}>
              {pos ? "+" : "−"}
              {Math.abs(v).toFixed(2)}
            </div>
          </div>
        );
      })}
      <div className="col-span-3 h-px bg-[var(--border)] my-1.5" />
      <div className="text-[11.5px] font-semibold text-right">Total xP</div>
      <div className="relative h-[17px]">
        <i
          className="absolute top-0.5 h-[13px] rounded-[2px] block bg-[var(--ink-2)]"
          style={{ left: 0, width: `${((total / scaleMax) * 100).toFixed(2)}%` }}
        />
      </div>
      <div className="font-mono text-[11.5px] text-right tnum font-semibold">{total.toFixed(2)}</div>
    </div>
  );
}
