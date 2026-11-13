// Ingest end to end: recorded fixtures in, real Postgres out.
// Requires TEST_DATABASE_URL (skipped otherwise). Runs in CI.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../src/jobs/ingest.js";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";
import { installFetch, slateRoutes } from "./helpers/mockFetch.js";

let db: Db | null = null;
let restore = () => {};

before(async () => {
  db = await freshDb("storyline_ingest_test");
  restore = installFetch(slateRoutes).restore;
});
after(async () => {
  restore();
  await db?.end();
});

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";

test("ingests the MIL @ ORL slate", { skip }, async () => {
  const s = await ingest(db!, "2026-11-13");

  assert.equal(s.games, 1);
  assert.deepEqual(s.markets, { KXNBAPTS: 37, KXNBAREB: 46, KXNBAAST: 41, KXNBA3PT: 54, KXNBAPRA: 31, KXNBAGAME: 2 });
  assert.equal(s.players.unmatched.length, 0, `unmatched: ${s.players.unmatched}`);
  assert.equal(s.players.exact + s.players.fuzzy, s.players.total);
  assert.ok(s.outOrDoubtful.some((x) => x.startsWith("Jalen Suggs")), "Suggs flagged as Out");

  const { rows: [g] } = await db!.query(`
    select g.kalshi_game_key, g.tip_off_at, a.kalshi_abbr away, h.kalshi_abbr home, g.broadcasts
    from games g join teams a on a.id = g.away_team_id join teams h on h.id = g.home_team_id`);
  assert.equal(g.kalshi_game_key, "26NOV13MILORL");
  assert.equal(g.away, "MIL");
  assert.equal(g.home, "ORL");
  assert.equal(new Date(g.tip_off_at).toISOString(), "2026-11-14T00:00:00.000Z");
});

test("markets are written with correct kind, stat, strike and cents", { skip }, async () => {
  const { rows } = await db!.query(`
    select kind, stat, strike::float, yes_ask_cents, no_ask_cents, player_id, team_id
    from markets where ticker = 'KXNBAPTS-26NOV13MILORL-ORLABLACK0-25'`);
  const m = rows[0];
  assert.equal(m.kind, "player_stat");
  assert.equal(m.stat, "points");
  assert.equal(m.strike, 25);           // Kalshi floor_strike 24.5 "greater" → 25+
  assert.equal(m.yes_ask_cents, 11);    // "0.1100" → 11
  assert.ok(m.player_id);
  assert.equal(m.team_id, null);

  const { rows: winners } = await db!.query(`
    select m.kind, t.kalshi_abbr from markets m join teams t on t.id = m.team_id where m.kind = 'game_winner' order by 2`);
  assert.deepEqual(winners.map((w) => w.kalshi_abbr), ["MIL", "ORL"]);
});

test("markets from other nights are ignored", { skip }, async () => {
  const { rows } = await db!.query(`select count(*)::int n from markets where ticker not like '%26NOV13MILORL%'`);
  assert.equal(rows[0].n, 0);
});

test("re-running is safe: no duplicates, prices refresh", { skip }, async () => {
  const counts = async () => (await db!.query(`
    select (select count(*) from games)::int g, (select count(*) from markets)::int m,
           (select count(*) from players)::int p, (select count(*) from teams)::int t`)).rows[0];
  const before1 = await counts();

  await db!.query(`update markets set yes_ask_cents = 99, prices_updated_at = now() - interval '1 hour'
                   where ticker = 'KXNBAPTS-26NOV13MILORL-ORLABLACK0-25'`);
  await ingest(db!, "2026-11-13");

  assert.deepEqual(await counts(), before1);
  const { rows: [m] } = await db!.query(`
    select yes_ask_cents, prices_updated_at > now() - interval '1 minute' fresh
    from markets where ticker = 'KXNBAPTS-26NOV13MILORL-ORLABLACK0-25'`);
  assert.equal(m.yes_ask_cents, 11, "price restored from source");
  assert.equal(m.fresh, true);
});

test("every run is logged to pipeline_runs", { skip }, async () => {
  const { rows } = await db!.query(`select job, status, outputs->>'games' games from pipeline_runs order by id`);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.job === "ingest" && r.status === "ok" && r.games === "1"));
});

test("a failed run is logged as failed, with the error", { skip }, async () => {
  restore();
  restore = installFetch(() => new Response("{}", { status: 404 })).restore;
  await assert.rejects(ingest(db!, "2026-11-13"));
  const { rows: [r] } = await db!.query(`select status, error from pipeline_runs order by id desc limit 1`);
  assert.equal(r.status, "failed");
  assert.match(r.error, /HTTP 404/);
});
