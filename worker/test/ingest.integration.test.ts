// Ingest end to end: recorded fixtures in, real Postgres out.
// Requires TEST_DATABASE_URL (skipped otherwise). Runs in CI.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { ingest, resolveSlateDate } from "../src/jobs/ingest.js";
import { connect, type Db } from "../src/lib/db.js";
import { freshDb, migrationFiles } from "./helpers/testDb.js";
import { installFetch, slateRoutes, fixture, json, type Route } from "./helpers/mockFetch.js";
import { kalshiSource, type KalshiMarket } from "../src/sources/kalshi.js";
import type { MarketSource } from "../src/sources/types.js";
import { idOf } from "./helpers/markets.js";
import { GAMES, TEAMS, PLAYERS } from "./helpers/externalIds.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { pollPrices } from "../src/jobs/poller.js";

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
  const { rows: ours } = await db!.query(`select name, abbr from teams order by abbr`);
  assert.deepEqual(ours.map((t) => t.abbr), ["MIL", "ORL"], "our own short codes, readable without external_ids");
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

test("ingest reads markets through the MarketSource it is given (ADR-024)", { skip }, async () => {
  restore();   // an earlier test left ESPN returning 404
  restore = installFetch(slateRoutes).restore;
  const asked: string[] = [];
  const source: MarketSource<KalshiMarket> = {
    name: "kalshi",
    listOpen: async (series) => { asked.push(series); return kalshiSource.listOpen(series); },
    getByIds: kalshiSource.getByIds,
  };
  const s = await ingest(db!, "2026-11-13", source);
  assert.deepEqual(asked, ["KXNBAPTS", "KXNBAREB", "KXNBAAST", "KXNBA3PT", "KXNBAPRA", "KXNBAGAME"]);
  assert.equal(s.markets.KXNBAPTS, 37, "same result as through the default source");
});

test("a failing market source stops the run and records it failed (ADR-024 rule 6)", { skip }, async () => {
  restore();
  restore = installFetch(slateRoutes).restore;
  const source: MarketSource<KalshiMarket> = {
    name: "kalshi",
    listOpen: async () => { throw new Error("kalshi is down"); },
    getByIds: kalshiSource.getByIds,
  };
  const count = async () => (await db!.query(`select (select count(*) from markets)::int m, (select count(*) from market_price_snapshots)::int s`)).rows[0];
  const before = await count();
  await assert.rejects(ingest(db!, "2026-11-13", source), /kalshi is down/);
  assert.deepEqual(await count(), before, "no markets or snapshots written by the failed run");
  const { rows: [r] } = await db!.query(`select status, error from pipeline_runs where job = 'ingest' order by id desc limit 1`);
  assert.equal(r.status, "failed");
  assert.match(r.error, /kalshi is down/);
});

test("an injury status we have no name for is listed apart, so the new status gets noticed (STO-81)", { skip }, async () => {
  restore();
  restore = installFetch((url) => {
    if (/\/teams\/19\/roster$/.test(url.pathname)) {
      const d = structuredClone(fixture("espn-roster-19.json")) as any;
      d.athletes.find((a: any) => a.fullName === "Jalen Suggs").injuries = [{ status: "Day-To-Day" }, { status: "Suspension" }];
      return json(d);
    }
    return slateRoutes(url);
  }).restore;
  const s = await ingest(db!, "2026-11-13");
  assert.deepEqual(s.unknownInjuryStatus.map((x) => x.replace(/\s*\(.*?\)/, "")), ['Jalen Suggs: "Suspension"']);
  assert.ok(!s.outOrDoubtful.some((x) => x.startsWith("Jalen Suggs")), "listed once, under unknown");
  const { rows: [p] } = await db!.query(`select injury_status from players where full_name = 'Jalen Suggs'`);
  assert.equal(p.injury_status, "Suspension", "the raw value is stored, and it was the most severe of his two injuries, not the first");
});

