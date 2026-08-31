import { Link } from "react-router-dom";
import { useMemo } from "react";
import { useDataset } from "../lib/useDataset";
import { projectAll } from "../lib/projections";
import { DEFAULT_STRATEGY } from "../model/types";
import { Card, Chip } from "../components/ui";

const money = (t: number) => `£${(t / 10).toFixed(1)}m`;

export default function Landing() {
  return (
    <div className="max-w-[1180px] mx-auto px-5">
      <Hero />
      <Differentiators />
      <Tiers />
      <Pipeline />
      <Closing />
    </div>
  );
}

function Hero() {
  return (
    <section className="pt-14 pb-16 grid lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-10 items-start">
      <div>
        <div className="flex flex-wrap gap-2 mb-5">
          <Chip tone="accent">2026/27</Chip>
          <Chip>Solver runs in your browser</Chip>
          <Chip>No account</Chip>
        </div>
        <h1 className="font-display text-[clamp(34px,6vw,58px)] font-bold leading-[1.02] tracking-[-0.03em]">
          Most FPL tools optimise a projection they never show you.
        </h1>
        <p className="mt-5 text-[16px] text-ink-2 leading-relaxed max-w-[58ch]">
          Fantasy Drafter takes the opposite position. The expected-points model is eight separate,
          inspectable terms; every squad it returns can be opened up and argued with. The
          mixed-integer solver runs on your own machine, so nothing you try is sent anywhere.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            to="/builder"
            className="rounded-md bg-accent text-accent-ink font-medium text-[14.5px] px-5 py-2.5 hover:opacity-90 transition-opacity"
          >
            Open the builder
          </Link>
          <Link
            to="/method"
            className="rounded-md border border-line-strong font-medium text-[14.5px] px-5 py-2.5 hover:bg-surface-2 transition-colors"
          >
            Read the method
          </Link>
        </div>
      </div>

      <LivePanel />
    </section>
  );
}

/**
 * The hero panel runs the actual model on the actual data at page load. A static
 * screenshot would be easier and would prove nothing.
 */
function LivePanel() {
  const state = useDataset();
  const rows = useMemo(() => {
    if (state.status !== "ready") return [];
    return projectAll(state.dataset, { ...DEFAULT_STRATEGY, horizon: 5 })
      .filter((p) => p.player.minutes > 180 && p.xpHorizon > 0)
      .sort((a, b) => b.xpHorizon - a.xpHorizon)
      .slice(0, 7);
  }, [state]);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b border-line flex items-baseline justify-between gap-3">
        <span className="eyebrow">Live · highest projected, next 5 GW</span>
        {state.status === "ready" && state.dataset.isSample && <Chip tone="loss">sample</Chip>}
      </div>

      {state.status === "loading" && (
        <p className="px-4 py-8 text-[13px] text-ink-muted">Running the model…</p>
      )}
      {state.status === "error" && (
        <p className="px-4 py-8 text-[13px] text-ink-muted">
          No snapshot published yet — the scheduled workflow writes one.
        </p>
      )}

      {rows.length > 0 && (
        <div className="p-2">
          {rows.map((p) => (
            <div key={p.player.id} className="px-2 py-2">
              <div className="flex items-baseline gap-2">
                <span className="text-[13.5px] font-medium truncate">{p.player.webName}</span>
                <span className="font-mono text-[10.5px] text-ink-muted border border-line rounded px-1">
                  {p.player.pos}
                </span>
                <span className="font-mono text-[11px] text-ink-muted ml-auto">
                  {money(p.player.cost)}
                </span>
                <span className="font-mono text-[13px] tnum w-11 text-right">
                  {p.xpHorizon.toFixed(1)}
                </span>
              </div>
              <div className="h-[6px] bg-surface-3 rounded-full overflow-hidden mt-1.5">
                <div
                  className="h-full bg-accent rounded-full"
                  style={{
                    width: `${Math.max(4, (p.xpHorizon / rows[0].xpHorizon) * 100).toFixed(1)}%`,
                  }}
                />
              </div>
            </div>
          ))}
          <p className="px-2 pt-2 pb-1 text-[11.5px] text-ink-muted leading-snug">
            Expected points over the next five gameweeks, computed in your browser from the snapshot
            this page just loaded.
          </p>
        </div>
      )}
    </Card>
  );
}

const POINTS = [
  {
    title: "The projection is the product",
    body: "Eight additive terms — minutes, attacking returns, clean sheets, goals conceded, defensive contribution, saves, bonus, discipline. Each one is a pure function you can test on its own. When a projection misses, you can see which term was wrong.",
  },
  {
    title: "Defensive contribution, modelled properly",
    body: "DEFCON opportunity scales with the opponent's share of the ball, and the action counts are overdispersed. Modelling them negative-binomial rather than Poisson, with a possession term, is where the points most public tools leave on the table actually are.",
  },
  {
    title: "Several good squads, not one",
    body: "Small changes in expected points flip the single 'optimal' answer entirely. The solver returns a handful of squads that differ by a real number of players, with the gap between them shown, so you can judge how much the top pick is worth.",
  },
];

