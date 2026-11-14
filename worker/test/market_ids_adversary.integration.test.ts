// test-adversary (STO-38): ingest and the poller after markets got our own ids and Kalshi
// tickers moved to external_ids. Real Postgres, recorded fixtures, mocked fetch.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../src/jobs/ingest.js";
import { pollPrices } from "../src/jobs/poller.js";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";
import { fixture, installFetch, json, slateRoutes, type Route } from "./helpers/mockFetch.js";
import { idOf } from "./helpers/markets.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const SLATE = "2026-11-13";
const BLACK25 = "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25";
const WINNER = "KXNBAGAME-26NOV13MILORL-ORL";
const MIL_WIN = "KXNBAGAME-26NOV13MILORL-MIL";

const dbs: Db[] = [];
let restore = () => {};
after(async () => { restore(); for (const d of dbs) await d.end(); });

async function db(name: string): Promise<Db> {
  const d = (await freshDb(`adv38_${name}`))!;
  dbs.push(d);
  return d;
}
function useFetch(...routes: Route[]) {
  restore();
  restore = installFetch(...routes, slateRoutes).restore;
}
const counts = async (d: Db) => (await d.query(`
  select (select count(*) from markets)::int m, (select count(*) from external_ids)::int x,
         (select count(distinct external_id) from external_ids)::int t`)).rows[0];

/** Kalshi's KXNBAGAME series page, with one market listed twice (e.g. it shifted across pages). */
const duplicatedWinnerPage: Route = (url) => {
  if (url.hostname !== "external-api.kalshi.com" || url.searchParams.get("series_ticker") !== "KXNBAGAME") return undefined;
  const body = fixture("kalshi-KXNBAGAME.json") as { markets: { ticker: string }[]; cursor: string };
  body.markets.push({ ...body.markets.find((m) => m.ticker === WINNER)! });
  return json(body);
};

async function waitForLockWait(d: Db, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await d.query(
      `select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
    if (rows[0].n > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// ------------------------------------------------------------------ idempotency (coverage)

// Attack: re-running ingest (3x) must not mint new market ids or new external_ids rows.
test("adv38: three ingest runs keep exactly one market and one Kalshi id per ticker", { skip }, async () => {
  const d = await db("rerun");
  useFetch();
  await ingest(d, SLATE);
  const first = await counts(d);
  const ids = (await d.query(`select market_id, external_id from external_ids order by external_id`)).rows;
  await ingest(d, SLATE);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first);
  assert.equal(first.m, first.x);
  assert.equal(first.x, first.t);
  assert.deepEqual((await d.query(`select market_id, external_id from external_ids order by external_id`)).rows, ids,
    "a re-run must not re-key any market");
});

// Attack: a duplicated ticker in Kalshi's payload on a RE-run (markets already known).
test("adv38: a ticker listed twice by Kalshi on a re-run doesn't fail or duplicate", { skip }, async () => {
  const d = await db("dupe_rerun");
  useFetch();
  await ingest(d, SLATE);
  const before = await counts(d);
  useFetch(duplicatedWinnerPage);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), before);
});

// ------------------------------------------------------------------ findings

// Attack: a duplicated ticker in Kalshi's payload on the FIRST ingest of a slate (markets new).
// The materialized `fresh` CTE mints two ids for one ticker, the external_ids insert hits its
// primary key, and the single statement rolls back EVERY new market: no deck can be built.
test("adv38: a ticker listed twice by Kalshi on the first ingest still creates the slate", { skip }, async () => {
  const d = await db("dupe_first");
  useFetch(duplicatedWinnerPage);
  await ingest(d, SLATE);   // FAILS: duplicate key value violates unique constraint "external_ids_pkey"
  const c = await counts(d);
  assert.equal(c.m, 211);
  assert.equal(c.x, 211);
});

// Attack: two ingests creating the same new market at once (e.g. the scheduler's lock connection
// dropped mid-run, which scheduler.ts says can let another copy run alongside). The old
// `on conflict (ticker) do update` absorbed this; the new insert has no conflict handling, so the
// second run fails outright and none of its new markets are written.
test("adv38: an ingest racing another ingest that is creating the same market doesn't fail", { skip }, async () => {
  const d = await db("race");
  useFetch();
  await ingest(d, SLATE);
  // Make one (uncarded) market "new" again.
  const { rows: [m] } = await d.query(
    `select m.* from markets m where id = $1`, [await idOf(d, MIL_WIN)]);
  await d.query(`delete from markets where id = $1`, [m.id]);   // cascades its external_ids row

  // Another ingest is mid-statement: it has created the market + Kalshi id but not committed yet.
  // (The market row is committed up front only so this simulation doesn't hold a key-share lock
  // on teams, which would block ingest's teams upsert long before the step under test.)
  const { rows: [created] } = await d.query(
    `insert into markets (id, league, game_id, kind, title, team_id, status, prices_updated_at)
     values (gen_random_uuid(), 'nba', $1, 'game_winner', $2, $3, 'open', now()) returning id`,
    [m.game_id, m.title, m.team_id]);
  const other = await d.connect();
  try {
    await other.query("begin");
    await other.query(`insert into external_ids (source, kind, external_id, market_id) values ('kalshi', 'market', $1, $2)`,
      [MIL_WIN, created.id]);
    const running = ingest(d, SLATE);
    void running.catch(() => {});
    assert.ok(await waitForLockWait(d), "ingest should be waiting on the other run's uncommitted Kalshi id");
    const { rows: waiting } = await d.query(
      `select query from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
    assert.match(waiting[0].query, /insert into external_ids/, "ingest is blocked attaching the Kalshi id");
    await other.query("commit");
    await running;   // conflict is a no-op: the other run's id stands
  } finally {
    await other.query("rollback").catch(() => {});
    other.release();
  }
  const c = await counts(d);
  assert.equal(c.m, c.x, "every market has exactly one Kalshi id");
});

