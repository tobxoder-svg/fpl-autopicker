import type { Candidate, SolveParams } from "./lp";
import type { SolveRequest, SolveResponse, SolvedSquad } from "./worker";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: SolveResponse) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<SolveResponse>) => {
      pending.get(event.data.requestId)?.resolve(event.data);
      pending.delete(event.data.requestId);
    };
  }
  return worker;
}

export interface SolveOutcome {
  solutions: SolvedSquad[];
  ms: number;
}

export function solveSquad(
  candidates: Candidate[],
  params: SolveParams,
  nSolutions: number,
  minDifference: number,
): Promise<SolveOutcome> {
  const requestId = nextId++;
  const request: SolveRequest = { requestId, candidates, params, nSolutions, minDifference };
  return new Promise((resolve, reject) => {
    pending.set(requestId, {
      resolve: (r) => (r.ok ? resolve({ solutions: r.solutions, ms: r.ms }) : reject(new Error(r.error))),
    });
    getWorker().postMessage(request);
  });
}

export type { SolvedSquad };
