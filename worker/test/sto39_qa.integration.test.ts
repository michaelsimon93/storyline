// qa (STO-39): attacks on provider IDs moving from teams/players/games to external_ids.
// Real Postgres, recorded fixtures with targeted edits, mocked fetch.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { ingest } from "../src/jobs/ingest.js";
import { connect, type Db } from "../src/lib/db.js";
import { freshDb, migrationFiles } from "./helpers/testDb.js";
import { fixture, installFetch, json, slateRoutes, type Route } from "./helpers/mockFetch.js";
import { GAMES, PLAYERS, TEAMS } from "./helpers/externalIds.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const SLATE = "2026-11-13";
const BLACK_KALSHI_ID = "60bb439a-df6a-4fea-8312-4caa6a2c0fbe";
const SUPABASE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase");
const STO39 = "20261116200000_cross_reference_ids.sql";

const dbs: Db[] = [];
let restore = () => {};
after(async () => { restore(); for (const d of dbs) await d.end(); });

async function db(name: string): Promise<Db> {
  const d = (await freshDb(`qa39_${name}`))!;
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
test("qa39: the migration moves every existing provider ID, and ingest afterwards creates no duplicates", { skip }, async () => {
  const name = "qa39_migrate";
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
test("qa39: two ingests racing on an empty database never duplicate or orphan a row", { skip }, async () => {
  for (let i = 0; i < 8; i++) {
    const d = await db(`race_${i}`);
    const d2 = connect(urlFor(`qa39_race_${i}`));
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
test("qa39: two ingests racing on an empty database both succeed", {
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
test("qa39: a player unmatched tonight keeps the ESPN athlete he already has", { skip }, async () => {
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
test("qa39: a player whose Kalshi ID row is lost is found again by his ESPN athlete", { skip }, async () => {
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
test("qa39: a game whose provider IDs are lost is re-attached by matchup, not duplicated", { skip }, async () => {
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
test("qa39: a team whose Kalshi abbreviation row is lost gets it back", { skip }, async () => {
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

// Attack: a team's ESPN ID row lost (the same "lost provider ID" attack adv38 ran on markets). A
// team is found only by its ESPN ID, so ingest mints a second "Orlando Magic", then fails on the
// Kalshi abbreviation the first one still holds. The adv38 rule for markets was "re-attach, don't
// duplicate, don't fail".
test("qa39: a team whose ESPN ID row is lost is not duplicated and the run doesn't fail", { skip }, async () => {
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
test("qa39: NBA ingest ignores another league's team with the same provider IDs", { skip }, async () => {
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
test("qa39: another league's team added later doesn't take over NBA games on re-ingest", { skip }, async () => {
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
test("qa39: one ESPN event never becomes two games on one slate (home/away corrected)", { skip }, async () => {
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
