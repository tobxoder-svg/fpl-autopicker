/**
 * Loading a manager's team by ID — shared by My team and Autopilot. Public FPL
 * endpoints only (via /api/entry), so no login ever touches the phone.
 */

import type { Position } from "../model/types";

export const ID_KEY = "fd-entry-id";
const CACHE_KEY = "fd-entry-cache";

/** Details of one squad player, so a player missing from the projection data
 * (injured, never played) can still be priced and placed. */
export interface EntryPlayer {
  id: number;
  webName: string;
  pos: Position;
  teamId: number;
  nowCost: number;
  status: string;
}

/** Shape of /api/entry (see api/entry.js). */
export interface Entry {
  id: number;
  teamName: string;
  managerName: string;
  overallRank: number | null;
  overallPoints: number | null;
  event: number;
  squadEvent: number;
  bank: number;
  value: number | null;
  freeTransfersEstimate: number;
  chipsUsed: Array<{ name: string; event: number }>;
  picks: Array<{ element: number; position: number; isCaptain: boolean; isVice: boolean }>;
  /** Absent in copies cached before this field existed. */
  players?: EntryPlayer[];
}

export interface Loaded {
  entry: Entry;
  /** Set when the network failed and this is the last copy saved on the phone. */
  cachedAt: string | null;
}

export function readStore<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
export function writeStore(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

/**
 * Live first; on a network failure fall back to the last copy saved on this
 * phone. A definite "no such team" (400/404) is never masked by the cache.
 */
export async function fetchEntry(id: string): Promise<Loaded> {
  let fallbackMessage = "You're offline and this team hasn't been loaded on this phone before.";
  let res: Response | null = null;
  try {
    res = await fetch(`${import.meta.env.BASE_URL}api/entry?id=${encodeURIComponent(id)}`);
  } catch {
    /* offline — try the cache */
  }
  if (res) {
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    if (res.ok && isJson) {
      const entry = (await res.json()) as Entry;
      if (res.headers.has("x-fd-offline")) {
        // The service worker answered from its cache: say so, with the best date we have.
        const saved = readStore<{ id: string; at: string }>(CACHE_KEY);
        const at = saved?.id === id ? saved.at : (res.headers.get("date") ?? new Date().toISOString());
        return { entry, cachedAt: new Date(at).toISOString() };
      }
      writeStore(CACHE_KEY, { id, entry, at: new Date().toISOString() });
      return { entry, cachedAt: null };
    }
    const message = isJson
      ? (((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`)
      : "The live service isn't available here — it runs on the deployed site only.";
    if (res.status === 400 || res.status === 404) throw new Error(message);
    fallbackMessage = message;
  }
  const cached = readStore<{ id: string; entry: Entry; at: string }>(CACHE_KEY);
  if (cached && cached.id === id) return { entry: cached.entry, cachedAt: cached.at };
  throw new Error(fallbackMessage);
}
