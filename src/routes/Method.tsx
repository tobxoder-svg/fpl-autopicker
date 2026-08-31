import { useMemo, useState } from "react";
import { nbinomSf } from "../model/distributions";
import { Card, Chip } from "../components/ui";

const COMPONENTS = [
  {
    name: "Expected minutes",
    formula: "2·P(60′) + 1·(P(appear) − P(60′))",
    body: "The multiplier on every term below, and the highest-leverage part of the whole model. Start rate and minute share are measured against the club's matches played, not the player's own appearances — one start in one appearance is not a nailed starter — then regressed toward a prior and scaled by the availability flag.",
  },
  {
    name: "Attacking returns",
    formula: "xG·goal_pts + xA·3",
    body: "xG and xA per 90, adjusted by team attack × opponent defence × venue. Both rates are regressed toward a positional prior by sample size — see below, because that regression is load-bearing.",
  },
  {
    name: "Clean sheet",
    formula: "P(0 conceded) · P(60′) · cs_pts",
    body: "Poisson on modelled opponent goals. The 60-minute condition is real and matters: a full-back on 55 minutes gets nothing.",
  },
  {
    name: "Goals conceded",
    formula: "−E[⌊conceded / 2⌋]",
    body: "Routinely omitted by public models. It is the difference between a cheap defender on a leaky side being playable and being a trap, and it grows faster than people expect against strong attacks.",
  },
  {
    name: "Defensive contribution",
    formula: "P(actions ≥ threshold) · 2",
    body: "10 CBIT for defenders, 12 CBIRT for midfielders and forwards, capped at 2 points. Modelled negative-binomial with a possession term — see below. Goalkeepers are excluded from the scoring entirely.",
  },
  {
    name: "Saves",
    formula: "E[⌊saves / 3⌋]",
    body: "Goalkeepers only, scaled by opponent attacking strength. The reason a keeper at a poor side can out-score a keeper at a good one on a bad fixture week.",
  },
  {
    name: "Bonus",
    formula: "shrunk positional prior",
    body: "The weakest term, deliberately. See the caveats below.",
    weak: true,
  },
  {
    name: "Discipline",
    formula: "−yellow − 3·red",
    body: "Small, but card risk correlates with the high-volume defenders that the DEFCON term rewards, so it partially cancels that edge. Leaving it out would flatter exactly the players the model is most bullish on.",
  },
];

