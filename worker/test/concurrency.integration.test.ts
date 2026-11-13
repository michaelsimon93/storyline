// Proves place_pick's wallet lock: two picks racing for the last $5 can't both win.
// Uses two real Postgres connections, each acting as the same signed-in user.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";

const USER = "33333333-3333-3333-3333-333333333333";
const CARD_A = "00000000-0000-0000-0000-00000000aaa1";
const CARD_B = "00000000-0000-0000-0000-00000000aaa2";
const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";

let db: Db | null = null;

before(async () => {
  db = await freshDb("storyline_concurrency_test");
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, kalshi_abbr, espn_abbr, espn_id) values (1,'nba','Spurs','SAS','SA','24'), (2,'nba','Warriors','GSW','GS','9');
    insert into players (id, league, full_name, team_id, kalshi_player_id) values
      ('00000000-0000-0000-0000-0000000000b1','nba','Player One',1,'k1'),
      ('00000000-0000-0000-0000-0000000000b2','nba','Player Two',2,'k2');
    insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at)
      values ('00000000-0000-0000-0000-0000000000e1','nba','e1','G1',storyline_today(),1,2, now() + interval '6 hours');
    insert into markets (ticker, league, game_id, kind, kalshi_series, title, player_id, stat, strike, yes_ask_cents, no_ask_cents, kalshi_status, prices_updated_at) values
      ('M1','nba','00000000-0000-0000-0000-0000000000e1','player_stat','KXNBAPTS','Player One: 20+ points','00000000-0000-0000-0000-0000000000b1','points',20,50,51,'active',now()),
      ('M2','nba','00000000-0000-0000-0000-0000000000e1','player_stat','KXNBAPTS','Player Two: 20+ points','00000000-0000-0000-0000-0000000000b2','points',20,50,51,'active',now());
    insert into cards (id, slate_date, sort_key, game_id, subject, player_id, market_ticker, blurb) values
      ('${CARD_A}', storyline_today(), 1, '00000000-0000-0000-0000-0000000000e1', 'player', '00000000-0000-0000-0000-0000000000b1', 'M1', 'a'),
      ('${CARD_B}', storyline_today(), 2, '00000000-0000-0000-0000-0000000000e1', 'player', '00000000-0000-0000-0000-0000000000b2', 'M2', 'b');
    insert into auth.users (id) values ('${USER}');`);

  // Sign up through the real function, then drain the wallet to exactly $5.
  await asUser(async (c) => { await c.query(`select create_profile('Racer')`); });
  await db.query(`insert into ledger_entries (user_id, wallet_id, type, amount_cents, memo)
                  select user_id, id, 'adjustment', -9500, 'test: leave exactly $5' from wallets`);
});

after(async () => { await db?.end(); });

/** Run fn inside a transaction on its own connection, acting as the signed-in USER. */
async function asUser<T>(fn: (c: pg.PoolClient) => Promise<T>, holdMs = 0): Promise<T> {
  const c = await db!.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [USER]);
    const out = await fn(c);
    if (holdMs) await c.query(`select pg_sleep(${holdMs / 1000})`); // keep the lock held
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("two simultaneous picks on a $5 wallet: exactly one succeeds", { skip }, async () => {
  // A places its pick and holds the transaction open; B fires while A still holds the lock.
  const a = asUser((c) => c.query(`select place_pick('${CARD_A}', 'yes')`), 500);
  await sleep(150);
  const b = asUser((c) => c.query(`select place_pick('${CARD_B}', 'yes')`));

  const [ra, rb] = await Promise.allSettled([a, b]);
  assert.equal(ra.status, "fulfilled", "first pick should succeed");
  assert.equal(rb.status, "rejected", "second pick must not also succeed");
  assert.match(String((rb as PromiseRejectedResult).reason), /insufficient_funds/);

  const { rows: [r] } = await db!.query(`
    select (select count(*)::int from picks) picks, (select balance_cents from wallet_balances) balance`);
  assert.equal(r.picks, 1);
  assert.equal(r.balance, 0, "balance can never go negative");
});

test("double-tap on the same card: one pick, never two stakes", { skip }, async () => {
  await db!.query(`insert into ledger_entries (user_id, wallet_id, type, amount_cents, memo)
                   select user_id, id, 'adjustment', 1000, 'test: top up' from wallets`);
  const tap = () => asUser((c) => c.query(`select place_pick('${CARD_B}', 'no')`), 200);
  const results = await Promise.allSettled([tap(), tap()]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const { rows: [r] } = await db!.query(`
    select (select count(*)::int from picks where card_id = '${CARD_B}') picks,
           (select count(*)::int from ledger_entries where type = 'pick_stake') stakes`);
  assert.equal(r.picks, 1);
  assert.equal(r.stakes, 2, "one stake per pick: card A's and this one");
});
