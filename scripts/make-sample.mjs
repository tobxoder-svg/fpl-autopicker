#!/usr/bin/env node
/**
 * Generates a realistically-shaped synthetic bundle so the site runs the moment
 * someone clones it, before the first API snapshot exists.
 *
 * Clubs and players here are invented. The UI reads `season: "sample"` and shows
 * a banner saying so — nothing in this file claims to describe real football.
 */

import { mkdir, writeFile } from "node:fs/promises";

let seed = 20262027;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const round = (n, d = 4) => Number(n.toFixed(d));

const CLUBS = [
  ["Ashcombe", "ASH"], ["Brackenford", "BRK"], ["Calderwick", "CAL"], ["Dunmarsh", "DUN"],
  ["Eastvale", "EAS"], ["Fenwick Park", "FEN"], ["Glenmoor", "GLM"], ["Harrowgate", "HRW"],
  ["Ilkeston", "ILK"], ["Jarrowfield", "JAR"], ["Kesterly", "KES"], ["Langmere", "LAN"],
  ["Marchwood", "MAR"], ["Northbury", "NOR"], ["Oakhaven", "OAK"], ["Pendleton", "PEN"],
  ["Quarrydale", "QRY"], ["Rothersby", "ROT"], ["Stanmouth", "STA"], ["Tilbrook", "TIL"],
];

const FIRST = ["Adam","Bruno","Callum","Diego","Emre","Finn","Gabriel","Hugo","Idris","Jonas",
  "Kai","Luca","Mateo","Niko","Oscar","Pedro","Rafa","Sam","Tomas","Viktor"];
const LAST = ["Almeida","Bergqvist","Costa","Delaney","Eriksen","Fontaine","Gruber","Halvorsen",
  "Ivanov","Jansen","Kovac","Lindqvist","Moretti","Nowak","Oduya","Pereira","Quinn","Rasmussen",
  "Silva","Tanaka","Ubertini","Vasquez","Whelan","Ximenes","Ylinen","Zawadzki"];

/** Tiered clubs: two title challengers down to a scrapping bottom five. */
function clubProfile(i) {
  const tier = i < 2 ? 0 : i < 6 ? 1 : i < 14 ? 2 : 3;
  const attack = [1.42, 1.2, 1.0, 0.8][tier] + (rnd() - 0.5) * 0.08;
  const defence = [0.66, 0.86, 1.0, 1.2][tier] + (rnd() - 0.5) * 0.08;
  const possession = [0.61, 0.55, 0.49, 0.39][tier] + (rnd() - 0.5) * 0.04;
  return { attack: round(attack), defence: round(defence), possession: round(possession) };
}

function makePlayer(id, team, pos, tier) {
  const eliteness = (1 - tier / 3) * (0.35 + rnd() * 0.65);
  const nailed = rnd();
  const starts = nailed > 0.35 ? 3 + Math.floor(rnd() * 3) : Math.floor(rnd() * 3);
  const minutes = starts * (58 + Math.floor(rnd() * 32)) + Math.floor(rnd() * 40);

  let npxg90 = 0, xa90 = 0, defcon90 = 0, saves90 = 0, cost = 45;
  if (pos === "GK") {
    saves90 = 1.8 + (1 - eliteness) * 2.6 + rnd() * 0.5;
    cost = 40 + Math.round(eliteness * 15);
  } else if (pos === "DEF") {
    npxg90 = 0.02 + rnd() * 0.09;
    xa90 = 0.02 + eliteness * 0.22 * rnd();
    defcon90 = 5.5 + (1 - eliteness) * 6.5 + rnd() * 2.2;
    cost = 38 + Math.round(eliteness * 30 + rnd() * 8);
  } else if (pos === "MID") {
    npxg90 = 0.04 + eliteness * 0.5 * rnd() * 1.6;
    xa90 = 0.05 + eliteness * 0.34 * (0.5 + rnd());
    defcon90 = 2.5 + (1 - eliteness) * 6 + rnd() * 2.5;
    cost = 44 + Math.round(eliteness * 85 + rnd() * 10);
  } else {
    npxg90 = 0.12 + eliteness * 0.72 * (0.5 + rnd() * 0.9);
    xa90 = 0.04 + eliteness * 0.2 * rnd();
    defcon90 = 0.8 + rnd() * 2.4;
    cost = 45 + Math.round(eliteness * 95 + rnd() * 10);
  }

  return {
    id,
    name: `${pick(FIRST)} ${pick(LAST)}`,
    webName: pick(LAST),
    pos,
    teamId: team.id,
    cost,
    status: rnd() > 0.94 ? "d" : "a",
    chanceOfPlaying: rnd() > 0.94 ? 75 : null,
    ownership: round(Math.max(0.1, eliteness * 45 * rnd()), 1),
    minutes,
    starts,
    appearances: Math.max(starts, starts + (rnd() > 0.6 ? 1 : 0)),
    npxg90: round(npxg90),
    xa90: round(xa90),
    defcon90: round(defcon90),
    saves90: round(saves90),
    yellow90: round(0.05 + rnd() * 0.22),
    red90: round(rnd() * 0.012),
    penShare: pos !== "GK" && rnd() > 0.93 ? 0.85 : 0,
    totalPoints: Math.round((minutes / 90) * (1.5 + eliteness * 4)),
  };
}

const teams = CLUBS.map(([name, short], i) => ({ id: i + 1, name, short, ...clubProfile(i) }));

const players = [];
let id = 1;
teams.forEach((team, i) => {
  const tier = i < 2 ? 0 : i < 6 ? 1 : i < 14 ? 2 : 3;
  const squad = { GK: 3, DEF: 8, MID: 9, FWD: 5 };
  for (const [pos, count] of Object.entries(squad)) {
    for (let k = 0; k < count; k++) players.push(makePlayer(id++, team, pos, tier));
  }
});

// A double round-robin, two matches per gameweek slot, 38 gameweeks.
const fixtures = [];
for (let gw = 1; gw <= 38; gw++) {
  const ids = teams.map((t) => t.id);
  for (let k = 0; k < ids.length; k += 2) {
    const home = gw % 2 === 0;
    fixtures.push({
      event: gw,
      teamH: home ? ids[k] : ids[k + 1],
      teamA: home ? ids[k + 1] : ids[k],
      finished: gw < 4,
    });
  }
  ids.splice(1, 0, ids.pop());
}

const bundle = {
  generatedAt: new Date().toISOString(),
  season: "sample",
  currentEvent: 3,
  nextEvent: 4,
  teams,
  players,
  fixtures,
};

await mkdir("public/data", { recursive: true });
await writeFile("public/data/bundle.json", JSON.stringify(bundle));
console.log(`wrote sample bundle — ${players.length} players across ${teams.length} clubs`);