export default function Method() {
  return (
    <div className="max-w-[1180px] mx-auto px-5 py-10">
      <header className="max-w-[68ch]">
        <p className="eyebrow">Method</p>
        <h1 className="font-display text-[clamp(28px,4.5vw,42px)] font-bold tracking-[-0.025em] mt-2 leading-[1.06]">
          How a player becomes a number
        </h1>
        <p className="mt-4 text-[15px] text-ink-2 leading-relaxed">
          Expected points is the only thing the optimiser sees. If it is wrong, a perfect solver
          returns a perfectly wrong squad — so the model is built as eight separate terms that can
          each be tested against actual points on their own, rather than one fitted regressor that
          can only ever be wrong as a whole.
        </p>
      </header>

      <section className="mt-10 grid md:grid-cols-2 gap-4">
        {COMPONENTS.map((c, i) => (
          <Card key={c.name} className="p-4">
            <div className="flex items-baseline gap-2.5 flex-wrap mb-1.5">
              <span className="font-mono text-[11px] text-ink-muted tnum">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h2 className="font-display text-[16px] font-semibold">{c.name}</h2>
              {c.weak && <Chip tone="loss">weak</Chip>}
            </div>
            <p className="font-mono text-[11.5px] text-accent mb-2 scroll-x whitespace-nowrap">
              {c.formula}
            </p>
            <p className="text-[13px] text-ink-2 leading-relaxed">{c.body}</p>
          </Card>
        ))}
      </section>

      <SmallSamples />
      <PossessionSection />

      <section className="mt-12 border-t border-line pt-10 grid lg:grid-cols-2 gap-8">
        <div>
          <h2 className="font-display text-[22px] font-bold tracking-tight">What the solver solves</h2>
          <p className="mt-3 text-[13.5px] text-ink-2 leading-relaxed">
            A mixed-integer program with three binaries per candidate: in the squad, in the starting
            XI, captain. Squad shape, budget, the three-per-club rule and the formation bounds are
            hard constraints, so an illegal squad is not merely discouraged — it cannot be
            represented. HiGHS, compiled to WebAssembly, proves optimality on a 600-player pool in
            well under a second.
          </p>
          <p className="mt-3 text-[13.5px] text-ink-2 leading-relaxed">
            Alternatives come from re-solving with a constraint that the new squad share at most
            13 players with each previous one. Without that, the "alternatives" are the same squad
            with one bench defender swapped, which tells you nothing about how robust the top pick
            is.
          </p>
        </div>

        <div>
          <h2 className="font-display text-[22px] font-bold tracking-tight">What it does not yet do</h2>
          <p className="mt-3 text-[13.5px] text-ink-2 leading-relaxed">
            Transfers. The current model picks a squad from scratch and solves the next gameweek's XI
            and captain exactly, with later gameweeks entering as a decayed squad-level value. It
            does not plan transfers, hits or chips across the horizon.
          </p>
          <p className="mt-3 text-[13.5px] text-ink-2 leading-relaxed">
            That is the next milestone, and its one real trap is worth stating in advance: the
            free-transfer rollover{" "}
            <code className="font-mono text-[12px] bg-surface-3 px-1.5 py-0.5 rounded">
              ft[t+1] = min(5, ft[t] − used[t] + 1)
            </code>{" "}
            is non-linear and needs auxiliary binaries with a big-M. It is where multi-gameweek FPL
            models quietly begin emitting illegal transfer plans.
          </p>
        </div>
      </section>

      <Caveats />
    </div>
  );
}

function SmallSamples() {
  return (
    <section className="mt-12 border-t border-line pt-10">
      <h2 className="font-display text-[clamp(20px,2.8vw,28px)] font-bold tracking-tight max-w-[26ch]">
        Why every rate is dragged back toward the average
      </h2>
      <div className="mt-4 grid lg:grid-cols-2 gap-8 items-start">
        <div>
          <p className="text-[14px] text-ink-2 leading-relaxed">
            Each per-90 rate is regressed toward a positional prior, weighted by minutes
            played — 450 minutes of prior against however much the player has actually given
            you. Without it, small samples become the model's favourite players.
          </p>
          <p className="mt-3 text-[14px] text-ink-2 leading-relaxed">
            This is not hypothetical. On the first run against live data, a midfielder who had
            played <b className="text-ink font-semibold">one minute</b> projected 128 points
            over five gameweeks — roughly six times Haaland — because three touches
            extrapolated to 96 defensive actions per 90. Regressing start probability alone
            does not fix it; the rates themselves have to be regressed, or the optimiser goes
            looking for exactly these artefacts and builds a squad out of them.
          </p>
        </div>
        <Card className="p-4">
          <div className="eyebrow mb-3">The same player, before and after</div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-2 items-baseline text-[13px]">
            <div className="text-ink-muted text-[11.5px] uppercase tracking-wider font-mono">Metric</div>
            <div className="text-loss text-[11.5px] uppercase tracking-wider font-mono text-right">Raw</div>
            <div className="text-accent text-[11.5px] uppercase tracking-wider font-mono text-right">Shrunk</div>
            {[
              ["Minutes played", "1", "1"],
              ["Defensive actions / 90", "96.0", "5.2"],
              ["P(DEFCON) next GW", "85%", "0%"],
              ["xP over 5 GW", "128.6", "4.8"],
            ].map(([k, a, c]) => (
              <div key={k} className="contents">
                <div className="text-ink-2">{k}</div>
                <div className="font-mono tnum text-right text-loss">{a}</div>
                <div className="font-mono tnum text-right text-accent">{c}</div>
              </div>
            ))}
          </div>
          <p className="text-[11.5px] text-ink-muted mt-3 leading-snug">
            Pinned as a regression test — the model suite fails if a one-minute substitute can
            out-project a regular starter again.
          </p>
        </Card>
      </div>
    </section>
  );
}

