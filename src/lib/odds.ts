/**
 * Bookmaker odds → expected goals per fixture.
 *
 * Source: The Odds API (the-odds-api.com), sport `soccer_epl`, markets
 * `h2h,totals`, region `uk`. One request costs 2 credits (markets × regions)
 * and covers every listed EPL match, so the twice-daily refresh plus the
 * autopilot's own fetch stay far inside the free tier's 500 credits a month.
 *
 * Bookmakers don't quote expected goals directly. They quote home/draw/away and
 * over/under 2.5. Both are functions of the two teams' scoring rates under a
 * Poisson model, so we fit the pair (λ home, λ away) whose implied probabilities
 * match the market's (margin removed). That gives each side's expected goals
 * and its clean-sheet chance, e^(−λ opponent) — the two things a captain and a
 * defender's points depend on. The market prices in team news our model can't
 * see (rotation, injuries, motivation), which is why it's worth blending in.
 */

import type { DataBundle, Fixture, Team } from "../model/types";

// ---------------------------------------------------------------------------
// The API's response shape (v4 /sports/soccer_epl/odds)
// ---------------------------------------------------------------------------

export interface ApiOutcome {
  name: string;
  price: number;
  point?: number;
}
export interface ApiEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{ key: string; markets: Array<{ key: string; outcomes: ApiOutcome[] }> }>;
}

export const ODDS_URL = "https://api.the-odds-api.com/v4/sports/soccer_epl/odds";
export const ODDS_QUERY = "regions=uk&markets=h2h,totals&oddsFormat=decimal";

// ---------------------------------------------------------------------------
// What we keep
// ---------------------------------------------------------------------------

export interface FixtureOdds {
  event: number;
  teamH: number;
  teamA: number;
  kickoff: string;
  /** Market probabilities, margin removed, averaged across bookmakers. */
  pHome: number;
  pDraw: number;
  pAway: number;
  /** P(over 2.5 goals), or null when no totals market was quoted. */
  pOver25: number | null;
  /** Fitted expected goals. */
  lamH: number;
  lamA: number;
  books: number;
}

export interface OddsSnapshot {
  fetchedAt: string;
  source: "the-odds-api";
  fixtures: FixtureOdds[];
  /** Odds events that couldn't be matched to an FPL fixture (names changed, etc). */
  unmatched: string[];
}

// ---------------------------------------------------------------------------
// Poisson fit
// ---------------------------------------------------------------------------

const MAX_GOALS = 10;

function pmf(lam: number): number[] {
  const out = [Math.exp(-lam)];
  for (let k = 1; k <= MAX_GOALS; k++) out.push((out[k - 1] * lam) / k);
  return out;
}

/** Home, away and over-the-line probabilities for independent Poisson scores. */
export function poissonMarket(lamH: number, lamA: number, line = 2.5) {
  const h = pmf(lamH);
  const a = pmf(lamA);
  let pH = 0, pD = 0, pA = 0, pOver = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = h[i] * a[j];
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (i + j > line) pOver += p;
    }
  }
  return { pH, pD, pA, pOver };
}

/**
 * The (λH, λA) whose Poisson probabilities best match the market. Coarse grid,
 * then a fine one around the best point — robust, and fast enough for 10 games.
 * Without a totals price the 1X2 alone pins only the difference between the
 * two, so the total is anchored on a league-typical 2.7 goals.
 */
export function fitLambdas(pHome: number, pAway: number, pOver25: number | null): { lamH: number; lamA: number } {
  const loss = (lh: number, la: number) => {
    const m = poissonMarket(lh, la);
    let e = (m.pH - pHome) ** 2 + (m.pA - pAway) ** 2;
    e += pOver25 != null ? (m.pOver - pOver25) ** 2 : 0.02 * (lh + la - 2.7) ** 2;
    return e;
  };
  let best = { lh: 1.4, la: 1.2, e: Infinity };
  for (let lh = 0.2; lh <= 4.0001; lh += 0.05) {
    for (let la = 0.2; la <= 4.0001; la += 0.05) {
      const e = loss(lh, la);
      if (e < best.e) best = { lh, la, e };
    }
  }
  const c = { ...best };
  for (let lh = c.lh - 0.05; lh <= c.lh + 0.05; lh += 0.005) {
    for (let la = c.la - 0.05; la <= c.la + 0.05; la += 0.005) {
      if (lh <= 0.05 || la <= 0.05) continue;
      const e = loss(lh, la);
      if (e < best.e) best = { lh, la, e };
    }
  }
  return { lamH: Number(best.lh.toFixed(3)), lamA: Number(best.la.toFixed(3)) };
}

