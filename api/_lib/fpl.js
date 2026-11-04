/**
 * Shared FPL fetch for the Vercel functions. Files under api/_lib are not
 * routes (Vercel skips underscore-prefixed paths).
 *
 * The FPL API sends no CORS headers, so a browser — or an installed PWA — can't
 * call it. These functions are the smallest possible proxy: GET only, a fixed
 * set of public paths, no credentials ever handled.
 */

const API = "https://fantasy.premierleague.com/api";
const UA = { "User-Agent": "fantasy-drafter/0.1 (+https://github.com/tobxoder-svg/fantasy-drafter)" };

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export async function fplGet(path, { timeoutMs = 9000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: UA, signal: ctrl.signal });
  } catch (err) {
    throw new UpstreamError(`FPL API unreachable (${err.name === "AbortError" ? "timeout" : err.message})`, 504);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw new UpstreamError(`Not found: ${path}`, 404);
  if (!res.ok) throw new UpstreamError(`FPL API ${path} -> HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Around deadlines the API answers 200 with "The game is being updated."
    throw new UpstreamError("FPL is updating — try again in a few minutes", 503);
  }
}

export function sendError(res, err) {
  res.setHeader("Cache-Control", "no-store");
  res.status(err.status ?? 500).json({ error: err.message ?? "Unexpected error" });
}