/**
 * An interactive demonstration beats a paragraph here — the possession effect is
 * the least intuitive thing in the model and the easiest to disbelieve.
 */
function PossessionSection() {
  const [possession, setPossession] = useState(37);
  const [rate, setRate] = useState(11.5);
  const [threshold, setThreshold] = useState(10);

  const curve = useMemo(() => {
    const pts: Array<[number, number]> = [];
    for (let poss = 25; poss <= 70; poss++) {
      const mean = rate * Math.pow((1 - poss / 100) / 0.5, 0.6) * (78 / 90);
      pts.push([poss, nbinomSf(threshold, mean, 6.5)]);
    }
    return pts;
  }, [rate, threshold]);

  const here = curve.find(([p]) => p === possession)?.[1] ?? 0;
  const W = 520, H = 190, ML = 40, MR = 14, MT = 12, MB = 30;
  const iw = W - ML - MR, ih = H - MT - MB;
  const x = (v: number) => ML + ((v - 25) / 45) * iw;
  const y = (v: number) => MT + ih - v * ih;
  const path = curve.map(([a, b], i) => `${i ? "L" : "M"} ${x(a).toFixed(1)} ${y(b).toFixed(1)}`).join(" ");

  return (
    <section className="mt-12 border-t border-line pt-10">
      <h2 className="font-display text-[clamp(20px,2.8vw,28px)] font-bold tracking-tight max-w-[26ch]">
        The possession term, which is where the edge is
      </h2>
      <p className="mt-3 text-[14px] text-ink-2 leading-relaxed max-w-[64ch]">
        Defensive contribution opportunity scales with the <em>opponent's</em> share of the ball. A
        defender on a low-possession side spends more of the match defending and clears the
        threshold far more often than an equally capable player at a possession-dominant club.
        Nothing about the player changes — only the context.
      </p>

      <div className="mt-6 grid lg:grid-cols-[minmax(0,1fr)_260px] gap-6 items-start">
        <Card className="p-4">
          <figure>
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
              aria-label="Probability of reaching the defensive contribution threshold against team possession share">
              {[0, 0.25, 0.5, 0.75, 1].map((g) => (
                <g key={g}>
                  <line x1={ML} x2={W - MR} y1={y(g)} y2={y(g)} stroke="var(--border)" strokeWidth="1" />
                  <text x={ML - 7} y={y(g) + 3.5} textAnchor="end"
                    className="font-mono" fontSize="10" fill="var(--ink-muted)">
                    {(g * 100).toFixed(0)}%
                  </text>
                </g>
              ))}
              {[30, 40, 50, 60, 70].map((t) => (
                <text key={t} x={x(t)} y={H - 10} textAnchor="middle"
                  className="font-mono" fontSize="10" fill="var(--ink-muted)">
                  {t}%
                </text>
              ))}
              <path d={`${path} L ${x(70)} ${MT + ih} L ${x(25)} ${MT + ih} Z`} fill="var(--accent)" opacity="0.12" />
              <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
              <line x1={x(possession)} x2={x(possession)} y1={MT} y2={MT + ih}
                stroke="var(--ink-muted)" strokeWidth="1" strokeDasharray="3 3" />
              <circle cx={x(possession)} cy={y(here)} r="4.5"
                fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
            </svg>
            <figcaption className="text-[12.5px] text-ink-2 mt-3 leading-relaxed">
              At {possession}% possession, a player averaging {rate.toFixed(1)} defensive actions per
              90 reaches {threshold} actions{" "}
              <b className="font-semibold text-ink tnum">{(here * 100).toFixed(0)}%</b> of the time.
              Horizontal axis is that player's own team's share of the ball.
            </figcaption>
          </figure>
        </Card>

        <Card className="p-4 grid gap-4">
          <label className="block">
            <span className="text-[12.5px] text-ink-2">
              Team possession — <b className="text-ink font-semibold tnum">{possession}%</b>
            </span>
            <input type="range" min={25} max={70} value={possession}
              onChange={(e) => setPossession(Number(e.target.value))} className="mt-1.5" />
          </label>
          <label className="block">
            <span className="text-[12.5px] text-ink-2">
              Actions per 90 — <b className="text-ink font-semibold tnum">{rate.toFixed(1)}</b>
            </span>
            <input type="range" min={2} max={16} step={0.5} value={rate}
              onChange={(e) => setRate(Number(e.target.value))} className="mt-1.5" />
          </label>
          <div>
            <span className="text-[12.5px] text-ink-2 block mb-1.5">Threshold</span>
            <div className="flex gap-0 border border-line-strong rounded-md overflow-hidden w-fit">
              {[10, 12].map((t) => (
                <button key={t} type="button" onClick={() => setThreshold(t)}
                  aria-pressed={threshold === t}
                  className={`text-[12.5px] px-3 py-1.5 ${threshold === t ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2"}`}>
                  {t === 10 ? "DEF · 10" : "MID/FWD · 12"}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11.5px] text-ink-muted leading-snug">
            Counts are negative-binomial, not Poisson. The same player swings between 4 and 15
            actions on game state, and Poisson understates the right tail that actually earns the
            point.
          </p>
        </Card>
      </div>
    </section>
  );
}

const CAVEATS = [
  {
    title: "Bonus is a prior, not a fit",
    body: "The bonus-point system was retuned for 2026/27 to reduce its overlap with defensive contribution and improve bonus for goalkeepers, full-backs and attackers. Any model fitted on last season's data is therefore biased. This one uses a heavily shrunk positional prior instead, and should be refitted once enough of this season has been played — treat bonus-driven differences between similar players as noise until then.",
  },
  {
    title: "Possession is derived, not measured",
    body: "The FPL API does not publish possession. It is inferred from how many defensive actions a club's players accumulate per 90 relative to the league, blended toward a fixture-difficulty prior while sample sizes are small. Checked against live data it ranks Manchester City, Arsenal and Chelsea highest and Hull, Ipswich and Leeds lowest — right, and still a proxy. Wiring in a real feed is the single highest-value data upgrade available.",
  },
  {
    title: "Attacking returns include penalties",
    body: "The API reports total expected goals, not non-penalty expected goals, and exposes no penalties-scored figure to net them out. The separate penalty term is therefore held at zero — adding it would count every penalty taker twice. The cost is that a newly appointed taker gets no credit until they have actually taken one.",
  },
  {
    title: "Team strength is reconstructed",
    body: "Every strength field the API publishes for clubs is zero, and the overall strength value is null — they are simply not populated. Attack and defence ratings are rebuilt from fixture difficulty, which is populated, blended with observed expected goals for and against as the season accumulates. It works, but it is a reconstruction of something the API is supposed to provide directly.",
  },
  {
    title: "Transfers are not planned",
    body: "The optimiser builds a squad from scratch. It does not know what you already own, so it will happily recommend eleven changes. Until multi-gameweek transfer planning lands, read the output as 'what a clean slate looks like', not as a transfer instruction.",
  },
  {
    title: "Expected points are not points",
    body: "A projection is a distribution's mean. Over a single gameweek the variance dwarfs the differences between the top handful of squads, and the optimiser cannot tell you which of them will actually score more. That is what the alternatives view is for.",
  },
];

function Caveats() {
  return (
    <section className="mt-12 border-t border-line pt-10">
      <h2 className="font-display text-[clamp(20px,2.8vw,28px)] font-bold tracking-tight">
        What is still weak
      </h2>
      <p className="mt-3 text-[14px] text-ink-2 max-w-[62ch] leading-relaxed">
        Stated plainly, because a model whose limitations are hidden is worse than a simpler one
        whose limitations are known.
      </p>
      <div className="mt-6 grid md:grid-cols-2 gap-4">
        {CAVEATS.map((c) => (
          <Card key={c.title} className="p-4 border-l-2 border-l-loss">
            <h3 className="font-display text-[15px] font-semibold text-loss mb-1.5">{c.title}</h3>
            <p className="text-[13px] text-ink-2 leading-relaxed">{c.body}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