// ---------------------------------------------------------------------------
// Team names: bookmaker spelling → FPL club
// ---------------------------------------------------------------------------

export function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "fc" && w !== "afc" && w !== "the")
    .join(" ");
}

/** Bookmaker spellings that don't reduce to FPL's on their own. Keys and values normalised. */
const ALIASES: Record<string, string> = {
  "manchester united": "man utd",
  "manchester utd": "man utd",
  "manchester city": "man city",
  "tottenham hotspur": "spurs",
  tottenham: "spurs",
  "wolverhampton wanderers": "wolves",
  wolverhampton: "wolves",
  "nottingham forest": "nottm forest",
  "brighton and hove albion": "brighton",
  "newcastle united": "newcastle",
  "west ham united": "west ham",
  "leeds united": "leeds",
  "leicester city": "leicester",
  "ipswich town": "ipswich",
  "sheffield united": "sheffield utd",
  "sheffield utd": "sheffield utd",
  "luton town": "luton",
  "west bromwich albion": "west brom",
  "norwich city": "norwich",
  "coventry city": "coventry",
  "hull city": "hull",
  "stoke city": "stoke",
  "swansea city": "swansea",
  "cardiff city": "cardiff",
  "birmingham city": "birmingham",
  "derby county": "derby",
  "queens park rangers": "qpr",
  "blackburn rovers": "blackburn",
  "preston north end": "preston",
  "bristol city": "bristol city",
};

/** Matches a bookmaker team name to an FPL club id, or null. */
export function matchTeam(name: string, teams: Team[]): number | null {
  const n = normName(name);
  const target = ALIASES[n] ?? n;
  const exact = teams.find((t) => normName(t.name) === target || normName(t.short) === target);
  if (exact) return exact.id;
  // Last resort: FPL's name is a prefix of the bookmaker's ("Brentford" / "Brentford FC"),
  // or the other way round — only if exactly one club fits.
  const loose = teams.filter((t) => {
    const f = normName(t.name);
    return f.length >= 4 && (target.startsWith(f) || f.startsWith(target));
  });
  return loose.length === 1 ? loose[0].id : null;
}

// ---------------------------------------------------------------------------
// Parse a response into fixture odds
// ---------------------------------------------------------------------------

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** One bookmaker's 1X2, margin removed. */
function h2h(outcomes: ApiOutcome[], home: string, away: string) {
  const price = (n: string) => outcomes.find((o) => o.name === n)?.price;
  const ph = price(home), pa = price(away), pd = price("Draw");
  if (!ph || !pa || !pd || ph <= 1 || pa <= 1 || pd <= 1) return null;
  const inv = [1 / ph, 1 / pd, 1 / pa];
  const s = inv[0] + inv[1] + inv[2];
  return { pH: inv[0] / s, pD: inv[1] / s, pA: inv[2] / s };
}

/** One bookmaker's P(over 2.5), margin removed. Other lines are ignored. */
function over25(outcomes: ApiOutcome[]) {
  const o = outcomes.find((x) => x.name === "Over" && x.point === 2.5)?.price;
  const u = outcomes.find((x) => x.name === "Under" && x.point === 2.5)?.price;
  if (!o || !u || o <= 1 || u <= 1) return null;
  return 1 / o / (1 / o + 1 / u);
}

