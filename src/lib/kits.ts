/**
 * Club shirt colours, keyed by the API's `short_name`.
 *
 * These are the clubs' own primary and sleeve colours — the point is that a
 * pitch full of jerseys is scannable at a glance, which it stops being the
 * moment the colours are arbitrary. `outline: true` marks predominantly white
 * kits, which need a border and dark text to read against the pitch.
 *
 * Anything not listed falls back to a deterministic hue, so a promoted club
 * still gets a stable, distinct shirt rather than a blank.
 */

export interface Kit {
  base: string;
  sleeve: string;
  text: string;
  outline?: boolean;
}

export const KITS: Record<string, Kit> = {
  ARS: { base: "#EF0107", sleeve: "#FFFFFF", text: "#FFFFFF" },
  AVL: { base: "#670E36", sleeve: "#95BFE5", text: "#FFFFFF" },
  BOU: { base: "#DA291C", sleeve: "#1A1A1A", text: "#FFFFFF" },
  BRE: { base: "#E30613", sleeve: "#FFFFFF", text: "#FFFFFF" },
  BHA: { base: "#0057B8", sleeve: "#FFFFFF", text: "#FFFFFF" },
  BUR: { base: "#6C1D45", sleeve: "#99D6EA", text: "#FFFFFF" },
  CHE: { base: "#034694", sleeve: "#034694", text: "#FFFFFF" },
  COV: { base: "#78D0F3", sleeve: "#1D1D1B", text: "#0B2B3A" },
  CRY: { base: "#1B458F", sleeve: "#C4122E", text: "#FFFFFF" },
  EVE: { base: "#003399", sleeve: "#003399", text: "#FFFFFF" },
  FUL: { base: "#FFFFFF", sleeve: "#1A1A1A", text: "#14181F", outline: true },
  HUL: { base: "#F5A12D", sleeve: "#1A1A1A", text: "#2A1A05" },
  IPS: { base: "#0044A9", sleeve: "#FFFFFF", text: "#FFFFFF" },
  LEE: { base: "#FFFFFF", sleeve: "#1D428A", text: "#14181F", outline: true },
  LEI: { base: "#003090", sleeve: "#FDBE11", text: "#FFFFFF" },
  LIV: { base: "#C8102E", sleeve: "#C8102E", text: "#FFFFFF" },
  LUT: { base: "#F78F1E", sleeve: "#1A1A1A", text: "#2A1705" },
  MCI: { base: "#6CABDD", sleeve: "#1C2C5B", text: "#0A1B33" },
  MUN: { base: "#DA291C", sleeve: "#1A1A1A", text: "#FFFFFF" },
  NEW: { base: "#241F20", sleeve: "#FFFFFF", text: "#FFFFFF" },
  NFO: { base: "#DD0000", sleeve: "#DD0000", text: "#FFFFFF" },
  NOR: { base: "#FFF200", sleeve: "#00A650", text: "#2A2A05" },
  SHU: { base: "#EE2737", sleeve: "#1A1A1A", text: "#FFFFFF" },
  SOU: { base: "#D71920", sleeve: "#FFFFFF", text: "#FFFFFF" },
  SUN: { base: "#EB172B", sleeve: "#FFFFFF", text: "#FFFFFF" },
  TOT: { base: "#FFFFFF", sleeve: "#132257", text: "#14181F", outline: true },
  WHU: { base: "#7A263A", sleeve: "#1BB1E7", text: "#FFFFFF" },
  WOL: { base: "#FDB913", sleeve: "#231F20", text: "#2A2005" },
};

const FALLBACK_HUES = [212, 340, 28, 152, 268, 4, 190, 96];

export function kitFor(short: string, teamId: number): Kit {
  const known = KITS[short?.toUpperCase()];
  if (known) return known;
  const hue = FALLBACK_HUES[teamId % FALLBACK_HUES.length];
  return {
    base: `hsl(${hue} 55% 45%)`,
    sleeve: `hsl(${hue} 55% 30%)`,
    text: "#FFFFFF",
  };
}