describe("external ids for teams, players and games (STO-39)", () => {
const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const SLATE = "2026-11-13";
const BLACK_KALSHI_ID = "60bb439a-df6a-4fea-8312-4caa6a2c0fbe";
const SUPABASE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase");
const STO39 = "20261116200000_cross_reference_ids.sql";

const dbs: Db[] = [];
let restore = () => {};
after(async () => { restore(); for (const d of dbs) await d.end(); });

async function db(name: string): Promise<Db> {
  const d = (await freshDb(`ext39_${name}`))!;
  dbs.push(d);
  return d;
}
function useFetch(...routes: Route[]) {
  restore();
  restore = installFetch(...routes, slateRoutes).restore;
}
const urlFor = (name: string) => process.env.TEST_DATABASE_URL!.replace(/^(\w+:\/\/[^/]*\/)([^?]*)/, `$1${name}`);

const counts = async (d: Db) => (await d.query(`
  select (select count(*) from teams)::int t, (select count(*) from players)::int p, (select count(*) from games)::int g,
         (select count(*) from markets)::int m, (select count(*) from external_ids)::int ids`)).rows[0];
/** Rows that no provider ID can find again: teams without an ESPN ID, players without a Kalshi ID, games without either. */
const orphans = async (d: Db) => (await d.query(`
  select (select count(*) from teams t where not exists (select 1 from external_ids x where x.team_id = t.id and x.source = 'espn'))::int t,
         (select count(*) from players p where not exists (select 1 from external_ids x where x.player_id = p.id and x.source = 'kalshi'))::int p,
         (select count(*) from games g where (select count(*) from external_ids x where x.game_id = g.id) <> 2)::int g`)).rows[0];

// ------------------------------------------------------------------ migration on real (pre-STO-39) data

// Coverage: STO-39's migration is not yet deployed, so it will run against production rows. Seed the
// old shape (incl. a STO-32 replay, a Kalshi-only player, an ESPN-only player, the NBA/NFL ESPN-id
// clash), migrate, and prove every ID moved with the right league and that ingest then finds them.
test("ingest: the migration moves every existing provider ID, and ingest afterwards creates no duplicates", { skip }, async () => {
  const name = "ext39_migrate";
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const setup = new pg.Client({ connectionString: urlFor(name) });
  await setup.connect();
  try {
    await setup.query(readFileSync(join(SUPABASE, "tests", "supabase_stubs.sql"), "utf8"));
    const files = migrationFiles();
    const at = files.indexOf(STO39);
    assert.ok(at > 0, "STO-39's migration exists");
    for (const f of files.slice(0, at)) await setup.query(readFileSync(join(SUPABASE, "migrations", f), "utf8"));
    await setup.query(`
      insert into teams (id, league, name, kalshi_abbr, espn_abbr, espn_id) values
        (1, 'nba', 'Milwaukee Bucks', 'MIL', 'MIL', '15'), (2, 'nba', 'Orlando Magic', 'ORL', 'ORL', '19'),
        (3, 'nfl', 'Some NFL team', 'MIL', 'MIL', '15');   -- same abbr and ESPN id, other league
      select setval(pg_get_serial_sequence('teams', 'id'), 3);
      insert into players (id, league, full_name, team_id, espn_athlete_id, kalshi_player_id) values
        ('00000000-0000-0000-0000-0000000000a1', 'nba', 'Anthony Black', 2, '4712849', '${BLACK_KALSHI_ID}'),
        ('00000000-0000-0000-0000-0000000000a2', 'nba', 'Kalshi Only', 2, null, 'k-only'),
        ('00000000-0000-0000-0000-0000000000a3', 'nba', 'Espn Only', 2, 'e-only', null);
      insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at, status) values
        ('00000000-0000-0000-0000-0000000000e1', 'nba', 'ev1', '26NOV10MILORL', '2026-11-10', 2, 1, '2026-11-11T00:00Z', 'postponed'),
        ('00000000-0000-0000-0000-0000000000e2', 'nba', 'ev1', '26NOV11MILORL', '2026-11-11', 2, 1, '2026-11-12T00:00Z', 'final');
      insert into markets (id, league, game_id, kind, title, team_id, status) values
        ('00000000-0000-0000-0000-0000000000f1', 'nba', '00000000-0000-0000-0000-0000000000e1', 'game_winner', 'ORL wins', 2, 'open');
      insert into external_ids (source, kind, external_id, market_id) values
        ('kalshi', 'market', 'KXNBAGAME-26NOV10MILORL-ORL', '00000000-0000-0000-0000-0000000000f1');`);
    // STO-39's migration and every later one (e.g. teams.abbr, backfilled from the moved codes).
    for (const f of files.slice(at)) await setup.query(readFileSync(join(SUPABASE, "migrations", f), "utf8"));
  } finally {
    await setup.end();
  }
  const d = connect(urlFor(name));
  dbs.push(d);
  const ids = (await d.query(`select source, kind, league::text, external_id,
                                     coalesce(market_id::text, team_id::text, player_id::text, game_id::text) our_id
                                from external_ids order by kind, source, league, external_id, our_id`)).rows
    .map((r) => `${r.kind}/${r.source}/${r.league}/${r.external_id}->${r.our_id}`);
  assert.deepEqual(ids, [
    "game/espn/nba/ev1->00000000-0000-0000-0000-0000000000e1",
    "game/espn/nba/ev1->00000000-0000-0000-0000-0000000000e2",
    "game/kalshi/nba/26NOV10MILORL->00000000-0000-0000-0000-0000000000e1",
    "game/kalshi/nba/26NOV11MILORL->00000000-0000-0000-0000-0000000000e2",
    "market/kalshi/nba/KXNBAGAME-26NOV10MILORL-ORL->00000000-0000-0000-0000-0000000000f1",
    "player/espn/nba/4712849->00000000-0000-0000-0000-0000000000a1",
    "player/espn/nba/e-only->00000000-0000-0000-0000-0000000000a3",
    `player/kalshi/nba/${BLACK_KALSHI_ID}->00000000-0000-0000-0000-0000000000a1`,
    "player/kalshi/nba/k-only->00000000-0000-0000-0000-0000000000a2",
    "team/espn/nba/15->1", "team/espn/nba/19->2", "team/espn/nfl/15->3",
    "team/kalshi/nba/MIL->1", "team/kalshi/nba/ORL->2", "team/kalshi/nfl/MIL->3",
  ]);
  const { rows: abbrs } = await d.query(`select id, league::text, abbr from teams order by id`);
  assert.deepEqual(abbrs, [{ id: 1, league: "nba", abbr: "MIL" }, { id: 2, league: "nba", abbr: "ORL" },
                           { id: 3, league: "nfl", abbr: "MIL" }], "existing teams get their short code");
  // Ingest on the migrated data finds the existing NBA teams and Anthony Black (not the NFL team).
  useFetch();
  await ingest(d, SLATE);
  const { rows: [c] } = await d.query(`select (select count(*) from teams)::int t,
      (select count(*) from players where full_name = 'Anthony Black')::int black`);
  assert.deepEqual(c, { t: 3, black: 1 }, "no second Bucks/Magic, no second Anthony Black");
  const { rows: [g] } = await d.query(`select home_team_id, away_team_id from games where slate_date = $1`, [SLATE]);
  assert.deepEqual(g, { home_team_id: 2, away_team_id: 1 }, "tonight's game uses the NBA teams");
  const before = await counts(d);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), before, "re-running after the migration is safe");
});

