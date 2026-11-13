// Kalshi public market data (no API key). Calls are spaced out and retried with
// backoff, since Kalshi returns 429 after a handful of rapid requests (ADR-003).

import { fetchJson, throttle } from "../lib/http.js";

const BASE = "https://external-api.kalshi.com/trade-api/v2";
const pace = throttle(700); // ~1.4 req/s, comfortably under what we've seen trigger 429s

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  status: string;
  result: string;
  floor_strike?: number | null;
  strike_type?: string;
  custom_strike?: Record<string, string>;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  volume_fp?: string;
}

/** All markets in a series with the given status, following pagination. */
export async function listMarkets(seriesTicker: string, status = "open"): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  let cursor = "";
  do {
    await pace();
    const qs = new URLSearchParams({ series_ticker: seriesTicker, status, limit: "1000" });
    if (cursor) qs.set("cursor", cursor);
    const page = await fetchJson<{ markets: KalshiMarket[]; cursor?: string }>(`${BASE}/markets?${qs}`);
    out.push(...page.markets);
    cursor = page.cursor ?? "";
  } while (cursor);
  return out;
}
