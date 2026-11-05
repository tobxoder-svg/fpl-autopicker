import { useEffect, useState } from "react";
import { loadDataset, type Dataset } from "./data";

type State =
  | { status: "loading" }
  | { status: "ready"; dataset: Dataset }
  | { status: "error"; message: string };

let cache: Dataset | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<(s: State) => void>();
const emit = (s: State) => listeners.forEach((l) => l(s));

function load(): Promise<void> {
  inflight ??= loadDataset()
    .then((dataset) => {
      cache = dataset;
      emit({ status: "ready", dataset });
    })
    .catch((err: unknown) => {
      // A failed refresh keeps the data already on screen.
      if (!cache) emit({ status: "error", message: err instanceof Error ? err.message : "Could not load the data snapshot." });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Re-fetch the data everywhere it's shown, without blanking the screen. */
export function refreshDataset(): Promise<void> {
  return load();
}

export function useDataset(): State {
  const [state, setState] = useState<State>(() =>
    cache ? { status: "ready", dataset: cache } : { status: "loading" },
  );

  useEffect(() => {
    listeners.add(setState);
    if (cache) setState({ status: "ready", dataset: cache });
    else void load();
    return () => {
      listeners.delete(setState);
    };
  }, []);

  return state;
}
