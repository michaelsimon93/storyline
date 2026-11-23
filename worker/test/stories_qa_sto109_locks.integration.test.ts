// QA (PR #43 delta, STO-109): the shortlist's composite foreign key to markets (id, player_id, game_id) must not make the
// story job and the price poller / ingest block each other. The FK check takes FOR KEY SHARE on the market row; the poller
// and ingest take FOR NO KEY UPDATE and update only prices/status. Two real connections, lock_timeout to detect waits.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const GAME = "00000000-0000-0000-0000-00000109e001";
const PLAYER = "00000000-0000-0000-0000-00000109b001";
const MARKET = "00000000-0000-0000-0000-00000109f001";
const RUN = 109001;
let db: Db | null = null;
let pos = 0;

before(async () => {
  db = await freshDb("storyline_qa_sto109_locks");
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, abbr) values (1,'nba','Spurs','SAS'), (2,'nba','Warriors','GSW');
    insert into players (id, league, full_name, team_id) values ('${PLAYER}','nba','Lock One',1);
    insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at)
      values ('${GAME}','nba',storyline_today(),1,2, now() + interval '6 hours');
    insert into markets (id, league, game_id, kind, title, player_id, stat, strike, yes_bid_cents, yes_ask_cents, status, prices_updated_at)
      values ('${MARKET}','nba','${GAME}','player_stat','Lock One: 20+','${PLAYER}','points',20,50,52,'open', now() - interval '1 hour');
    insert into pipeline_runs (id, job, slate_date, status) values (${RUN}, 'story', storyline_today(), 'ok');`);
});

after(async () => { await db?.end(); });

/** The insert the story job does, with a fresh position and stat so rows never collide. */
function insertStory(c: pg.PoolClient) {
  pos++;
  return c.query(
    `insert into story_shortlist (run_id, slate_date, league, team_id, position, player_id, game_id, angle, stat, score, summary, market_id, slot_kind)
     values ($1, storyline_today(), 'nba', 1, $2, $3, $4, 'hot_streak', $6, 50, 'x', $5, 'quota')`,
    [RUN, pos, PLAYER, GAME, MARKET, `pts${pos}`]);
}

/** The poller's write: lock the market FOR NO KEY UPDATE in id order, then refresh prices and status. */
async function pollerUpdate(c: pg.PoolClient, bid: number) {
  await c.query(`select id from markets where id = $1 order by id for no key update`, [MARKET]);
  await c.query(`update markets set yes_bid_cents = $2, yes_ask_cents = $3, status = 'open', prices_updated_at = now(), updated_at = now() where id = $1`, [MARKET, bid, bid + 2]);
}

/** Runs `holder` in an open transaction on one connection, then `other` on a second one with a 1s lock_timeout. */
async function race(holder: (c: pg.PoolClient) => Promise<unknown>, other: (c: pg.PoolClient) => Promise<unknown>): Promise<"ok" | string> {
  const a = await db!.connect(), b = await db!.connect();
  try {
    await a.query("begin"); await holder(a);
    await b.query("begin"); await b.query("set local lock_timeout = '1s'");
    try { await other(b); await b.query("commit"); return "ok"; }
    catch (e) { await b.query("rollback"); return (e as Error).message; }
  } finally {
    await a.query("rollback").catch(() => {});
    a.release(); b.release();
  }
}

test("control: a key lock on the market (FOR UPDATE) does block the shortlist insert, so this test can see a wait", { skip }, async () => {
  const r = await race((c) => c.query(`select 1 from markets where id = $1 for update`, [MARKET]), insertStory);
  assert.match(r, /lock timeout/);
});

// attack (concurrency): poller mid-update while the story job writes its shortlist.
test("STO-109 locks: the story job's insert is not blocked by a poller holding the market row mid-update", { skip }, async () => {
  assert.equal(await race((c) => pollerUpdate(c, 40), insertStory), "ok");
});

// attack (concurrency): story job's transaction open (FK holds FOR KEY SHARE) while the poller refreshes prices.
test("STO-109 locks: the poller's price refresh is not blocked by an open story-job transaction referencing the market", { skip }, async () => {
  assert.equal(await race(insertStory, (c) => pollerUpdate(c, 41)), "ok");
  assert.equal((await db!.query(`select yes_bid_cents from markets where id = $1`, [MARKET])).rows[0].yes_bid_cents, 41);
});
