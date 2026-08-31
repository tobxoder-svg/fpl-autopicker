/// <reference lib="webworker" />
/**
 * Runs HiGHS (compiled to WebAssembly) off the main thread. A full 600-player
 * squad MILP solves to optimality in well under a second, but that is still
 * long enough to drop frames if it runs inline.
 */

import highsLoader from "highs";
import { buildSquadLp, type Candidate, type SolveParams } from "./lp";

export interface SolveRequest {
  requestId: number;
  candidates: Candidate[];
  params: SolveParams;
  nSolutions: number;
  minDifference: number;
}

export interface SolvedSquad {
  squad: number[];
  xi: number[];
  captain: number | null;
  objective: number;
}

export type SolveResponse =
  | { requestId: number; ok: true; solutions: SolvedSquad[]; ms: number }
  | { requestId: number; ok: false; error: string };

type Highs = Awaited<ReturnType<typeof highsLoader>>;
let highs: Highs | null = null;

async function getHighs(): Promise<Highs> {
  if (!highs) {
    highs = await highsLoader({
      locateFile: (file: string) => `${import.meta.env.BASE_URL}${file}`,
    });
  }
  return highs;
}

function readPicked(columns: Record<string, { Primal?: number }>, prefix: string): number[] {
  const out: number[] = [];
  for (const [name, col] of Object.entries(columns)) {
    if (name[0] !== prefix) continue;
    if ((col.Primal ?? 0) > 0.5) out.push(Number(name.slice(1)));
  }
  return out.sort((a, b) => a - b);
}

self.onmessage = async (event: MessageEvent<SolveRequest>) => {
  const { requestId, candidates, params, nSolutions, minDifference } = event.data;
  const started = performance.now();
  try {
    const solver = await getHighs();
    const solutions: SolvedSquad[] = [];
    const exclude: number[][] = [];

    for (let k = 0; k < Math.max(1, nSolutions); k++) {
      const lp = buildSquadLp(candidates, params, exclude, minDifference);
      const result = solver.solve(lp, { time_limit: 20, mip_rel_gap: 0.0005, output_flag: false });
      if (result.Status !== "Optimal") break;

      const squad = readPicked(result.Columns, "x");
      if (squad.length !== 15) break;
      const xi = readPicked(result.Columns, "y");
      const captain = readPicked(result.Columns, "c")[0] ?? null;

      solutions.push({ squad, xi, captain, objective: result.ObjectiveValue ?? 0 });
      exclude.push(squad);
    }

    const response: SolveResponse = {
      requestId,
      ok: true,
      solutions,
      ms: Math.round(performance.now() - started),
    };
    self.postMessage(response);
  } catch (err) {
    const response: SolveResponse = {
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