// Attack: a market whose external_ids row is gone (manual cleanup, a bad migration, a future
// "re-map" script). The ticker was the primary key before, so one-market-per-Kalshi-ticker held
// by construction. Now ingest silently mints a SECOND market for the same Kalshi market, and the
// original (the one cards and picks point at) is orphaned: never priced again.
test("adv38: losing a market's Kalshi id doesn't make ingest create a duplicate market", { skip }, async () => {
  const d = await db("orphan_ingest");
  useFetch();
  await ingest(d, SLATE);
  const before = await counts(d);
  const orig = await idOf(d, BLACK25);
  await d.query(`delete from external_ids where market_id = $1`, [orig]);
  await d.query(`update markets set prices_updated_at = now() - interval '1 hour' where id = $1`, [orig]);
  await ingest(d, SLATE);
  const { rows } = await d.query(
    `select count(*)::int n from markets where title = (select title from markets where id = $1)`, [orig]);
  assert.equal(rows[0].n, 1, "one Kalshi market must map to one Storyline market");   // FAILS: 2
  assert.equal((await counts(d)).m, before.m);
});

// Attack: a carded market with no Kalshi id. The poller's lookup joins through external_ids,
// so the market silently drops out of `carded`, is never requested, and the run reports ok
// while the card goes stale (picks then fail with prices_stale). The poller already treats
// "carded market Kalshi didn't return" as a loud failure; this is the same outcome, silently.
test("adv38: the poller fails loudly when a carded market has no Kalshi id", { skip }, async () => {
  const d = await db("orphan_poll");
  useFetch();
  await ingest(d, SLATE);
  const ids = [await idOf(d, BLACK25), await idOf(d, WINNER)];
  await d.query(`
    insert into cards (slate_date, sort_key, game_id, subject, player_id, team_id, market_id, blurb)
    select $1, row_number() over (order by id), game_id,
           case when kind = 'game_winner' then 'team' else 'player' end::subject_type,
           player_id, case when kind = 'game_winner' then team_id end, id, 'story'
    from markets where id = any($2)`, [SLATE, ids]);
  await d.query(`delete from external_ids where market_id = $1`, [ids[0]]);
  const pollRoute: Route = (url) => {
    if (url.hostname !== "external-api.kalshi.com" || !url.searchParams.has("tickers")) return undefined;
    const wanted = new Set(url.searchParams.get("tickers")!.split(","));
    const body = fixture("kalshi-tickers-poll.json") as { markets: { ticker: string }[] };
    return json({ cursor: "", markets: body.markets.filter((m) => wanted.has(m.ticker)) });
  };
  useFetch(pollRoute);
  // FAILS: resolves with { carded: 1, updated: 1 } and pipeline_runs status 'ok'.
  await assert.rejects(pollPrices(d, SLATE), /no Kalshi id|carded market/i);
});
