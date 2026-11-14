// Tests refer to markets by their Kalshi tickers (readable, and what fixtures contain).
// Markets are keyed by our own ids (ADR-021); these look ids up through external_ids.

import type { Db } from "../../src/lib/db.js";

export async function idOf(db: Db, ticker: string): Promise<string> {
  const { rows } = await db.query<{ market_id: string }>(
    `select market_id from external_ids where source = 'kalshi' and kind = 'market' and external_id = $1`, [ticker]);
  if (!rows[0]) throw new Error(`no market for Kalshi ticker ${ticker}`);
  return rows[0].market_id;
}

export async function idsOf(db: Db, tickers: string[]): Promise<string[]> {
  return Promise.all(tickers.map((t) => idOf(db, t)));
}