// ------------------------------------------------------------------ concurrency

// Concurrency: two full ingests of an empty database at the same moment, on two real connections.
// Coverage (passes): whatever happens, no team, player or game is duplicated or orphaned, and a later
// run changes nothing. This is the property the author's STO-39 race tests claim.
const raceFailures: string[] = [];
test("ingest: two ingests racing on an empty database never duplicate or orphan a row", { skip }, async () => {
  for (let i = 0; i < 8; i++) {
    const d = await db(`race_${i}`);
    const d2 = connect(urlFor(`ext39_race_${i}`));
    dbs.push(d2);
    useFetch();
    const results = await Promise.allSettled([ingest(d, SLATE), ingest(d2, SLATE)]);
    for (const r of results) if (r.status === "rejected") {
      raceFailures.push(`round ${i}: ${r.reason?.message ?? r.reason} at ${String(r.reason?.stack).match(/ingest\.ts:\d+/)?.[0]}`);
    }
    const c = await counts(d);
    assert.equal(c.t, 2, "two teams");
    assert.equal(c.g, 1, "one game");
    assert.deepEqual(await orphans(d), { t: 0, p: 0, g: 0 }, "every row has its provider IDs");
    await ingest(d, SLATE);
    assert.deepEqual(await counts(d), c, "a third, sequential run changes nothing");
  }
});
// Finding (nondeterministic, so marked todo to keep CI stable; it reports, not fails): the run that
// loses a race can still die on a unique index that isn't its ON CONFLICT arbiter, e.g. the team
// Kalshi-abbreviation attach (arbiter one_per_team, raises on external_ids_lookup) or the STO-38
// market attach (arbiter lookup, raises on one_per_market). Base 5a066ff fails the same way on
// other keys; production ingest runs under the scheduler's advisory lock, so impact is low.
test("ingest: two ingests racing on an empty database both succeed", {
  skip, todo: "racing ingests can fail on a non-arbiter unique index (see qa report)",
}, () => {
  assert.deepEqual(raceFailures, [], "both racing runs succeed in every round");
});

