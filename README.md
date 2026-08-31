# Fantasy Drafter

A Fantasy Premier League squad optimiser with an open expected-points model and a
mixed-integer solver that runs in the browser. No backend, no account, no hosting bill.

**Live:** https://fantasy-drafter-coral.vercel.app/

---

## Why it is built this way

Two constraints shaped every architectural decision.

**The FPL API sends no CORS headers.** A page on `github.io` cannot call it. Rather than
run a proxy, a scheduled GitHub Action snapshots the API into `public/data/bundle.json`,
commits it, and Pages serves it as a static file. Prices move once a day at about 02:30 UK,
so a snapshot is never meaningfully stale — and the site cannot go down separately from
GitHub.

**The projection matters more than the solver.** A perfect solver on a bad expected-points
model returns a perfectly wrong squad. So the model is eight separate, testable terms
rather than one fitted regressor, and the UI shows the decomposition for every player.

HiGHS compiled to WebAssembly proves optimality on a ~600-player squad MILP in well under
a second, which is why the solver can live on the client at all.

---

## Getting started

```bash
npm install
npm run fetch:data   # snapshot the live FPL API (optional — see below)
npm run dev
```

The repo ships with a **synthetic sample** bundle — invented clubs and players, flagged as
such throughout the UI — so the site works the moment you clone it. Any build with network
access replaces it with the live league automatically.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (uses the committed bundle) |
| `npm run build` | Snapshot the API, type-check, build to `dist/` |
| `npm test` | Model regression tests |
| `npm run preview` | Serve the production build |
| `npm run fetch:data` | Snapshot the live FPL API into `public/data/` |
| `npm run sample:data` | Regenerate the synthetic bundle |
| `npm run typecheck` | Types only |

`npm run build` snapshots the live API first and falls back to the committed bundle if the
API is unreachable, so a build never fails on a bad API minute. `SKIP_DATA_FETCH=1` uses
the committed bundle as-is.

---

## Deploying

The build serves from `/` by default, which is what Vercel, Netlify, a custom domain and
`npm run dev` all expect. **GitHub Pages is the only exception** — a project page lives at
`/<repo>/`, so the Pages workflow sets `BASE_PATH` for it. Get this wrong and the failure
is silent and total: `index.html` loads, every asset 404s, and the page renders blank.

### Vercel / Netlify

Import the repo. Framework preset **Vite**, build `npm run build`, output `dist` — all
auto-detected, and `vercel.json` pins them anyway. No environment variables needed, and
**no manual step to get real data**: the build snapshots the FPL API itself, so every
deploy ships a fresh league.

To keep it fresh without deploying by hand, set **Settings → Actions → General → Workflow
permissions: Read and write**. The **Refresh FPL data** workflow then commits a snapshot on
a cron, and that push triggers a redeploy.

### GitHub Pages

1. Push to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write.**
4. Run **Refresh FPL data** once by hand from the Actions tab.

`BASE_PATH` is set from the repository name in `deploy.yml`. On a custom domain or a
`<user>.github.io` repo, delete that `env:` block so the default `/` applies.

---

## The model

`src/model/xp.ts`. Eight additive components, each a pure function:

| # | Component | Note |
| --- | --- | --- |
| 1 | Expected minutes | The multiplier on everything else. Start rate and minute share regressed toward a prior, using the *club's* matches played as the denominator. |
| 2 | Attacking returns | xG90 and xA90, adjusted for team attack × opponent defence × venue. |
| 3 | Clean sheet | Poisson on modelled opponent goals, gated on 60 minutes. |
| 4 | Goals conceded | `−E[⌊conceded/2⌋]`. Routinely omitted elsewhere; decides whether a cheap defender is playable. |
| 5 | Defensive contribution | 10 CBIT (DEF) / 12 CBIRT (MID, FWD). Negative binomial, scaled by opponent possession. |
| 6 | Saves | `E[⌊saves/3⌋]`, scaled by opponent attack. |
| 7 | Bonus | A shrunk positional prior — see the caveats. |
| 8 | Discipline | Cards. Correlated with high-DEFCON defenders, so it partially cancels component 5. |

### Small samples

