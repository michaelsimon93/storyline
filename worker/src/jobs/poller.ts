// The price poller (STO-9). Every poller_interval_seconds, refresh today's carded markets from
// Kalshi: prices, volume, trading status and result. Supabase Realtime pushes the changed
// rows to open cards (markets is in the supabase_realtime publication).
//
// - Prices, volume and trading status only. Results are settlement's job (STO-13): Kalshi can
//   show a result before it is final, and paying out is guarded there.
// - Every carded market is refreshed, whatever its Kalshi status. Ingest only lists open
//   markets, but a card must go "out" when Kalshi pauses or closes its market (spec §4).
// - prices_updated_at is set on every poll, even when nothing moved: it means "confirmed
//   current", which is what the 60-second freshness promise and the pick staleness check read.
// - Rate limits (429) are retried with backoff by fetchJson, so the poller slows down
//   instead of failing, but within a deadline of one poll interval: better to fail this poll and
//   try again on schedule than to block for minutes while prices age.

import type { Db } from "../lib/db.js";
import { dbNow, withRun } from "../lib/db.js";
import * as kalshi from "../sources/kalshi.js";
import { marketQuote } from "../domain/kalshiParse.js";
import { resolveSlateDate } from "./ingest.js";

export interface PollSummary {
  slate_date: string;
  carded: number;        // markets on today's cards
  updated: number;       // rows refreshed
  not_open: string[];    // carded markets that aren't trading (their cards show as out)
  snapshots: number;     // price-history rows written
}

/** Read live, so a config change takes effect on the next poll. */
async function pollIntervalSeconds(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select config_int('poller_interval_seconds') as n`);
  return rows[0]!.n;
}

/** One poll may spend at most one interval on Kalshi, retries and Retry-After included. */
export function fetchDeadline(intervalSeconds: number) {
  return { deadlineMs: intervalSeconds * 1_000 };
}

export async function pollPrices(db: Db, date?: string): Promise<PollSummary> {
  const slateDate = await resolveSlateDate(db, date);
  return withRun(db, "price_poll", slateDate, async () => {
    const { rows } = await db.query<{ ticker: string }>(
      `select distinct market_ticker as ticker from cards where slate_date = $1 order by 1`, [slateDate]);
    const tickers = rows.map((r) => r.ticker);
    const summary: PollSummary = { slate_date: slateDate, carded: tickers.length, updated: 0, not_open: [], snapshots: 0 };
    if (!tickers.length) return summary;   // no deck yet today (curation runs at 10am)

    const fetchedAt = await dbNow(db);
    const markets = await kalshi.getMarkets(tickers, fetchDeadline(await pollIntervalSeconds(db)));
    const quotes = markets
      .filter((m) => tickers.includes(m.ticker))
      .map((m) => ({ ticker: m.ticker, ...marketQuote(m) }));

    // Lock rows in ticker order before updating. Ingest writes markets in the same order, so
    // the two jobs can wait on each other but never deadlock.
    const updated = await db.query<{ ticker: string }>(
      `with q as (
         select * from jsonb_to_recordset($1) as q(ticker text, yes_bid smallint, yes_ask smallint,
           no_bid smallint, no_ask smallint, volume integer, status market_status)
       ), locked as (
         select m.ticker from markets m join q using (ticker) order by m.ticker for no key update of m
       )
       update markets m
          set yes_bid_cents = q.yes_bid, yes_ask_cents = q.yes_ask,
              no_bid_cents = q.no_bid,   no_ask_cents = q.no_ask,
              volume = q.volume, status = q.status,
              prices_updated_at = $2, updated_at = now()
         from q join locked using (ticker)
        where m.ticker = q.ticker
          -- Never replace newer data (ingest may have written while this request was out).
          and (m.prices_updated_at is null or m.prices_updated_at < $2)
       returning m.ticker`,
      [JSON.stringify(quotes), fetchedAt],
    );
    summary.updated = updated.rowCount ?? 0;
    summary.not_open = quotes.filter((q) => q.status !== "open").map((q) => q.ticker).sort();

    // Price history: the rule for when to snapshot lives in snapshot_prices().
    const snap = await db.query<{ n: number }>(`select snapshot_prices() as n`);
    summary.snapshots = snap.rows[0]!.n;

    // A carded market Kalshi didn't return can't be priced, so its card would go stale
    // silently. Fail the run (and alert) after writing everything we did get.
    const returned = new Set(quotes.map((q) => q.ticker));
    const missing = tickers.filter((t) => !returned.has(t));
    const problems: string[] = [];
    if (missing.length) {
      problems.push(`Kalshi returned no data for ${missing.length} carded market(s): ${missing.join(", ")}`);
    }
    // A status word we don't know was stored as `paused` (cards out); say so loudly, since it
    // usually means Kalshi changed its API and the adapter's mapping needs updating.
    const unknown = quotes.filter((q) => q.unknown).map((q) => `${q.ticker} ("${q.unknown}")`);
    if (unknown.length) {
      problems.push(`unknown Kalshi status for ${unknown.length} market(s), treated as paused: ${unknown.join(", ")}`);
    }
    if (problems.length) throw new Error(problems.join("; "));
    return summary;
  });
}