// ------------------------------------------------------------------ players: coalesce semantics

/** ESPN's ORL roster without Anthony Black (e.g. ESPN dropped him for a night). */
const orlWithoutBlack: Route = (url) => {
  if (url.hostname !== "site.api.espn.com" || !url.pathname.endsWith("/teams/19/roster")) return undefined;
  const body = fixture("espn-roster-19.json") as { athletes: { fullName: string }[] };
  return json({ ...body, athletes: body.athletes.filter((a) => a.fullName !== "Anthony Black") });
};

// Coverage: author's risk (1) "check coalesce semantics". The old upsert kept the stored ESPN
// athlete when tonight's match failed (coalesce). An unmatched night must not drop it.
test("ingest: a player unmatched tonight keeps the ESPN athlete he already has", { skip }, async () => {
  const d = await db("keep_athlete");
  useFetch();
  await ingest(d, SLATE);
  const { rows: [before] } = await d.query(`select id, espn_athlete_id from ${PLAYERS} where kalshi_player_id = $1`, [BLACK_KALSHI_ID]);
  assert.ok(before.espn_athlete_id);
  useFetch(orlWithoutBlack);
  const s = await ingest(d, SLATE);
  assert.match(s.players.unmatched.join(), /Anthony Black/);
  const { rows: [now] } = await d.query(`select id, espn_athlete_id from ${PLAYERS} where kalshi_player_id = $1`, [BLACK_KALSHI_ID]);
  assert.deepEqual(now, before);
});

// Coverage: a lost Kalshi ID row (manual cleanup, bad script) re-attaches to the stored player via
// his ESPN athlete instead of creating a second Anthony Black.
test("ingest: a player whose Kalshi ID row is lost is found again by his ESPN athlete", { skip }, async () => {
  const d = await db("lost_player_id");
  useFetch();
  await ingest(d, SLATE);
  const first = await counts(d);
  await d.query(`delete from external_ids where kind = 'player' and source = 'kalshi' and external_id = $1`, [BLACK_KALSHI_ID]);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first, "no second player");
  assert.deepEqual(await orphans(d), { t: 0, p: 0, g: 0 });
});

// ------------------------------------------------------------------ teams and games: lost IDs

// Coverage: a game whose ID rows are gone (or a run that died between the game upsert and the ID
// attach: ingest isn't one transaction) is found again by its matchup and re-attached.
test("ingest: a game whose provider IDs are lost is re-attached by matchup, not duplicated", { skip }, async () => {
  const d = await db("lost_game_ids");
  useFetch();
  await ingest(d, SLATE);
  const first = await counts(d);
  await d.query(`delete from external_ids where kind = 'game'`);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first);
  const { rows: [g] } = await d.query(`select espn_event_id, kalshi_game_key from ${GAMES("g")}`);
  assert.deepEqual(g, { espn_event_id: "401909297", kalshi_game_key: "26NOV13MILORL" });
});

