// Pure helpers for turning Kalshi's raw market fields into Storyline's model.
// Kept free of I/O so they're easy to unit test.

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** 2026-11-13 → "26NOV13", the date segment in Kalshi event tickers. */
export function kalshiDateCode(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) throw new Error(`Bad ISO date: ${isoDate}`);
  return `${y.slice(2)}${MONTHS[Number(m) - 1]}${d}`;
}

/** Game key for an away @ home matchup, e.g. ("26NOV13","MIL","ORL") → "26NOV13MILORL". */
export function gameKey(dateCode: string, awayKalshi: string, homeKalshi: string): string {
  return `${dateCode}${awayKalshi}${homeKalshi}`;
}

/** "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25" → { series, gameKey, rest } */
export function splitTicker(ticker: string): { series: string; gameKey: string; rest: string[] } {
  const [series, gameKeyPart, ...rest] = ticker.split("-");
  if (!series || !gameKeyPart) throw new Error(`Unrecognized ticker: ${ticker}`);
  return { series, gameKey: gameKeyPart, rest };
}

/** Player prop tickers carry the player's team as the first 3 letters of the 3rd segment. */
export function playerTeamFromTicker(ticker: string): string {
  const { rest } = splitTicker(ticker);
  const seg = rest[0];
  if (!seg || seg.length < 4) throw new Error(`No player segment in ticker: ${ticker}`);
  return seg.slice(0, 3);
}

/** "Anthony Black: 25+ points" → "Anthony Black" */
export function playerNameFromTitle(title: string): string {
  const i = title.indexOf(":");
  if (i <= 0) throw new Error(`No player name in title: ${title}`);
  return title.slice(0, i).trim();
}

/** "$0.4300" style strings → integer cents (43). Null for missing values. */
export function dollarsToCents(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Kalshi stores "25+" as floor_strike 24.5 with strike_type "greater". */
export function strikeFromMarket(m: { floor_strike?: number | null; strike_type?: string }): number | null {
  if (m.floor_strike === null || m.floor_strike === undefined) return null;
  return m.strike_type === "greater" ? Math.floor(m.floor_strike) + 1 : m.floor_strike;
}

/** Map Kalshi player-prop series to Storyline's stat names. */
export const PLAYER_PROP_SERIES: Record<string, string> = {
  KXNBAPTS: "points",
  KXNBAREB: "rebounds",
  KXNBAAST: "assists",
  KXNBA3PT: "threes",
  KXNBAPRA: "pra",
};

export const GAME_WINNER_SERIES = "KXNBAGAME";

import type { MarketStatus } from "./market.js";

/**
 * Kalshi's market lifecycle (docs.kalshi.com, "Market lifecycle"): initialized → active →
 * (inactive) → closed → determined → (disputed → amended) → finalized. Only `finalized` is final;
 * a determined result can still be disputed, so it maps to `closed`, not `settled`. Some API
 * listings also show `settled`, treated like `finalized`.
 */
const KALSHI_STATUS: Record<string, MarketStatus> = {
  active: "open",
  initialized: "paused",
  inactive: "paused",
  closed: "closed",
  determined: "closed",
  disputed: "closed",
  amended: "closed",
  finalized: "settled",
  settled: "settled",
};

/**
 * Kalshi's status word in Storyline's vocabulary. An unknown word maps to `paused` (cards go
 * out: the safe side) and is returned as `unknown` so the caller can report it.
 */
export function marketStatus(kalshiStatus: string): { status: MarketStatus; unknown?: string } {
  // Own keys only: "constructor" or "__proto__" must not read as known statuses.
  return Object.hasOwn(KALSHI_STATUS, kalshiStatus)
    ? { status: KALSHI_STATUS[kalshiStatus]! }
    : { status: "paused", unknown: kalshiStatus };
}

/**
 * The live part of a Kalshi market, in Storyline's vocabulary: prices in cents, volume, and
 * our market status. Ingest and the price poller both write exactly this, so they can't
 * disagree on how a quote is read.
 * Deliberately not `result`: Kalshi can show a result before it is final and can amend it, so
 * reading and paying out on results belongs to settlement alone (STO-13, ADR-004).
 */
export function marketQuote(m: {
  yes_bid_dollars?: string; yes_ask_dollars?: string; no_bid_dollars?: string; no_ask_dollars?: string;
  volume_fp?: string; status: string;
}) {
  return {
    yes_bid: dollarsToCents(m.yes_bid_dollars), yes_ask: dollarsToCents(m.yes_ask_dollars),
    no_bid: dollarsToCents(m.no_bid_dollars),   no_ask: dollarsToCents(m.no_ask_dollars),
    volume: Math.round(Number(m.volume_fp ?? 0)),
    ...marketStatus(m.status),
  };
}

/** The raw Kalshi fields parseMarket reads. */
export interface KalshiMarketFields {
  ticker: string; title: string; status: string;
  floor_strike?: number | null; strike_type?: string; custom_strike?: Record<string, string>;
  yes_bid_dollars?: string; yes_ask_dollars?: string; no_bid_dollars?: string; no_ask_dollars?: string;
  volume_fp?: string;
}

/** One Kalshi market, checked and translated: everything ingest needs to store it. */
export interface ParsedMarket {
  ticker: string;
  gameKey: string;
  kind: "game_winner" | "player_stat";
  title: string;
  /** Kalshi team code: the team to win, or the player's team. */
  team: string;
  player: { kalshiId: string; name: string } | null;
  stat: string | null;
  strike: number | null;
  quote: ReturnType<typeof marketQuote>;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Check one raw Kalshi market and translate it. Throws with a short reason if any field ingest
 * relies on is missing or out of range, so the caller can skip that one market instead of
 * storing it half-filled or failing the whole slate (STO-32).
 */
export function parseMarket(m: Partial<KalshiMarketFields>, series: string): ParsedMarket {
  if (!isText(m.ticker)) throw new Error("no ticker");
  if (!isText(m.title)) throw new Error("no title");
  if (!isText(m.status)) throw new Error("no status");
  const { gameKey: key, rest } = splitTicker(m.ticker);

  const quote = marketQuote(m as KalshiMarketFields);
  for (const cents of [quote.yes_bid, quote.yes_ask, quote.no_bid, quote.no_ask]) {
    if (cents !== null && !(cents >= 0 && cents <= 100)) throw new Error(`price out of range (${cents} cents)`);
  }
  if (!(quote.volume >= 0)) throw new Error(`bad volume (${m.volume_fp})`);

  if (series === GAME_WINNER_SERIES) {
    if (!isText(rest[0])) throw new Error("no team in ticker");
    return { ticker: m.ticker, gameKey: key, kind: "game_winner", title: m.title, team: rest[0],
             player: null, stat: null, strike: null, quote };
  }
  const stat = PLAYER_PROP_SERIES[series];
  if (!stat) throw new Error(`unknown series ${series}`);
  const kalshiId = m.custom_strike?.basketball_player;
  if (!isText(kalshiId)) throw new Error("no player id (custom_strike.basketball_player)");
  const strike = strikeFromMarket(m);
  if (strike === null || !Number.isFinite(strike)) throw new Error("no strike (floor_strike)");
  return { ticker: m.ticker, gameKey: key, kind: "player_stat", title: m.title,
           team: playerTeamFromTicker(m.ticker),
           player: { kalshiId, name: playerNameFromTitle(m.title) }, stat, strike, quote };
}
