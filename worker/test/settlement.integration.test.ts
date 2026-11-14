// Settlement under concurrency (from the test-adversary's findings), made deterministic:
// instead of sleeping, each test waits until Postgres shows a transaction blocked on a lock.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";

const U = "a5000000-0000-0000-0000-0000000000f1";
const CARD_1 = "a5000000-0000-0000-0000-0000000000c1";
const CARD_2 = "a5000000-0000-0000-0000-0000000000c2";
const CARD_3 = "a5000000-0000-0000-0000-0000000000c3";
const CARD_4 = "a5000000-0000-0000-0000-0000000000c4";
const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";

let db: Db | null = null;

before(async () => {
  db = await freshDb("storyline_settlement_test");
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, kalshi_abbr, espn_abbr, espn_id) values (1,'nba','A','AAA','AAA','1'), (2,'nba','B','BBB','BBB','2');
    insert into players (id, league, full_name, team_id, kalshi_player_id) values
      ('a5000000-0000-0000-0000-0000000000b1','nba','P1',1,'k1'), ('a5000000-0000-0000-0000-0000000000b2','nba','P2',1,'k2');
    insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at)
      values ('a5000000-0000-0000-0000-0000000000e1','nba','e1','G1',storyline_today(),1,2, now() + interval '6 hours');
    insert into markets (id, league, game_id, kind, title, player_id, stat, strike, yes_ask_cents, no_ask_cents, status, prices_updated_at) values
      (md5('S1')::uuid,'nba','a5000000-0000-0000-0000-0000000000e1','player_stat','P1: 20+','a5000000-0000-0000-0000-0000000000b1','points',20,40,61,'open',now()),
      (md5('S2')::uuid,'nba','a5000000-0000-0000-0000-0000000000e1','player_stat','P2: 20+','a5000000-0000-0000-0000-0000000000b2','points',20,40,61,'open',now());
    insert into cards (id, slate_date, sort_key, game_id, subject, player_id, market_id, blurb) values
      ('${CARD_1}', storyline_today(), 1, 'a5000000-0000-0000-0000-0000000000e1', 'player', 'a5000000-0000-0000-0000-0000000000b1', md5('S1')::uuid, 'a'),
      ('${CARD_2}', storyline_today(), 2, 'a5000000-0000-0000-0000-0000000000e1', 'player', 'a5000000-0000-0000-0000-0000000000b2', md5('S2')::uuid, 'b');
    insert into markets (id, league, game_id, kind, title, player_id, stat, strike, yes_ask_cents, no_ask_cents, status, prices_updated_at) values
      (md5('S3')::uuid,'nba','a5000000-0000-0000-0000-0000000000e1','player_stat','P1: 8+','a5000000-0000-0000-0000-0000000000b1','rebounds',8,40,61,'open',now()),
      (md5('S4')::uuid,'nba','a5000000-0000-0000-0000-0000000000e1','player_stat','P2: 8+','a5000000-0000-0000-0000-0000000000b2','rebounds',8,40,61,'open',now());
    insert into players (id, league, full_name, team_id, kalshi_player_id) values
      ('a5000000-0000-0000-0000-0000000000b3','nba','P3',2,'k3'), ('a5000000-0000-0000-0000-0000000000b4','nba','P4',2,'k4');
    update markets set player_id = 'a5000000-0000-0000-0000-0000000000b3' where id = md5('S3')::uuid;
    update markets set player_id = 'a5000000-0000-0000-0000-0000000000b4' where id = md5('S4')::uuid;
    insert into cards (id, slate_date, sort_key, game_id, subject, player_id, market_id, blurb) values
      ('${CARD_3}', storyline_today(), 3, 'a5000000-0000-0000-0000-0000000000e1', 'player', 'a5000000-0000-0000-0000-0000000000b3', md5('S3')::uuid, 'c'),
      ('${CARD_4}', storyline_today(), 4, 'a5000000-0000-0000-0000-0000000000e1', 'player', 'a5000000-0000-0000-0000-0000000000b4', md5('S4')::uuid, 'd');
    insert into auth.users (id) values ('${U}');`);
  await inTx(async (c) => { await c.query(`select create_profile('Settler')`); }, true);
});
after(async () => { await db?.end(); });

/** Run fn in a transaction on its own connection (as the user, or as the worker). Holds until `hold` resolves. */
async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>, asUser = false, hold?: Promise<void>): Promise<T> {
  const c = await db!.connect();
  try {
    await c.query("begin");
    if (asUser) {
      await c.query("set local role authenticated");
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [U]);
    }
    const out = await fn(c);
    if (hold) await hold;
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Resolves true once a backend whose query matches `pattern` is blocked on a lock. */
async function waitForLockWait(pattern = "%", timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db!.query(
      `select count(*)::int n from pg_stat_activity
       where wait_event_type = 'Lock' and datname = current_database() and query ilike $1`, [pattern]);
    if (rows[0].n > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

test("two settlement runs at the same moment pay exactly once", { skip }, async () => {
  await inTx((c) => c.query(`select place_pick('${CARD_1}', 'yes')`), true);
  await db!.query(`update markets set result = 'yes' where id = md5('S1')::uuid`);

  const release = gate();
  let aRan!: () => void;
  const aDone = new Promise<void>((r) => (aRan = r));
  const a = inTx(async (c) => { const r = await c.query<{ n: number }>(`select settle_market(md5('S1')::uuid) n`); aRan(); return r; }, false, release.p);
  await aDone;
  const b = inTx((c) => c.query<{ n: number }>(`select settle_market(md5('S1')::uuid) n`));
  const settled = Promise.allSettled([a, b]);
  const blocked = await waitForLockWait("%settle_market%");
  release.open();
  const [ra, rb] = await settled;

  assert.ok(blocked, "the second settlement should wait for the first");
  assert.equal(ra.status, "fulfilled");
  assert.equal(rb.status, "fulfilled");
  const n = (r: PromiseSettledResult<pg.QueryResult<{ n: number }>>) =>
    r.status === "fulfilled" ? r.value.rows[0]!.n : NaN;
  assert.equal(n(ra) + n(rb), 1, "the pick is settled by exactly one run");
  const { rows: [r] } = await db!.query(`
    select count(*)::int n, sum(amount_cents)::int amt from ledger_entries where type = 'pick_payout'`);
  assert.equal(r.n, 1);
  assert.equal(r.amt, 1250); // $5 at 40% → $12.50
});

test("a pick racing settlement is never left open on a resolved market", { skip }, async () => {
  // The pick's transaction has passed every check but not committed. The worker now writes the
  // result and settles. Without a lock, settlement can't see the in-flight pick, finishes, and
  // the pick commits afterwards: open forever on a resolved market.
  const releasePick = gate();
  let picked!: () => void;
  const pickDone = new Promise<void>((r) => (picked = r));
  const pick = inTx(async (c) => { const r = await c.query(`select place_pick('${CARD_2}', 'yes')`); picked(); return r; }, true, releasePick.p);
  await pickDone;

  const worker = inTx(async (c) => {
    await c.query(`update markets set result = 'no' where id = md5('S2')::uuid`);
    return c.query<{ n: number }>(`select settle_market(md5('S2')::uuid) n`);
  });
  const settled = Promise.allSettled([pick, worker]);
  const workerWaited = await waitForLockWait("%update markets%");
  releasePick.open();
  const [rp, rw] = await settled;

  assert.equal(rp.status, "fulfilled", "the in-flight pick commits");
  assert.equal(rw.status, "fulfilled", "settlement completes");
  assert.ok(workerWaited, "writing the result must wait for the in-flight pick on that market");
  const { rows: [r] } = await db!.query(`
    select count(*)::int open from picks p join markets m on m.id = p.market_id
    where p.status = 'open' and m.result is not null`);
  assert.equal(r.open, 0, "no open picks on a resolved market");
});

test("no deadlock when settlement and a pick touch the same wallet and market", { skip }, async () => {
  // Review finding (PR A): the worker records results for a game's markets, then settles.
  // Meanwhile the user taps a card on one of those markets. If place_pick held the wallet
  // and waited on the market while settlement held the market and needed the wallet
  // (ledger entries reference wallets), Postgres would kill one of them as a deadlock.
  await inTx((c) => c.query(`select place_pick('${CARD_3}', 'yes')`), true);   // open pick on S3

  const resume = gate();
  let resultsWritten!: () => void;
  const written = new Promise<void>((r) => (resultsWritten = r));
  const worker = inTx(async (c) => {
    await c.query(`update markets set result = 'yes' where id in (md5('S3')::uuid, md5('S4')::uuid)`);
    resultsWritten();
    await resume.p;                                   // pause holding both market rows
    return c.query<{ n: number }>(`select settle_market(md5('S3')::uuid) n`);
  });
  await written;
  const pick = inTx((c) => c.query(`select place_pick('${CARD_4}', 'yes')`), true);  // waits on S4
  const settled = Promise.allSettled([worker, pick]);
  assert.ok(await waitForLockWait("%place_pick%"), "the pick waits for the result being written");
  resume.open();
  const [rw, rp] = await settled;

  assert.equal(rw.status, "fulfilled", `settlement must not be a deadlock victim: ${rw.status === "rejected" ? rw.reason : ""}`);
  assert.equal(rp.status, "rejected", "a pick on a market that just settled is refused");
  assert.match(String((rp as PromiseRejectedResult).reason), /card_not_open:settled/, "refused as settled, not as a deadlock");
});