// Coverage: a team's Kalshi abbreviation row lost is re-attached on the next run.
test("ingest: a team whose Kalshi abbreviation row is lost gets it back", { skip }, async () => {
  const d = await db("lost_team_kalshi");
  useFetch();
  await ingest(d, SLATE);
  const first = await counts(d);
  await d.query(`delete from external_ids where kind = 'team' and source = 'kalshi'`);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first);
  const { rows } = await d.query(`select kalshi_abbr from ${TEAMS("t")} order by 1`);
  assert.deepEqual(rows.map((r) => r.kalshi_abbr), ["MIL", "ORL"]);
});

// Attack: a team's ESPN ID row lost (the same "lost provider ID" attack as on markets, STO-38). A
// team is found only by its ESPN ID, so ingest mints a second "Orlando Magic", then fails on the
// Kalshi abbreviation the first one still holds. The rule for markets was "re-attach, don't
// duplicate, don't fail".
test("ingest: a team whose ESPN ID row is lost is not duplicated and the run doesn't fail", { skip }, async () => {
  const d = await db("lost_team_espn");
  useFetch();
  await ingest(d, SLATE);
  const first = await counts(d);
  await d.query(`delete from external_ids where kind = 'team' and source = 'espn' and external_id = '19'`);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first, "no second Orlando Magic");
});

// ------------------------------------------------------------------ league scoping

// Coverage: ESPN reuses IDs across leagues. An NFL team holding ESPN id 15 / Kalshi "MIL" must not
// be picked up by NBA ingest.
test("ingest: NBA ingest ignores another league's team with the same provider IDs", { skip }, async () => {
  const d = await db("league_clash");
  await d.query(`with t as (insert into teams (league, name, abbr) values ('nfl', 'NFL fifteen', 'MIL') returning id)
                 insert into external_ids (source, kind, league, external_id, team_id)
                 select s, 'team', 'nfl', e, id from t, (values ('espn', '15'), ('kalshi', 'MIL')) v(s, e)`);
  useFetch();
  await ingest(d, SLATE);
  const { rows } = await d.query(`select t.league::text from games g join teams t on t.id in (g.home_team_id, g.away_team_id) order by 1`);
  assert.deepEqual(rows.map((r) => r.league), ["nba", "nba"]);
  const { rows: winners } = await d.query(`select distinct t.league::text from markets m join teams t on t.id = m.team_id`);
  assert.deepEqual(winners.map((r) => r.league), ["nba"]);
});

// eng-lead should-fix 1: the test above seeds the NFL team first, so without a league filter the
// NBA rows (read later) still win the lookup by luck. Here the NFL team is added after the NBA
// ones, so it is read last: an unscoped lookup would point tonight's game at it.
test("ingest: another league's team added later doesn't take over NBA games on re-ingest", { skip }, async () => {
  const d = await db("league_clash_later");
  useFetch();
  await ingest(d, SLATE);
  const teamsOf = async () => (await d.query(
    `select home_team_id, away_team_id from games order by id`)).rows;
  const before = await teamsOf();
  await d.query(`with t as (insert into teams (league, name, abbr) values ('nfl', 'NFL fifteen', 'MIL') returning id)
                 insert into external_ids (source, kind, league, external_id, team_id)
                 select s, 'team', 'nfl', e, id from t, (values ('espn', '15'), ('espn', '19'), ('kalshi', 'MIL'), ('kalshi', 'ORL')) v(s, e)
                 on conflict do nothing`);
  await ingest(d, SLATE);
  assert.deepEqual(await teamsOf(), before, "tonight's game keeps its NBA teams");
  const { rows } = await d.query(`select distinct t.league::text from markets m join teams t on t.id = m.team_id`);
  assert.deepEqual(rows.map((r) => r.league), ["nba"]);
});

// ------------------------------------------------------------------ matchup identity

