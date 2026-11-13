// Price poller end to end: the recorded slate is ingested, three of its markets are carded,
// then a poll runs against a recorded GET /markets?tickers=... response.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../src/jobs/ingest.js";
import { pollPrices } from "../src/jobs/poller.js";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";
import { fixture, installFetch, json, slateRoutes, type Route } from "./helpers/mockFetch.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const SLATE = "2026-11-13";
const MOVED = "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25";   // prices move in the poll fixture
const CLOSED = "KXNBAPTS-26NOV13MILORL-MILKKUZMA18-20"; // Kalshi closes it
const WINNER = "KXNBAGAME-26NOV13MILORL-ORL";            // unchanged
const CARDED = [MOVED, CLOSED, WINNER];
const NOT_CARDED = "KXNBAPTS-26NOV13MILORL-ORLABLACK0-20";

let db: Db | null = null;
let calls: string[] = [];
let restore = () => {};

/** Kalshi's GET /markets?tickers=... answered from the derived fixture, filtered to the request. */
function pollRoute(drop: string[] = []): Route {
  return (url) => {
    if (url.hostname !== "external-api.kalshi.com" || !url.searchParams.has("tickers")) return undefined;
    const wanted = new Set(url.searchParams.get("tickers")!.split(","));
    const body = fixture("kalshi-tickers-poll.json") as { markets: { ticker: string }[] };
    return json({ cursor: "", markets: body.markets.filter((m) => wanted.has(m.ticker) && !drop.includes(m.ticker)) });
  };
}
function useFetch(...routes: Route[]) {
  restore();
  const f = installFetch(...routes, slateRoutes);
  calls = f.calls;
  restore = f.restore;
}

before(async () => {
  db = await freshDb("storyline_poller_test");
  if (!db) return;
  useFetch();
  await ingest(db, SLATE);
  await db.query(`
    insert into cards (slate_date, sort_key, game_id, subject, player_id, team_id, market_ticker, blurb)
    select $1, row_number() over (order by ticker), game_id,
           case when kind = 'game_winner' then 'team' else 'player' end::subject_type,
           player_id, case when kind = 'game_winner' then team_id end, ticker, 'story'
    from markets where ticker = any($2)`, [SLATE, CARDED]);
});
beforeEach(() => useFetch(pollRoute()));
after(async () => { restore(); await db?.end(); });

const market = async (ticker: string) =>
  (await db!.query(`select yes_bid_cents, yes_ask_cents, volume, kalshi_status, prices_updated_at
                    from markets where ticker = $1`, [ticker])).rows[0];

test("refreshes prices, volume and status of every carded market in one request", { skip }, async () => {
  const before = await market(MOVED);
  const untouched = await market(NOT_CARDED);
  const s = await pollPrices(db!, SLATE);

  assert.deepEqual({ carded: s.carded, updated: s.updated, not_active: s.not_active }, { carded: 3, updated: 3, not_active: [CLOSED] });
  const pollCalls = calls.filter((c) => c.includes("tickers="));
  assert.equal(pollCalls.length, 1, "one request covers all carded markets");
  assert.deepEqual(new URL(pollCalls[0]!).searchParams.get("tickers")!.split(",").sort(), [...CARDED].sort(),
    "only carded markets are requested, and no status filter hides closed ones");
  assert.equal(new URL(pollCalls[0]!).searchParams.has("status"), false);

  const after = await market(MOVED);
  assert.deepEqual([before.yes_bid_cents, after.yes_bid_cents, after.yes_ask_cents], [9, 51, 53]);
  assert.equal(after.volume, 250);
  assert.ok(after.prices_updated_at > before.prices_updated_at);
  assert.equal((await market(CLOSED)).kalshi_status, "closed");
  assert.deepEqual(await market(NOT_CARDED), untouched, "markets without a card are left alone");
});

test("a market Kalshi closes shows as an out card", { skip }, async () => {
  await pollPrices(db!, SLATE);
  const { rows } = await db!.query(`select state from card_feed where market_ticker = $1`, [CLOSED]);
  assert.equal(rows[0].state, "out");
});

test("prices are marked fresh on every poll, even when nothing moved", { skip }, async () => {
  await pollPrices(db!, SLATE);
  await db!.query(`update markets set prices_updated_at = now() - interval '5 minutes' where ticker = $1`, [WINNER]);
  await pollPrices(db!, SLATE);
  const { rows } = await db!.query(
    `select extract(epoch from now() - prices_updated_at) as age from markets where ticker = $1`, [WINNER]);
  assert.ok(Number(rows[0].age) < 5, `price age after a poll: ${rows[0].age}s`);
});

