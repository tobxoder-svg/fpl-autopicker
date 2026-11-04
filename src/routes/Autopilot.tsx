import { useEffect, useState } from "react";
import { Card, Chip } from "../components/ui";

const money = (tenths: number) => `£${(tenths / 10).toFixed(1)}m`;

interface Who {
  id: number;
  name: string;
  pos: string;
  club?: string;
}

/** Shape written by toProposal() in scripts/autopilot.mjs. */
interface Proposal {
  version: number;
  generatedAt: string;
  event: number;
  deadline: string;
  verdict: "EXECUTED" | "READY" | "NEEDS REVIEW" | "BLOCKED";
  transfers: Array<{ pos: string; out: Who & { price: number }; in: Who & { price: number } }>;
  bankAfter: number;
  freeTransfers: number | null;
  hits: number;
  hitCost: number;
  xpGain: number | null;
  lineup: {
    captain: { from: Who | null; to: Who } | null;
    vice: { from: Who | null; to: Who } | null;
    promoted: Who[];
    benched: Who[];
    benchOrder: Who[];
  };
  checks: Array<{ level: "ok" | "warn" | "fail"; msg: string }>;
}

type State =
  | { status: "loading" }
  | { status: "none" }
  | { status: "ready"; proposal: Proposal }
  | { status: "error"; message: string };

function untilDeadline(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "deadline passed";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `in ${Math.round(h / 24)} days`;
  return h ? `in ${h}h ${m}m` : `in ${m}m`;
}

const VERDICT_COPY: Record<Proposal["verdict"], string> = {
  EXECUTED: "Submitted to FPL and confirmed on your team.",
  READY: "Every rule and guardrail passes.",
  "NEEDS REVIEW": "Legal, but something deserves a look before the deadline.",
  BLOCKED: "Breaks a rule or one of your guardrails — fix the plan before the deadline.",
};