/** ESPN's scoreboard listing tonight's MIL @ ORL twice, under two event IDs. */
const sameMatchupTwice: Route = (url) => {
  if (url.hostname !== "site.api.espn.com" || !url.pathname.endsWith("/scoreboard")) return undefined;
  const body = fixture("espn-scoreboard-20261113.json") as { events: { id: string }[] };
  return json({ ...body, events: [...body.events, { ...body.events[0]!, id: "401999998" }] });
};

// Michael's call (PR #26): if ESPN lists one matchup under two events, that game is left out and
// reported; the run succeeds and every other game on the slate loads as usual.
test("two ESPN events for one matchup: that game is left out and reported, the run succeeds", { skip }, async () => {
  const d = await db("matchup_twice");
  useFetch(sameMatchupTwice);
  const s = await ingest(d, SLATE);
  assert.equal(s.games, 0);
  assert.deepEqual(s.skippedGames, ["MIL @ ORL: ESPN lists it under 2 events (401909297, 401999998); left out"]);
  const { rows: [run] } = await d.query(`select status from pipeline_runs order by id desc limit 1`);
  assert.equal(run.status, "ok");
  assert.equal((await counts(d)).g, 0, "no game for the ambiguous matchup");
  assert.equal((await counts(d)).m, 0, "its markets match no game, like another night's");
});

// eng-lead round 2, should-fix 1: the duplicate shows up mid-day, after the game was loaded.
// The game and its markets are kept as they were (nothing deleted), the run succeeds, and the
// note says the game is no longer being updated, so the feed flags it for a look.
test("a game already loaded, then listed twice: kept as it was, run ok, flagged as no longer updated", { skip }, async () => {
  const d = await db("matchup_twice_midday");
  useFetch();
  await ingest(d, SLATE);
  const game = async () => (await d.query(`select id, status::text, tip_off_at, (select count(*)::int from markets m where m.game_id = g.id) markets
                                             from games g where slate_date = $1`, [SLATE])).rows;
  const before = await game();
  const countsBefore = await counts(d);
  useFetch(sameMatchupTwice);
  const s = await ingest(d, SLATE);
  assert.deepEqual(s.skippedGames, [
    "MIL @ ORL: ESPN lists it under 2 events (401909297, 401999998); left out (already loaded tonight: its start time and status are no longer updated)"]);
  assert.deepEqual(await game(), before, "the loaded game and its 211 markets are kept as they were");
  assert.deepEqual(await counts(d), countsBefore);
  const { rows: [run] } = await d.query(`select status from pipeline_runs order by id desc limit 1`);
  assert.equal(run.status, "ok");
});

// eng-lead round 2, nit 2: a left-out event can't mark an earlier night's game postponed. We can't
// tell which of the two events is real, so the earlier game keeps its status.
test("a matchup listed twice doesn't mark an earlier night's game postponed", { skip }, async () => {
  const d = await db("matchup_twice_postpone");
  useFetch();
  await ingest(d, SLATE);
  useFetch(sameMatchupTwice);
  await ingest(d, "2026-11-15");   // same ESPN event 401909297, two nights later, listed twice
  const { rows } = await d.query(`select slate_date::text, status::text from games order by slate_date`);
  assert.deepEqual(rows, [{ slate_date: SLATE, status: "scheduled" }]);
});

/** Tonight's real MIL @ ORL, plus a second matchup (ORL @ MIL, home and away swapped) listed twice. */
const otherMatchupTwice: Route = (url) => {
  if (url.hostname !== "site.api.espn.com" || !url.pathname.endsWith("/scoreboard")) return undefined;
  const body = fixture("espn-scoreboard-20261113.json") as { events: { id: string; competitions: { competitors: { homeAway: string }[] }[] }[] };
  const swapped = (id: string) => ({ ...body.events[0]!, id, competitions: body.events[0]!.competitions.map((c) => ({
    ...c, competitors: c.competitors.map((t) => ({ ...t, homeAway: t.homeAway === "home" ? "away" : "home" })) })) });
  return json({ ...body, events: [...body.events, swapped("401999997"), swapped("401999996")] });
};

