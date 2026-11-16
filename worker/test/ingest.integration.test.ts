// Ingest end to end: recorded fixtures in, real Postgres out.
// Requires TEST_DATABASE_URL (skipped otherwise). Runs in CI.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ingest, resolveSlateDate } from "../src/jobs/ingest.js";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";
import { installFetch, slateRoutes } from "./helpers/mockFetch.js";
import { idOf } from "./helpers/markets.js";
import { GAMES, TEAMS } from "./helpers/externalIds.js";

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
  assert.equal(s.snapshots, 211, "first run snapshots every market");

  const { rows: [g] } = await db!.query(`
    select g.kalshi_game_key, g.tip_off_at, a.kalshi_abbr away, h.kalshi_abbr home, g.broadcasts
    from ${GAMES("g")} join ${TEAMS("a")} on a.id = g.away_team_id join ${TEAMS("h")} on h.id = g.home_team_id`);
  assert.equal(g.kalshi_game_key, "26NOV13MILORL");
  assert.equal(g.away, "MIL");
  assert.equal(g.home, "ORL");
  assert.equal(new Date(g.tip_off_at).toISOString(), "2026-11-14T00:00:00.000Z");
});

test("provider IDs for teams, players and games live in external_ids, one row each (STO-39)", { skip }, async () => {
  const { rows } = await db!.query(`
    select source, kind, count(*)::int n from external_ids where kind <> 'market' group by 1, 2 order by 1, 2`);
  const players = (await db!.query(`select count(*)::int n from players`)).rows[0].n;
  assert.deepEqual(rows, [
    { source: "espn", kind: "game", n: 1 }, { source: "espn", kind: "player", n: players },
    { source: "espn", kind: "team", n: 2 },
    { source: "kalshi", kind: "game", n: 1 }, { source: "kalshi", kind: "player", n: players },
    { source: "kalshi", kind: "team", n: 2 },
  ], "every player matched, so each has both ids");
  const { rows: [g] } = await db!.query(`select espn_event_id, kalshi_game_key from ${GAMES("g")}`);
  assert.deepEqual(g, { espn_event_id: "401909297", kalshi_game_key: "26NOV13MILORL" });
  const { rows: teams } = await db!.query(`select kalshi_abbr, espn_id from ${TEAMS("t")} order by 1`);
  assert.deepEqual(teams, [{ kalshi_abbr: "MIL", espn_id: "15" }, { kalshi_abbr: "ORL", espn_id: "19" }]);
});

test("markets are written with correct kind, stat, strike and cents", { skip }, async () => {
  const { rows } = await db!.query(`
    select kind, stat, strike::float, yes_ask_cents, no_ask_cents, player_id, team_id
    from markets where id = $1`, [await idOf(db!, "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25")]);
  const m = rows[0];
  assert.equal(m.kind, "player_stat");
  assert.equal(m.stat, "points");
  assert.equal(m.strike, 25);           // Kalshi floor_strike 24.5 "greater" → 25+
  assert.equal(m.yes_ask_cents, 11);    // "0.1100" → 11
  assert.ok(m.player_id);
  assert.equal(m.team_id, null);

  const { rows: winners } = await db!.query(`
    select m.kind, t.kalshi_abbr from markets m join ${TEAMS("t")} on t.id = m.team_id where m.kind = 'game_winner' order by 2`);
  assert.deepEqual(winners.map((w) => w.kalshi_abbr), ["MIL", "ORL"]);
});

test("markets from other nights are ignored", { skip }, async () => {
  const { rows } = await db!.query(`select count(*)::int n from external_ids where kind = 'market' and external_id not like '%26NOV13MILORL%'`);
  assert.equal(rows[0].n, 0);
  const { rows: [all] } = await db!.query(`select (select count(*) from markets)::int m, (select count(*) from external_ids where kind = 'market')::int x`);
  assert.equal(all.m, all.x, "every market has exactly one Kalshi id");
});

test("re-running is safe: no duplicates, prices refresh", { skip }, async () => {
  const counts = async () => (await db!.query(`
    select (select count(*) from games)::int g, (select count(*) from markets)::int m,
           (select count(*) from players)::int p, (select count(*) from teams)::int t,
           (select json_object_agg(source || ':' || kind, n) from
              (select source, kind, count(*)::int n from external_ids group by 1, 2) x) ids`)).rows[0];
  const before1 = await counts();

  const blackId = await idOf(db!, "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25");
  await db!.query(`update markets set yes_ask_cents = 99, prices_updated_at = now() - interval '1 hour'
                   where id = $1`, [blackId]);
  await ingest(db!, "2026-11-13");

  assert.deepEqual(await counts(), before1);
  const { rows: [m] } = await db!.query(`
    select yes_ask_cents, prices_updated_at > now() - interval '1 minute' fresh
    from markets where id = $1`, [blackId]);
  assert.equal(m.yes_ask_cents, 11, "price restored from source");
  assert.equal(m.fresh, true);
  const { rows: [h] } = await db!.query(`select count(*)::int n from market_price_snapshots`);
  assert.equal(h.n, 211, "unchanged prices on re-run add no snapshots");
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

test("slate date comes from the database, not a JS re-implementation", { skip }, async () => {
  const { rows: [r] } = await db!.query(`select storyline_today()::text d`);
  assert.equal(await resolveSlateDate(db!), r.d);
  assert.equal(await resolveSlateDate(db!, "2026-11-13"), "2026-11-13");
});

test("config loads from the database with the seeded values", { skip }, async () => {
  const { loadConfig } = await import("../src/lib/config.js");
  const c = await loadConfig(db!);
  assert.equal(c.cardsPerDay, 10);
  assert.equal(c.pickStakeCents, 500);
  assert.equal(c.priceBandMin, 25);
  assert.equal(c.priceBandMax, 75);
});

test("feature flags evaluate server-side, allowlist first", { skip }, async () => {
  const { flagEnabled } = await import("../src/lib/config.js");
  const me = "11111111-1111-1111-1111-111111111111";
  await db!.query(`insert into feature_flags (key, description, enabled, rollout_percent, allow_user_ids)
                   values ('worker_test', 'test', true, 0, array[$1]::uuid[])`, [me]);
  assert.equal(await flagEnabled(db!, "worker_test", me), true);
  assert.equal(await flagEnabled(db!, "worker_test", "22222222-2222-2222-2222-222222222222"), false);
  assert.equal(await flagEnabled(db!, "missing_flag", me), false);
});
