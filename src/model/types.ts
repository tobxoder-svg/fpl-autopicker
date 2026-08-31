export type Position = "GK" | "DEF" | "MID" | "FWD";

/** One club, with the ratings the model needs. */
export interface Team {
  id: number;
  name: string;
  short: string;
  /** Rolling attacking strength; 1.0 = league average. */
  attack: number;
  /** Rolling defensive leakiness; >1 concedes more than average. */
  defence: number;
  /**
   * Share of the ball, 0-1. The FPL API does not publish possession, so this is
   * derived — see `teamRatings` in scripts/fetch-fpl.mjs. Swap in a real feed
   * (FBref, Opta) and every DEFCON projection improves at once.
   */
  possession: number;
  /**
   * Matches this club has played. The denominator for start rate and minute
   * share — dividing by a player's own appearances instead makes one start out
   * of one appearance look nailed on.
   */
  matchesPlayed: number;
}

/** One player, with the per-90 rates the eight components consume. */
export interface Player {
  id: number;
  name: string;
  webName: string;
  pos: Position;
  teamId: number;
  /** Price in tenths of a million, as the FPL API reports it. */
  cost: number;
  status: string;
  chanceOfPlaying: number | null;
  ownership: number;
  minutes: number;
  starts: number;
  appearances: number;

  // per-90 rates
  npxg90: number;
  xa90: number;
  defcon90: number;
  saves90: number;
  yellow90: number;
  red90: number;

  /**
   * Held at 0 against the live API: `expected_goals` already includes penalty
   * xG and there is no `penalties_scored` field to net it out, so a separate
   * penalty term would double-count every taker.
   */
  penShare: number;
  /** Display only. 1 = first-choice penalty taker. */
  penaltiesOrder?: number | null;
  /** Season-to-date FPL points — used only for display and sanity checks. */
  totalPoints: number;
}

export interface Fixture {
  event: number | null;
  teamH: number;
  teamA: number;
  finished: boolean;
}

export interface DataBundle {
  generatedAt: string;
  season: string;
  currentEvent: number | null;
  nextEvent: number | null;
  teams: Team[];
  players: Player[];
  fixtures: Fixture[];
}

/** One gameweek's fixture for one club. A double gameweek yields two entries. */
export interface TeamFixture {
  event: number;
  opponentId: number;
  home: boolean;
}

export interface XpBreakdown {
  appearance: number;
  attacking: number;
  cleanSheet: number;
  conceded: number;
  defcon: number;
  saves: number;
  bonus: number;
  discipline: number;
}

export interface XpResult {
  xp: number;
  breakdown: XpBreakdown;
  xmins: number;
  pCleanSheet: number;
  pDefcon: number;
  expActions: number;
}

/** Tier 3 of the parameter spec — the settings a user actually turns. */
export interface Strategy {
  horizon: number;
  decay: number;
  benchWeights: [number, number, number];
  benchGkWeight: number;
  hitCost: number;
  riskLambda: number;
  ownershipWeight: number;
  budget: number;
  minBank: number;
  maxPerClub: number;
  forceIn: number[];
  forceOut: number[];
  nSolutions: number;
  minDifference: number;
}

export const DEFAULT_STRATEGY: Strategy = {
  horizon: 5,
  decay: 0.85,
  benchWeights: [0.15, 0.08, 0.04],
  benchGkWeight: 0.03,
  hitCost: 4,
  riskLambda: 0,
  ownershipWeight: 0,
  budget: 1000,
  minBank: 0,
  maxPerClub: 3,
  forceIn: [],
  forceOut: [],
  nSolutions: 3,
  minDifference: 2,
};