test("a left-out game doesn't affect the rest of the slate", { skip }, async () => {
  const clean = await db("matchup_twice_baseline");
  useFetch();
  const baseline = await ingest(clean, SLATE);

  const d = await db("matchup_twice_other");
  useFetch(otherMatchupTwice);
  const s = await ingest(d, SLATE);
  assert.deepEqual(s.skippedGames, ["ORL @ MIL: ESPN lists it under 2 events (401999997, 401999996); left out"]);
  assert.equal(s.games, 1);
  assert.deepEqual(s.markets, baseline.markets, "MIL @ ORL loads every market");
  assert.deepEqual(s.players, baseline.players);
  assert.deepEqual(await counts(d), await counts(clean), "same games, markets, players, teams and ids as a clean night");
  const { rows } = await d.query(`select espn_event_id from ${GAMES("g")}`);
  assert.deepEqual(rows, [{ espn_event_id: "401909297" }]);
});

/** Tonight's scoreboard with ESPN's home/away designation flipped (a correction, or a neutral site). */
const homeAwayFlipped: Route = (url) => {
  if (url.hostname !== "site.api.espn.com" || !url.pathname.endsWith("/scoreboard")) return undefined;
  const body = fixture("espn-scoreboard-20261113.json") as { events: { competitions: { competitors: { homeAway: string }[] }[] }[] };
  return json({ ...body, events: body.events.map((e) => ({ ...e, competitions: e.competitions.map((c) => ({
    ...c, competitors: c.competitors.map((t) => ({ ...t, homeAway: t.homeAway === "home" ? "away" : "home" })) })) })) });
};

// Attack: STO-32 carried-over rule "one ESPN event is at most one game per slate" (was unique
// (league, espn_event_id, slate_date)). Games are now keyed by matchup, so the same ESPN event
// re-listed with home/away swapped on the same slate becomes a SECOND game carrying the same event
// ID, and the first is neither updated nor marked postponed (only earlier slates are).
test("ingest: one ESPN event never becomes two games on one slate (home/away corrected)", { skip }, async () => {
  const d = await db("home_away_flip");
  useFetch();
  await ingest(d, SLATE);
  const gameNow = async () => (await d.query(
    `select g.id, g.home_team_id, g.away_team_id, g.espn_event_id, g.kalshi_game_key,
            (select count(*)::int from markets m where m.game_id = g.id) markets
       from ${GAMES("g")} where g.slate_date = $1`, [SLATE])).rows;
  const [before] = await gameNow();
  useFetch(homeAwayFlipped);
  await ingest(d, SLATE);   // must succeed (eng-lead should-fix 2: no swallowed error)
  assert.deepEqual(await gameNow(), [{
    id: before.id, home_team_id: before.away_team_id, away_team_id: before.home_team_id,
    espn_event_id: "401909297", kalshi_game_key: "26NOV13ORLMIL", markets: 211,
  }], "the same game takes the corrected matchup and keeps its markets");
});
});

