/**
 * Model regression tests. Run with `npm test`.
 *
 * These exist because synthetic data hid a real bug: every sample player had a
 * full season of minutes, so nothing ever exercised the small-sample path. On
 * live data a midfielder with ONE minute played projected 128 points over five
 * gameweeks — six times Haaland — because his per-90 rates were extrapolated
 * from almost nothing. The first test below is that bug, pinned.
 */

import { expectedMinutes, expectedPoints, shrinkRate } from "../src/model/xp.ts";
import { nbinomSf, poissonFloorDiv } from "../src/model/distributions.ts";
import type { Player, Position, Team } from "../src/model/types.ts";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const team = (over: Partial<Team> = {}): Team => ({
  id: 1,
  name: "Test",
  short: "TST",
  attack: 1,
  defence: 1,
  possession: 0.5,
  matchesPlayed: 2,
  ...over,
});

const player = (over: Partial<Player> = {}): Player => ({
  id: 1,
  name: "Test Player",
  webName: "Test",
  pos: "MID" as Position,
  teamId: 1,
  cost: 50,
  status: "a",
  chanceOfPlaying: null,
  ownership: 1,
  minutes: 180,
  starts: 2,
  appearances: 2,
  npxg90: 0.2,
  xa90: 0.15,
  defcon90: 4,
  saves90: 0,
  yellow90: 0.1,
  red90: 0,
  penShare: 0,
  totalPoints: 10,
  ...over,
});

console.log("\ndistributions");
check("poisson floor-div is zero at zero rate", close(poissonFloorDiv(0, 2), 0));
check(
  "E[floor(X/2)] grows with the rate",
  poissonFloorDiv(3, 2) > poissonFloorDiv(1, 2) && poissonFloorDiv(1, 2) > 0,
);
check("negative binomial survival is a probability", (() => {
  const p = nbinomSf(10, 8, 6.5);
  return p > 0 && p < 1;
})());
check(
  "negative binomial has a fatter tail than Poisson at the same mean",
  nbinomSf(12, 6, 6.5) > (() => {
    // P(X >= 12) for Poisson(6), summed directly
    let cdf = 0;
    for (let k = 0; k < 12; k++) cdf += Math.exp(-6 + k * Math.log(6) - lgammaLocal(k + 1));
    return 1 - cdf;
  })(),
);
function lgammaLocal(x: number): number {
  let a = 0;
  for (let i = 2; i < x; i++) a += Math.log(i);
  return a;
}

console.log("\nrate shrinkage");
check("no minutes means the prior wins outright", close(shrinkRate(99, 5, 0), 5));
check("large samples converge on the observation", shrinkRate(9, 5, 100_000) > 8.9);
check(
  "a tiny sample is pulled most of the way back",
  shrinkRate(96, 5, 1) < 6,
  `got ${shrinkRate(96, 5, 1).toFixed(2)}`,
);

console.log("\nexpected minutes");
{
  const nailed = expectedMinutes(player({ minutes: 180, starts: 2, appearances: 2 }), team());
  const cameo = expectedMinutes(player({ minutes: 30, starts: 0, appearances: 2 }), team());
  const injured = expectedMinutes(player({ status: "i", chanceOfPlaying: 0 }), team());
  check("an ever-present outranks a substitute", nailed.xmins > cameo.xmins * 2);
  check("a ruled-out player projects no minutes", close(injured.xmins, 0));
  check("expected minutes stay inside a match", nailed.xmins > 0 && nailed.xmins <= 90);
  check("start probability is a probability", nailed.pStart > 0 && nailed.pStart <= 1);
}

console.log("\nsmall-sample regression (the bug this file exists for)");
{
  // One minute played, absurd extrapolated rates — the live-data outlier.
  const oneMinute = player({
    webName: "One Minute",
    minutes: 1,
    starts: 0,
    appearances: 1,
    npxg90: 0,
    xa90: 0,
    defcon90: 96,
  });
  const regular = player({ webName: "Regular", minutes: 180, starts: 2, appearances: 2, defcon90: 5 });
  const a = expectedPoints(oneMinute, team(), team(), true);
  const b = expectedPoints(regular, team(), team(), true);
  check("a one-minute player cannot out-project a regular starter", a.xp < b.xp, `${a.xp.toFixed(2)} vs ${b.xp.toFixed(2)}`);
  check("their DEFCON probability is not near-certain", a.pDefcon < 0.2, `got ${a.pDefcon.toFixed(2)}`);
  check("no single-gameweek projection is absurd", a.xp < 8 && b.xp < 8);
}

console.log("\npossession drives defensive contribution");
{
  const defender = player({ pos: "DEF", defcon90: 11, minutes: 900, starts: 10, appearances: 10 });
  const lowPossession = expectedPoints(defender, team({ possession: 0.37, matchesPlayed: 10 }), team(), true);
  const highPossession = expectedPoints(defender, team({ possession: 0.62, matchesPlayed: 10 }), team(), true);
  check(
    "the same player earns DEFCON more often at a low-possession club",
    lowPossession.pDefcon > highPossession.pDefcon * 1.4,
    `${lowPossession.pDefcon.toFixed(2)} vs ${highPossession.pDefcon.toFixed(2)}`,
  );
}

console.log("\nscoring sanity");
{
  const gk = expectedPoints(
    player({ pos: "GK", npxg90: 0, xa90: 0, defcon90: 0, saves90: 3 }),
    team(),
    team(),
    true,
  );
  check("goalkeepers are excluded from DEFCON", close(gk.pDefcon, 0));
  check("goalkeepers earn save points", gk.breakdown.saves > 0);
  check("a clean-sheet probability is a probability", gk.pCleanSheet >= 0 && gk.pCleanSheet <= 1);

  const strongOpponent = expectedPoints(player({ pos: "DEF" }), team(), team({ attack: 1.5 }), true);
  const weakOpponent = expectedPoints(player({ pos: "DEF" }), team(), team({ attack: 0.7 }), true);
  check("a tougher opponent lowers clean-sheet odds", strongOpponent.pCleanSheet < weakOpponent.pCleanSheet);
  check("the goals-conceded term is a deduction", strongOpponent.breakdown.conceded < 0);

  const all = expectedPoints(player(), team(), team(), true);
  const summed = Object.values(all.breakdown).reduce((a, b) => a + b, 0);
  check("the breakdown sums to the total", close(all.xp, summed, 1e-9));
  check("every component is finite", Object.values(all.breakdown).every(Number.isFinite));
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