function Differentiators() {
  return (
    <section className="py-14 border-t border-line">
      <div className="grid md:grid-cols-3 gap-8">
        {POINTS.map((p) => (
          <div key={p.title}>
            <h2 className="font-display text-[17px] font-semibold mb-2">{p.title}</h2>
            <p className="text-[13.5px] text-ink-2 leading-relaxed">{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const TIERS = [
  {
    n: "Rules",
    owner: "Fantasy Premier League",
    rate: "once a season",
    open: false,
    items: ["£100.0m budget", "2-5-5-3 squad", "3 per club", "5 free transfers banked", "two chip sets, first expires GW19"],
  },
  {
    n: "Model",
    owner: "The projection",
    rate: "refit weekly",
    open: false,
    items: ["expected minutes", "npxG90 / xA90", "clean sheet & goals conceded", "DEFCON rate", "saves, bonus, cards"],
  },
  {
    n: "Strategy",
    owner: "You",
    rate: "every solve",
    open: true,
    items: ["horizon & decay", "bench weight", "risk aversion", "ownership pull", "locks & exclusions"],
  },
  {
    n: "Solver",
    owner: "HiGHS",
    rate: "rarely",
    open: false,
    items: ["MIP gap", "time limit", "alternatives returned", "minimum difference"],
  },
];

function Tiers() {
  return (
    <section className="py-14 border-t border-line">
      <h2 className="font-display text-[clamp(22px,3vw,30px)] font-bold tracking-tight max-w-[24ch]">
        Four kinds of parameter, and only one of them is yours to turn.
      </h2>
      <p className="mt-3 text-[14px] text-ink-2 max-w-[62ch]">
        Conflating these is what makes most optimisers unmaintainable. They have different owners
        and change at wildly different rates, so the app keeps them apart — and exposes exactly one
        tier in the interface.
      </p>

      <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {TIERS.map((t) => (
          <Card key={t.n} className={t.open ? "border-accent" : ""}>
            <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-2">
              <h3 className="font-display text-[15px] font-semibold">{t.n}</h3>
              {t.open ? <Chip tone="accent">exposed</Chip> : <Chip>internal</Chip>}
            </div>
            <div className="px-4 py-3">
              <p className="text-[11.5px] text-ink-muted mb-2.5">
                {t.owner} · {t.rate}
              </p>
              <ul className="grid gap-1">
                {t.items.map((i) => (
                  <li key={i} className="text-[12.5px] text-ink-2 leading-snug">
                    {i}
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

/** The static-hosting architecture, which is the reason the site costs nothing. */
function Pipeline() {
  const steps = [
    ["Scheduled Action", "fetches the FPL API on a cron"],
    ["bundle.json", "committed into the repo"],
    ["GitHub Pages", "serves it as a static file"],
    ["Your browser", "runs the model and the solver"],
  ];
  return (
    <section className="py-14 border-t border-line">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 items-start">
        <div>
          <h2 className="font-display text-[clamp(22px,3vw,30px)] font-bold tracking-tight max-w-[22ch]">
            No backend, because the API won't let you have one anyway.
          </h2>
          <p className="mt-3 text-[14px] text-ink-2 leading-relaxed max-w-[58ch]">
            The FPL API sends no CORS headers, so a browser can't call it directly. Rather than
            paying for a proxy, a scheduled workflow snapshots it into the repository and Pages
            serves the result. Prices move once a day at around 02:30 UK, so a snapshot is never
            meaningfully behind — and the whole thing costs nothing to run and cannot go down
            separately from GitHub.
          </p>
        </div>

        <ol className="grid gap-2.5">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-3.5 items-start">
              <span
                aria-hidden
                className="font-mono text-[11px] text-accent border border-accent rounded w-6 h-6 grid place-items-center shrink-0 mt-0.5 tnum"
              >
                {i + 1}
              </span>
              <div>
                <div className="text-[14px] font-medium">{title}</div>
                <div className="text-[12.5px] text-ink-2">{body}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="py-14 border-t border-line">
      <Card className="px-6 py-7 sm:px-8 sm:py-9">
        <h2 className="font-display text-[clamp(20px,2.6vw,26px)] font-bold tracking-tight max-w-[30ch]">
          Every number on this site can be traced back to a line of code.
        </h2>
        <p className="mt-3 text-[14px] text-ink-2 max-w-[60ch] leading-relaxed">
          Including the parts that are still weak. The bonus term is a shrunk prior rather than a
          fit, because the bonus-point system was retuned this season and last season's data is
          biased. The possession figure behind DEFCON is derived, not measured. Both are documented
          on the method page rather than buried.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            to="/builder"
            className="rounded-md bg-accent text-accent-ink font-medium text-[14.5px] px-5 py-2.5 hover:opacity-90 transition-opacity"
          >
            Build a squad
          </Link>
          <Link
            to="/method"
            className="rounded-md border border-line-strong font-medium text-[14.5px] px-5 py-2.5 hover:bg-surface-2 transition-colors"
          >
            See what's still weak
          </Link>
        </div>
      </Card>
    </section>
  );
}