test("re-running is safe: no duplicate price history for unchanged prices", { skip }, async () => {
  await pollPrices(db!, SLATE);
  const count = async () => Number((await db!.query(
    `select count(*) from market_price_snapshots where ticker = any($1)`, [CARDED])).rows[0].count);
  const n = await count();
  const s = await pollPrices(db!, SLATE);
  assert.equal(s.snapshots, 0);
  assert.equal(await count(), n);
});

test("a rate limit slows the poll down instead of failing it", { skip }, async () => {
  let limited = 0;
  const poll = pollRoute();
  useFetch((url) => {
    if (url.searchParams.has("tickers") && limited < 2) {
      limited++;
      return json({ error: { code: "too_many_requests", message: "too many requests" } }, 429, { "retry-after": "1" });
    }
    return poll(url);
  });
  const started = Date.now();
  const s = await pollPrices(db!, SLATE);
  assert.equal(limited, 2);
  assert.equal(s.updated, 3, "succeeded after backing off");
  assert.ok(Date.now() - started >= 2_000, "it waited, as Kalshi asked");
});

test("a carded market Kalshi doesn't return fails the run, after updating the rest", { skip }, async () => {
  useFetch(pollRoute([WINNER]));
  await db!.query(`update markets set prices_updated_at = now() - interval '5 minutes' where ticker = $1`, [MOVED]);
  await assert.rejects(pollPrices(db!, SLATE), new RegExp(`no data for 1 carded market\\(s\\): ${WINNER}`));

  const { rows } = await db!.query(`select status from pipeline_runs where job = 'price_poll' order by id desc limit 1`);
  assert.equal(rows[0].status, "failed");
  const { rows: [m] } = await db!.query(
    `select extract(epoch from now() - prices_updated_at) as age from markets where ticker = $1`, [MOVED]);
  assert.ok(Number(m.age) < 5, "the markets Kalshi did return were still refreshed");
});

test("no deck yet: nothing to poll, no Kalshi call", { skip }, async () => {
  const s = await pollPrices(db!, "2026-11-14");
  assert.equal(s.carded, 0);
  assert.equal(calls.filter((c) => c.includes("tickers=")).length, 0);
});

test("every poll is logged to pipeline_runs", { skip }, async () => {
  const before = Number((await db!.query(`select count(*) from pipeline_runs where job = 'price_poll'`)).rows[0].count);
  await pollPrices(db!, SLATE);
  const { rows } = await db!.query(`select status, outputs from pipeline_runs where job = 'price_poll' order by id desc`);
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].outputs.updated, 3);
});

// ------------------------------------------------------------------ no deadlock with ingest
// Ingest and the poller both write market rows. If they locked rows in different orders, a
// run of each could deadlock. Both lock in ticker order. The proof: while another session
// holds the lowest carded ticker, the poller must be waiting on it *without* having locked
// any higher ticker first.

async function waitForLockWait(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db!.query(
      `select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
    if (rows[0].n > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function assertLocksInTickerOrder(run: () => Promise<unknown>, lowest: string, highest: string) {
  const blocker = await db!.connect();
  const probe = await db!.connect();
  try {
    await blocker.query("begin");
    await blocker.query(`select 1 from markets where ticker = $1 for no key update`, [lowest]);
    const running = run();
    void running.catch(() => {});
    assert.ok(await waitForLockWait(), "the job should be waiting on the lowest ticker");
    await probe.query("begin");
    const free = await probe.query(`select 1 from markets where ticker = $1 for no key update nowait`, [highest])
      .then(() => true, () => false);
    await probe.query("rollback");
    await blocker.query("commit");
    await running;
    assert.ok(free, `${highest} was locked before ${lowest}: rows aren't locked in ticker order`);
  } finally {
    await blocker.query("rollback").catch(() => {});
    blocker.release();
    probe.release();
  }
}

test("the poller locks market rows in ticker order", { skip }, async () => {
  const sorted = [...CARDED].sort();
  // Rewrite the lowest row so it sits last on disk. A plain UPDATE scans in physical order, so
  // without the explicit ORDER BY ... FOR NO KEY UPDATE it would lock the higher tickers first.
  await db!.query(`update markets set updated_at = now() where ticker = $1`, [sorted[0]]);
  await assertLocksInTickerOrder(() => pollPrices(db!, SLATE), sorted[0]!, sorted.at(-1)!);
});

test("ingest locks market rows in ticker order", { skip }, async () => {
  const { rows } = await db!.query(`select min(ticker) lo, max(ticker) hi from markets`);
  await assertLocksInTickerOrder(() => ingest(db!, SLATE), rows[0].lo, rows[0].hi);
});