export default function Autopilot() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}data/proposal.json`, { cache: "no-cache" })
      .then(async (res) => {
        const isJson = (res.headers.get("content-type") ?? "").includes("json");
        if (cancelled) return;
        if (!res.ok || !isJson) return setState({ status: "none" });
        setState({ status: "ready", proposal: (await res.json()) as Proposal });
      })
      .catch(() => !cancelled && setState({ status: "error", message: "Offline, and no proposal is saved on this phone yet." }));
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  return (
    <div className="max-w-[860px] mx-auto px-4 sm:px-5 py-6 sm:py-7">
      <div className="mb-5">
        <h1 className="font-display text-[clamp(24px,3.5vw,32px)] font-bold tracking-tight">Autopilot</h1>
        <p className="text-[13.5px] text-ink-2 mt-1 max-w-[62ch]">
          What the autopilot did this gameweek. It runs by itself in the 12 hours before each
          deadline and submits without asking: free transfers only (never a points hit), only when
          they raise expected points, and the most money left among near-best options.
        </p>
      </div>

      {state.status === "loading" && <p className="text-ink-2">Loading the latest proposal…</p>}
      {state.status === "error" && <p className="text-loss">{state.message}</p>}
      {state.status === "none" && <NoProposal />}
      {state.status === "ready" && <ProposalView p={state.proposal} now={now} />}

      <Card className="p-4 mt-5">
        <h2 className="font-display font-semibold text-[15px] mb-1">Alerts on this phone</h2>
        <p className="text-[12.5px] text-ink-2">
          Each run's result is posted to the <span className="font-mono">NOTIFY_WEBHOOK</span> secret. For
          a push notification, install <b className="font-semibold">ntfy</b> from the Play Store, subscribe
          to a hard-to-guess topic, and set the secret to <span className="font-mono">https://ntfy.sh/&lt;topic&gt;</span>.
          Tapping the alert brings you back here.
        </p>
      </Card>
    </div>
  );
}

function NoProposal() {
  return (
    <Card className="p-5">
      <h2 className="font-display font-semibold text-[16px] mb-2">Nothing published yet</h2>
      <ol className="list-decimal pl-5 grid gap-1.5 text-[13px] text-ink-2">
        <li>
          Add the <span className="font-mono">FPL_REFRESH_TOKEN</span> and <span className="font-mono">AUTOPILOT_PAT</span> secrets
          (setup notes are at the top of <span className="font-mono">.github/workflows/autopilot.yml</span>).
        </li>
        <li>
          Set the repository variable <span className="font-mono">AUTOPILOT_MODE</span> to{" "}
          <span className="font-mono">live</span>. Until then it only does dry runs and changes nothing.
        </li>
        <li>
          To see results here, also set <span className="font-mono">AUTOPILOT_PUBLISH</span> to{" "}
          <span className="font-mono">true</span>. Each gameweek's result appears after it runs.
        </li>
      </ol>
    </Card>
  );
}

function ProposalView({ p, now }: { p: Proposal; now: number }) {
  const passed = Date.parse(p.deadline) <= now;
  const tone = p.verdict === "BLOCKED" ? "loss" : p.verdict === "READY" || p.verdict === "EXECUTED" ? "accent" : "neutral";
  const icon = { ok: "✓", warn: "!", fail: "✕" } as const;
  const iconTone = { ok: "text-accent", warn: "text-ink", fail: "text-loss" } as const;
  const lu = p.lineup;

  return (
    <div className="grid gap-4">
      {passed && (
        <div className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-[12.5px] text-ink-2">
          This proposal was for GW{p.event} and its deadline has passed. The next one appears once the
          runner enters the window before the following deadline.
        </div>
      )}

      <Card className="p-4">
        <div className="flex items-center gap-2.5 flex-wrap">
          <Chip tone={tone}>{p.verdict}</Chip>
          <span className="font-display font-semibold text-[17px]">GW{p.event}</span>
          <span className="text-[12.5px] text-ink-muted ml-auto">
            Deadline {new Date(p.deadline).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })} ·{" "}
            <b className="font-semibold text-ink">{untilDeadline(p.deadline, now)}</b>
          </span>
        </div>
        <p className="text-[13px] text-ink-2 mt-2">{VERDICT_COPY[p.verdict]}</p>
      </Card>

      <Card className="p-4">
        <div className="flex items-baseline gap-2 flex-wrap mb-2">
          <h2 className="font-display font-semibold text-[16px]">Transfers</h2>
          <span className="text-[12px] text-ink-muted">
            {p.freeTransfers == null ? "unlimited" : `${p.freeTransfers} free`}
            {p.hits > 0 && ` · −${p.hitCost} hit`}
            {` · bank after ${money(p.bankAfter)}`}
            {p.xpGain != null && ` · ${p.xpGain >= 0 ? "+" : "−"}${Math.abs(p.xpGain).toFixed(1)} xP`}
          </span>
        </div>
        {p.transfers.length === 0 ? (
          <p className="text-[13px] text-ink-2">None — roll the free transfer.</p>
        ) : (
          <ul className="grid gap-1.5">
            {p.transfers.map((t) => (
              <li key={t.out.id} className="flex items-center gap-2 flex-wrap text-[13.5px] border-b border-line last:border-0 pb-1.5 last:pb-0">
                <span className="font-mono text-[10.5px] text-ink-muted w-8">{t.pos}</span>
                <span className="text-loss">{t.out.name}</span>
                {t.out.club && <span className="font-mono text-[10px] text-ink-muted">{t.out.club}</span>}
                <span className="text-ink-muted" aria-label="replaced by">→</span>
                <span className="text-accent font-medium">{t.in.name}</span>
                {t.in.club && <span className="font-mono text-[10px] text-ink-muted">{t.in.club}</span>}
                <span className="font-mono text-[11.5px] text-ink-muted ml-auto tnum">
                  sell {money(t.out.price)} · buy {money(t.in.price)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="font-display font-semibold text-[16px] mb-2">Lineup</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {lu.captain && (
            <>
              <dt className="text-ink-muted">Captain</dt>
              <dd>
                {lu.captain.from && lu.captain.from.id !== lu.captain.to.id ? (
                  <>
                    {lu.captain.from.name} → <b className="font-semibold">{lu.captain.to.name}</b>
                  </>
                ) : (
                  <>{lu.captain.to.name} <span className="text-ink-muted">(unchanged)</span></>
                )}
              </dd>
            </>
          )}
          {lu.vice && (
            <>
              <dt className="text-ink-muted">Vice</dt>
              <dd>{lu.vice.to.name}</dd>
            </>
          )}
          {lu.promoted.length > 0 && (
            <>
              <dt className="text-ink-muted">Into the XI</dt>
              <dd>{lu.promoted.map((w) => w.name).join(", ")}</dd>
            </>
          )}
          {lu.benched.length > 0 && (
            <>
              <dt className="text-ink-muted">To the bench</dt>
              <dd>{lu.benched.map((w) => w.name).join(", ")}</dd>
            </>
          )}
          <dt className="text-ink-muted">Bench</dt>
          <dd>{lu.benchOrder.map((w) => w.name).join(" · ")}</dd>
        </dl>
      </Card>

      <Card className="p-4">
        <h2 className="font-display font-semibold text-[16px] mb-2">Checks</h2>
        <ul className="grid gap-1.5">
          {p.checks.map((c, i) => (
            <li key={i} className="flex gap-2.5 text-[13px]">
              <span aria-hidden className={`font-mono font-semibold w-3 text-center ${iconTone[c.level]}`}>
                {icon[c.level]}
              </span>
              <span className={c.level === "fail" ? "text-loss" : c.level === "warn" ? "text-ink" : "text-ink-2"}>
                <span className="sr-only">{c.level === "ok" ? "Pass: " : c.level === "warn" ? "Warning: " : "Fail: "}</span>
                {c.msg}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[11.5px] text-ink-muted mt-3">
          Checked {new Date(p.generatedAt).toLocaleString()}. The full request bodies are kept as an
          artifact on the workflow run.
        </p>
      </Card>
    </div>
  );
}
