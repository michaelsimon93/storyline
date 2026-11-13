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
