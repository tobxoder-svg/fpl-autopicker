import { useEffect, useState } from "react";
import { loadDataset, type Dataset } from "./data";

type State =
  | { status: "loading" }
  | { status: "ready"; dataset: Dataset }
  | { status: "error"; message: string };

let cache: Dataset | null = null;

export function useDataset(): State {
  const [state, setState] = useState<State>(() =>
    cache ? { status: "ready", dataset: cache } : { status: "loading" },
  );

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    loadDataset()
      .then((dataset) => {
        cache = dataset;
        if (!cancelled) setState({ status: "ready", dataset });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Could not load the data snapshot.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