Every per-90 rate is regressed toward a positional prior, weighted by minutes played
(`shrinkRate`, 450 minutes of prior). This is not decoration. Before it existed, a
midfielder with **one minute played** projected 128 points over five gameweeks — six times
Haaland — because his defensive-action rate extrapolated to 96 per 90. Regressing start
probability alone is not enough; the rates themselves have to be regressed, or the
optimiser goes hunting for exactly these artefacts. `npm test` pins that case.

### The possession term

Defensive contribution opportunity scales with the **opponent's** share of the ball. A
defender on a 37%-possession side clears the 10-action threshold far more often than an
equally capable player at a possession-dominant club. Action counts are modelled negative
binomial rather than Poisson because they are overdispersed — the same player swings
between 4 and 15 actions on game state, and Poisson understates the right tail that
actually earns the point.

This is the largest available edge in the current scoring system, and it is where most
public tools leave points on the table.

---

## Known weaknesses

Stated here rather than buried, because a model whose limits are hidden is worse than a
simpler one whose limits are known.

- **Bonus is a prior, not a fit.** The bonus-point system was retuned for 2026/27 to reduce
  its overlap with defensive contribution and improve bonus for goalkeepers, full-backs and
  attackers. Any model fitted on 2025/26 data is biased. Refit once enough of this season
  exists; until then treat bonus-driven gaps between similar players as noise.
- **Possession is derived, not measured.** The FPL API does not publish it. It is inferred
  from defensive-action volume per 90 relative to the league, blended toward a
  fixture-difficulty prior while samples are thin (`teamRatings` in
  `scripts/fetch-fpl.mjs`). Verified against live data, it ranks Manchester City, Arsenal
  and Chelsea highest and Hull, Ipswich and Leeds lowest — right, but still a proxy.
  Wiring in a real feed is the highest-value data upgrade available.
- **Team strength is not the API's.** Every `strength_*` field on `/teams` is `0` and
  `strength` is `null` in the live response — they are simply not populated. Ratings are
  therefore built from fixture difficulty (which *is* populated) blended with observed
  xG and xGC. If a future season starts populating those fields, they are worth revisiting.
- **Attacking returns include penalties.** `expected_goals` is total xG, not npxG, and the
  API exposes no `penalties_scored` to net penalties out. The separate penalty term is
  therefore held at zero — adding it would double-count every taker. A real npxG feed
  would let it come back, and would slightly improve newly-appointed takers.
- **Transfers are not planned.** The optimiser builds from scratch and does not know your
  current squad. Read the output as "what a clean slate looks like", not as a transfer
  instruction.
- **The API shape is not contractual.** `fetch-fpl.mjs` prefers the API's own
  `defensive_contribution` (verified: it equals CBI + tackles for defenders, plus
  recoveries for everyone else, and 0 for goalkeepers) and falls back to summing the parts.
  It asserts on its own output and exits non-zero rather than committing a bundle that
  would render every projection `NaN`.

---

## Roadmap

The next milestone is multi-gameweek transfer planning: free transfers, hits, and chip
scheduling across the horizon, with the two 2026/27 chip sets and the pre-GW19 deadline on
the first set as constraints.

Its one real trap is worth writing down in advance. The free-transfer rollover

```
ft[t+1] = min(5, ft[t] − used[t] + 1)
```

is non-linear and needs auxiliary binaries with a big-M. This is where multi-gameweek FPL
models quietly begin emitting illegal transfer plans, so it deserves a dedicated test
before anything is built on top of it.

---

## Stack

Vite · React · TypeScript · Tailwind v4 · [HiGHS](https://github.com/lovasoa/highs-js)
(WebAssembly) · GitHub Actions · Vercel or GitHub Pages.

```
scripts/fetch-fpl.mjs     FPL API -> public/data/bundle.json, with assertions
scripts/prepare-data.mjs  build-time snapshot with a fallback to the committed bundle
scripts/make-sample.mjs   synthetic bundle for local development
scripts/check-model.ts    model regression tests (npm test)
src/model/                the eight xP components and their distributions
src/solver/               LP construction, worker, client
src/lib/                  data loading and projection
src/routes/               overview, builder, method
```

---

## Licence

MIT. Not affiliated with, endorsed by, or connected to the Premier League or Fantasy
Premier League. Player data belongs to its respective owners; this project only reads the
public API.