export function parseOdds(
  events: ApiEvent[],
  bundle: Pick<DataBundle, "teams" | "fixtures">,
  fetchedAt: string,
): OddsSnapshot {
  const fixtures: FixtureOdds[] = [];
  const unmatched: string[] = [];
  const upcoming = bundle.fixtures.filter((f): f is Fixture & { event: number } => f.event != null && !f.finished);

  for (const ev of events ?? []) {
    const label = `${ev.home_team} v ${ev.away_team}`;
    const teamH = matchTeam(ev.home_team, bundle.teams);
    const teamA = matchTeam(ev.away_team, bundle.teams);
    if (teamH == null || teamA == null) {
      unmatched.push(`${label} (team name)`);
      continue;
    }
    // The FPL fixture between these two, nearest in time (a rearranged game keeps its pairing).
    const t = Date.parse(ev.commence_time);
    const fx = upcoming
      .filter((f) => f.teamH === teamH && f.teamA === teamA)
      .sort((a, b) => Math.abs(Date.parse(a.kickoff ?? "") - t || 0) - Math.abs(Date.parse(b.kickoff ?? "") - t || 0))[0];
    if (!fx) {
      unmatched.push(`${label} (no FPL fixture)`);
      continue;
    }
    if (fx.kickoff && Math.abs(Date.parse(fx.kickoff) - t) > 4 * 86_400_000) {
      unmatched.push(`${label} (kick-off differs from FPL's)`);
      continue;
    }

    const ones: Array<{ pH: number; pD: number; pA: number }> = [];
    const overs: number[] = [];
    for (const bk of ev.bookmakers ?? []) {
      for (const m of bk.markets ?? []) {
        if (m.key === "h2h") {
          const r = h2h(m.outcomes, ev.home_team, ev.away_team);
          if (r) ones.push(r);
        } else if (m.key === "totals") {
          const r = over25(m.outcomes);
          if (r != null) overs.push(r);
        }
      }
    }
    if (!ones.length) {
      unmatched.push(`${label} (no prices)`);
      continue;
    }
    const pHome = avg(ones.map((o) => o.pH));
    const pDraw = avg(ones.map((o) => o.pD));
    const pAway = avg(ones.map((o) => o.pA));
    const pOver25 = overs.length ? avg(overs) : null;
    const { lamH, lamA } = fitLambdas(pHome, pAway, pOver25);
    fixtures.push({
      event: fx.event,
      teamH,
      teamA,
      kickoff: ev.commence_time,
      pHome: round(pHome),
      pDraw: round(pDraw),
      pAway: round(pAway),
      pOver25: pOver25 == null ? null : round(pOver25),
      lamH,
      lamA,
      books: ones.length,
    });
  }
  fixtures.sort((a, b) => a.event - b.event || a.kickoff.localeCompare(b.kickoff));
  return { fetchedAt, source: "the-odds-api", fixtures, unmatched };
}

const round = (n: number) => Number(n.toFixed(4));

/** Calls The Odds API. The key never leaves the server side (GitHub Actions). */
export async function fetchOddsEvents(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<ApiEvent[]> {
  const res = await fetchImpl(`${ODDS_URL}?${ODDS_QUERY}&apiKey=${encodeURIComponent(apiKey)}`, {
    headers: { "User-Agent": "fpl-autopicker/1.0" },
  });
  const remaining = res.headers.get("x-requests-remaining");
  if (remaining != null) console.log(`odds: ${remaining} API credits left this month`);
  if (res.status === 401) throw new Error("The Odds API rejected the key (401) — check the ODDS_API_KEY secret");
  if (res.status === 429) throw new Error("The Odds API quota is used up for this month (429)");
  if (!res.ok) throw new Error(`The Odds API -> HTTP ${res.status}`);
  return (await res.json()) as ApiEvent[];
}

/** Lookup by fixture. */
export function oddsIndex(snap: OddsSnapshot | null | undefined) {
  const m = new Map<string, FixtureOdds>();
  for (const f of snap?.fixtures ?? []) m.set(`${f.event}:${f.teamH}:${f.teamA}`, f);
  return (event: number, teamH: number, teamA: number) => m.get(`${event}:${teamH}:${teamA}`) ?? null;
}