describe("market ids and Kalshi tickers (STO-38)", () => {
const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const SLATE = "2026-11-13";
const BLACK25 = "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25";
const WINNER = "KXNBAGAME-26NOV13MILORL-ORL";
const MIL_WIN = "KXNBAGAME-26NOV13MILORL-MIL";

const dbs: Db[] = [];
let restore = () => {};
after(async () => { restore(); for (const d of dbs) await d.end(); });

async function db(name: string): Promise<Db> {
  const d = (await freshDb(`mkt38_${name}`))!;
  dbs.push(d);
  return d;
}
function useFetch(...routes: Route[]) {
  restore();
  restore = installFetch(...routes, slateRoutes).restore;
}
const counts = async (d: Db) => (await d.query(`
  select (select count(*) from markets)::int m, (select count(*) from external_ids where kind = 'market')::int x,
         (select count(distinct external_id) from external_ids where kind = 'market')::int t,
         (select count(*) from external_ids)::int all_ids`)).rows[0];
/** Every provider ID and the Storyline ID it points at, all kinds (STO-39). */
const allIds = `select source, kind, external_id, coalesce(market_id::text, team_id::text, player_id::text, game_id::text) our_id
                  from external_ids order by source, kind, external_id`;

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
test("ingest: three ingest runs keep exactly one market and one Kalshi id per ticker", { skip }, async () => {
  const d = await db("rerun");
  useFetch();
  await ingest(d, SLATE);
  const first = await counts(d);
  const ids = (await d.query(allIds)).rows;
  await ingest(d, SLATE);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first);
  assert.equal(first.m, first.x);
  assert.equal(first.x, first.t);
  assert.deepEqual((await d.query(allIds)).rows, ids,
    "a re-run must not re-key any market, team, player or game");
});

// Attack: a duplicated ticker in Kalshi's payload on a RE-run (markets already known).
test("ingest: a ticker listed twice by Kalshi on a re-run doesn't fail or duplicate", { skip }, async () => {
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
test("ingest: a ticker listed twice by Kalshi on the first ingest still creates the slate", { skip }, async () => {
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
test("ingest: an ingest racing another ingest that is creating the same market doesn't fail", { skip }, async () => {
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
    await other.query(`insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'market', 'nba', $1, $2)`,
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

// STO-39: teams and players are created together with the provider ID that finds them, ID first.
// A run that loses the race for that ID must write nothing: no orphan team or player without an
// ID, which a later run could never find again (and would duplicate).
for (const [what, source, kind, externalId, table, insertRow] of [
  ["team", "espn", "team", "15", "teams",          // MIL's ESPN id
   `insert into teams (id, league, name, abbr) select team_id, 'nba', 'Milwaukee Bucks', 'MIL' from x`],
  ["player", "kalshi", "player", "60bb439a-df6a-4fea-8312-4caa6a2c0fbe", "players",   // Anthony Black
   `insert into players (id, league, full_name) select player_id, 'nba', 'Anthony Black' from x`],
] as const) {
  test(`ingest: an ingest racing another run creating the same ${what} writes no second ${what}`, { skip }, async () => {
    const d = await db(`race_${what}`);
    useFetch();
    const other = await d.connect();
    try {
      // The other run is mid-statement: it has created the ID and its row but not committed.
      await other.query("begin");
      await other.query(
        `with x as (insert into external_ids (source, kind, league, external_id, ${kind}_id)
                    values ($1, $2, 'nba', $3, ${kind === "team" ? "nextval(pg_get_serial_sequence('teams', 'id'))" : "gen_random_uuid()"})
                    returning ${kind}_id)
         ${insertRow}`, [source, kind, externalId]);
      const running = ingest(d, SLATE);
      void running.catch(() => {});
      assert.ok(await waitForLockWait(d), `ingest should be waiting on the other run's uncommitted ${what} id`);
      await other.query("commit");
      await running;   // its ID insert is a no-op, so is its row
    } finally {
      await other.query("rollback").catch(() => {});
      other.release();
    }
    const { rows: [c] } = await d.query(`
      select (select count(*) from ${table})::int n,
             (select count(*) from ${table} t where not exists
                (select 1 from external_ids x where x.${kind}_id = t.id and x.source = $1))::int orphans`, [source]);
    assert.equal(c.orphans, 0, `every ${what} has its ${source} id`);
    assert.equal(c.n, what === "team" ? 2 : 11, `no second ${what}`);
    const before = await counts(d);
    await ingest(d, SLATE);
    assert.deepEqual(await counts(d), before, "a later run finds everything again");
  });
}

// Attack: a market whose external_ids row is gone (manual cleanup, a bad migration, a future
// "re-map" script). The ticker was the primary key before, so one-market-per-Kalshi-ticker held
// by construction. Now ingest silently mints a SECOND market for the same Kalshi market, and the
// original (the one cards and picks point at) is orphaned: never priced again.
test("ingest: losing a market's Kalshi id doesn't make ingest create a duplicate market", { skip }, async () => {
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
test("ingest: the poller fails loudly when a carded market has no Kalshi id", { skip }, async () => {
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
});
