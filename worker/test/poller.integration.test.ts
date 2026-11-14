// Price poller end to end: the recorded slate is ingested, three of its markets are carded,
// then a poll runs against a recorded GET /markets?tickers=... response.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../src/jobs/ingest.js";
import { pollPrices } from "../src/jobs/poller.js";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";
import { fixture, installFetch, json, slateRoutes, type Route } from "./helpers/mockFetch.js";
import { idOf, idsOf } from "./helpers/markets.js";

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
    insert into cards (slate_date, sort_key, game_id, subject, player_id, team_id, market_id, blurb)
    select $1, row_number() over (order by id), game_id,
           case when kind = 'game_winner' then 'team' else 'player' end::subject_type,
           player_id, case when kind = 'game_winner' then team_id end, id, 'story'
    from markets where id = any($2)`, [SLATE, await idsOf(db, CARDED)]);
});
beforeEach(() => useFetch(pollRoute()));
after(async () => { restore(); await db?.end(); });

/** Card states depend on the clock: keep the recorded game in the future, so a test run after
 *  the real Nov 13 tip-off still sees pre-game states. */
async function gameNotStarted() {
  await db!.query(`update games set tip_off_at = now() + interval '1 day', status = 'scheduled'`);
}

const market = async (ticker: string) =>
  (await db!.query(`select yes_bid_cents, yes_ask_cents, volume, status, prices_updated_at
                    from markets where id = $1`, [await idOf(db!, ticker)])).rows[0];

test("refreshes prices, volume and status of every carded market in one request", { skip }, async () => {
  const before = await market(MOVED);
  const untouched = await market(NOT_CARDED);
  const s = await pollPrices(db!, SLATE);

  assert.deepEqual({ carded: s.carded, updated: s.updated, not_open: s.not_open }, { carded: 3, updated: 3, not_open: [CLOSED] });
  const pollCalls = calls.filter((c) => c.includes("tickers="));
  assert.equal(pollCalls.length, 1, "one request covers all carded markets");
  assert.deepEqual(new URL(pollCalls[0]!).searchParams.get("tickers")!.split(",").sort(), [...CARDED].sort(),
    "only carded markets are requested, and no status filter hides closed ones");
  assert.equal(new URL(pollCalls[0]!).searchParams.has("status"), false);

  const after = await market(MOVED);
  assert.deepEqual([before.yes_bid_cents, after.yes_bid_cents, after.yes_ask_cents], [9, 51, 53]);
  assert.equal(after.volume, 250);
  assert.ok(after.prices_updated_at > before.prices_updated_at);
  assert.equal((await market(CLOSED)).status, "closed", "Kalshi's 'closed' in our words");
  assert.deepEqual(await market(NOT_CARDED), untouched, "markets without a card are left alone");
});

test("a market Kalshi closes shows as an out card", { skip }, async () => {
  await gameNotStarted();
  await pollPrices(db!, SLATE);
  const { rows } = await db!.query(`select state from card_feed where market_id = $1`, [await idOf(db!, CLOSED)]);
  assert.equal(rows[0].state, "out");
});

test("prices are marked fresh on every poll, even when nothing moved", { skip }, async () => {
  await pollPrices(db!, SLATE);
  await db!.query(`update markets set prices_updated_at = now() - interval '5 minutes' where id = $1`, [await idOf(db!, WINNER)]);
  await pollPrices(db!, SLATE);
  const { rows } = await db!.query(
    `select extract(epoch from now() - prices_updated_at) as age from markets where id = $1`, [await idOf(db!, WINNER)]);
  assert.ok(Number(rows[0].age) < 5, `price age after a poll: ${rows[0].age}s`);
});

test("re-running is safe: no duplicate price history for unchanged prices", { skip }, async () => {
  await pollPrices(db!, SLATE);
  const count = async () => Number((await db!.query(
    `select count(*) from market_price_snapshots where market_id = any($1)`, [await idsOf(db!, CARDED)])).rows[0].count);
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
  await db!.query(`update markets set prices_updated_at = now() - interval '5 minutes' where id = $1`, [await idOf(db!, MOVED)]);
  await assert.rejects(pollPrices(db!, SLATE), new RegExp(`no data for 1 carded market\\(s\\): ${WINNER}`));

  const { rows } = await db!.query(`select status from pipeline_runs where job = 'price_poll' order by id desc limit 1`);
  assert.equal(rows[0].status, "failed");
  const { rows: [m] } = await db!.query(
    `select extract(epoch from now() - prices_updated_at) as age from markets where id = $1`, [await idOf(db!, MOVED)]);
  assert.ok(Number(m.age) < 5, "the markets Kalshi did return were still refreshed");
});

test("a status word we don't know turns the card out and fails the run loudly", { skip }, async () => {
  // e.g. Kalshi adds a lifecycle state. Safe side: not open, so no picks; and an alert.
  const poll = pollRoute();
  useFetch((url) => {
    const res = poll(url);
    if (!res) return undefined;
    return (async () => {
      const body = await res.json() as { markets: { ticker: string; status: string }[] };
      for (const m of body.markets) if (m.ticker === WINNER) m.status = "suspended_for_review";
      return json(body);
    })() as unknown as Response;
  });
  await gameNotStarted();
  await assert.rejects(pollPrices(db!, SLATE),
    new RegExp(`unknown Kalshi status for 1 market\\(s\\), treated as paused: ${WINNER} \\("suspended_for_review"\\)`));
  assert.equal((await market(WINNER)).status, "paused");
  const { rows } = await db!.query(`select state from card_feed where market_id = $1`, [await idOf(db!, WINNER)]);
  assert.equal(rows[0].state, "out");
  useFetch(pollRoute());
  await pollPrices(db!, SLATE);                 // Kalshi back to normal: the card reopens
  assert.equal((await market(WINNER)).status, "open");
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

// ------------------------------------------------------------------ results and stale overwrites

test("the poller never writes results: settlement owns them", { skip }, async () => {
  // The fixture's closed market carries result 'no'. Kalshi can show a result before it is
  // final, and can amend it; paying out on it is settlement's job, with its own checks (STO-13).
  await pollPrices(db!, SLATE);
  const { rows } = await db!.query(`select result from markets where id = $1`, [await idOf(db!, CLOSED)]);
  assert.equal(rows[0].result, null);
});

test("ingest doesn't overwrite fresher prices the poller wrote while it was running", { skip }, async () => {
  // Ingest reads Kalshi early, then spends a while on ESPN rosters before writing markets.
  // A poll that lands in between has newer data, which ingest must not replace.
  const inner = installFetch(pollRoute(), slateRoutes);
  const innerFetch = globalThis.fetch;
  let polled = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!polled && /\/roster$/.test(new URL(href).pathname)) {
      polled = true;
      globalThis.fetch = innerFetch;            // the poll itself uses the plain mocks
      await pollPrices(db!, SLATE);
      globalThis.fetch = wrapped;
    }
    return innerFetch(input);
  }) as typeof fetch;
  const wrapped = globalThis.fetch;
  try {
    await ingest(db!, SLATE);
  } finally {
    inner.restore();
    useFetch(pollRoute());
  }
  assert.ok(polled, "the poll ran in the middle of ingest");
  const m = await market(MOVED);
  assert.deepEqual([m.yes_bid_cents, m.yes_ask_cents], [51, 53], "ingest replaced the poller's newer prices with stale ones");
  assert.equal((await market(CLOSED)).status, "closed", "ingest reverted a newer status");
});

test("ingest never clears a result settlement has written", { skip }, async () => {
  await db!.query(`update markets set result = 'yes' where id = $1`, [await idOf(db!, WINNER)]);
  try {
    useFetch();
    await ingest(db!, SLATE);
    const { rows } = await db!.query(`select result from markets where id = $1`, [await idOf(db!, WINNER)]);
    assert.equal(rows[0].result, "yes");
  } finally {
    await db!.query(`update markets set result = null where id = $1`, [await idOf(db!, WINNER)]);
  }
});

test("ingest reports an unknown Kalshi status loudly instead of quietly storing paused", { skip }, async () => {
  // e.g. Kalshi renames `active` to `open`: every market would become paused, the deck would be
  // empty, and with no deck the poller never calls Kalshi. Ingest is the only place to notice.
  const renamed: Route = (url) => {
    if (url.hostname !== "external-api.kalshi.com" || url.searchParams.get("series_ticker") !== "KXNBAGAME") return undefined;
    const body = fixture("kalshi-KXNBAGAME.json") as { markets: { status: string }[] };
    for (const m of body.markets) m.status = "open";
    return json(body);
  };
  useFetch(renamed);
  await gameNotStarted();
  await db!.query(`update markets set prices_updated_at = now() - interval '1 hour' where id = $1`, [await idOf(db!, WINNER)]);
  await assert.rejects(ingest(db!, SLATE),
    /unknown Kalshi status for 2 market\(s\), treated as paused: KXNBAGAME-26NOV13MILORL-MIL \("open"\), KXNBAGAME-26NOV13MILORL-ORL \("open"\)/);
  assert.equal((await market(WINNER)).status, "paused", "everything else was still written");
  const { rows } = await db!.query(`select status from pipeline_runs where job = 'ingest' order by id desc limit 1`);
  assert.equal(rows[0].status, "failed");
  useFetch(pollRoute());
  await pollPrices(db!, SLATE);              // the poller restores it from Kalshi's real word
});

test("the worker's status list matches the market_status enum in the database", { skip }, async () => {
  // Reads the live enum, so a later migration that adds a value can't drift past this check.
  const { MARKET_STATUSES } = await import("../src/domain/market.js");
  const { rows } = await db!.query(`select enum_range(null::market_status)::text[] as v`);
  assert.deepEqual(rows[0].v, [...MARKET_STATUSES]);
});

// ------------------------------------------------------------------ no deadlock with ingest
// Ingest and the poller both write market rows. If they locked rows in different orders, a
// run of each could deadlock. Both lock in market-id order (ADR-020 rule 3). The proof: while
// another session holds the lowest market id, the job must be waiting on it *without* having
// locked a higher id first.

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

async function assertLocksInIdOrder(run: () => Promise<unknown>, lowest: string, highest: string) {
  const blocker = await db!.connect();
  const probe = await db!.connect();
  try {
    await blocker.query("begin");
    await blocker.query(`select 1 from markets where id = $1 for no key update`, [lowest]);
    const running = run();
    void running.catch(() => {});
    assert.ok(await waitForLockWait(), "the job should be waiting on the lowest market id");
    await probe.query("begin");
    const free = await probe.query(`select 1 from markets where id = $1 for no key update nowait`, [highest])
      .then(() => true, () => false);
    await probe.query("rollback");
    await blocker.query("commit");
    await running;
    assert.ok(free, `${highest} was locked before ${lowest}: rows aren't locked in market-id order`);
  } finally {
    await blocker.query("rollback").catch(() => {});
    blocker.release();
    probe.release();
  }
}

test("the poller locks market rows in market-id order", { skip }, async () => {
  const sorted = (await idsOf(db!, CARDED)).sort();
  // Rewrite the lowest row so it sits last on disk. A plain UPDATE scans in physical order, so
  // without the explicit ORDER BY ... FOR NO KEY UPDATE it would lock the higher ids first.
  await db!.query(`update markets set updated_at = now() where id = $1`, [sorted[0]]);
  await assertLocksInIdOrder(() => pollPrices(db!, SLATE), sorted[0]!, sorted.at(-1)!);
});

test("ingest locks market rows in market-id order", { skip }, async () => {
  const { rows } = await db!.query(`select min(id::text)::uuid lo, max(id::text)::uuid hi from markets`);
  await assertLocksInIdOrder(() => ingest(db!, SLATE), rows[0].lo, rows[0].hi);
});
