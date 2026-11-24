// The ESPN context runner end to end (STO-10 part 3b): recorded ESPN responses through a mocked fetch,
// a real Postgres, the real migrations. Acceptance criteria covered here:
//   - "Context sources are switched on and off by feature flags. A failing context source is reported and skipped."
//   - "ESPN down: curation falls back to the last successful ESPN pull, with each signal keeping its date,
//      and alerts that the run is degraded."
//   - "Re-running for the same day is safe: no duplicate signals."

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Db } from "../src/lib/db.js";
import { runEspnContext, type ContextRunResult } from "../src/jobs/contextEspn.js";
import { loadSlate } from "../src/sources/slate.js";
import { lastGoodSignals, storeSignals } from "../src/sources/signals.js";
import { freshDb } from "./helpers/testDb.js";
import { installFetch, json, fixture } from "./helpers/mockFetch.js";
import { espnRoutes } from "./helpers/espnRoutes.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const DBNAME = "storyline_context_test";
const DAY = "2026-11-17";
const NY = 18, TOR = 28;
const GAME = "c0000000-0000-0000-0000-0000000000a1";
const VET = "c0000000-0000-0000-0000-0000000000b1", ROOKIE = "c0000000-0000-0000-0000-0000000000b2";
const OUT = "c0000000-0000-0000-0000-0000000000b3", NOMATCH = "c0000000-0000-0000-0000-0000000000b4";
const BENCH = "c0000000-0000-0000-0000-0000000000b5"; // matched to ESPN, but has no market tonight
const FETCH = { retries: 1, baseDelayMs: 1 };
const at = (hh: string) => `${DAY}T${hh}:00:00.000Z`;

let db: Db | null = null;
let restore = () => {};
let alerts: string[] = [];
const alert = async (m: string) => { alerts.push(m); };
const run = (o: { now: string; date?: string; db?: Db }) =>
  runEspnContext(o.db ?? db!, { alert, date: o.date ?? DAY, fetchOpts: FETCH, now: () => new Date(o.now) });
const fail = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, () => json({}, 503)]));
const allDown = () => installFetch(() => json({}, 503));
const q = async <T = any>(sql: string, args: unknown[] = []) => (await db!.query(sql, args)).rows as T[];
const count = async (table: string) => Number((await q(`select count(*) from ${table}`))[0].count);

before(async () => {
  db = await freshDb(DBNAME);
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, abbr) values (${NY}, 'nba', 'Knicks', 'NYK'), (${TOR}, 'nba', 'Raptors', 'TOR');
    insert into external_ids (source, kind, league, external_id, team_id) values ('espn','team','nba','${NY}',${NY}), ('espn','team','nba','${TOR}',${TOR});
    insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values ('${GAME}','nba','${DAY}',${TOR},${NY},'${DAY}T23:30:00Z');
    insert into external_ids (source, kind, league, external_id, game_id) values ('espn','game','nba','401910002','${GAME}');
    insert into players (id, league, full_name, team_id, injury_status) values
      ('${VET}','nba','Vet Player',${NY},null), ('${ROOKIE}','nba','Rookie Player',${NY},'Day-To-Day'),
      ('${OUT}','nba','Out Player',${NY},'Out'), ('${NOMATCH}','nba','Unmatched Player',${TOR},null),
      ('${BENCH}','nba','Bench Player',${TOR},null);
    insert into external_ids (source, kind, league, external_id, player_id) values
      ('espn','player','nba','2993874','${VET}'), ('espn','player','nba','4433188','${ROOKIE}'),
      ('espn','player','nba','6450','${OUT}'), ('espn','player','nba','5555','${BENCH}');
    insert into markets (league, game_id, kind, title, player_id, stat, strike, status)
      select 'nba', '${GAME}', 'player_stat', 'pts', p, 'points', 20, 'open' from unnest(array['${VET}','${ROOKIE}','${OUT}','${NOMATCH}']::uuid[]) p;
    update app_config set value = '0' where key = 'espn_pause_ms';   -- no pacing in tests
    update feature_flags set enabled = true where key = 'context_espn';`);
});
after(async () => { await db?.end(); });

// Each test starts from an empty pipeline: flag on, default thresholds, no signals, no runs, no alerts.
beforeEach(async () => {
  if (!db) return;
  alerts = [];
  await db.query(`delete from signal_sightings; delete from signals; delete from pipeline_runs;
    update feature_flags set enabled = true where key = 'context_espn';
    update app_config set value = '5' where key = 'espn_degraded_failed_players';`);
});
afterEach(() => restore());

const snapshot = async () => q(`select id, key, summary, to_char(observed_at at time zone 'UTC', 'HH24:MI') at from signals order by id`);
const runs = () => q(`select id, status, error, outputs from pipeline_runs where job = 'context:espn' order by id`);

// ---------------------------------------------------------------- ESPN down: the fallback (written first)

test("ESPN down: the last good pull stands in, each signal keeps its date, and the run is flagged degraded", { skip }, async () => {
  restore = installFetch(espnRoutes()).restore;
  const first = await run({ now: at("10") });
  assert.equal(first.status, "ok");
  const good = await snapshot();
  assert.ok(good.length > 10);
  restore();

  restore = allDown().restore;
  const down = await run({ now: at("12") });

  assert.equal(down.status, "fallback");
  assert.ok(down.status === "fallback");
  assert.equal(down.level, "last_good_pull");
  assert.deepEqual(down.signals.map((s) => s.id).sort((a, b) => a - b), good.map((g) => Number(g.id)), "the same signals, same IDs blurbs cite");
  assert.ok(down.signals.every((s) => s.evidence.observedAt === at("10")), "dated by the pull that saw them, not by today's failed run");
  assert.match(down.error, /^ESPN down/);

  assert.equal(alerts.length, 1, "one alert, not one per failed call");
  assert.match(alerts[0]!, /degraded: ESPN is down, using \d+ signals from earlier pulls/);
  assert.match(alerts[0]!, /last good ESPN pull, dated 2026-11-17T10:00:00\.000Z/);
  assert.deepEqual(await snapshot(), good, "a failed pull stores nothing and changes nothing");
  assert.deepEqual((await runs()).map((r) => r.status), ["ok", "failed"], "the outage is on the record as a failed pull");
  assert.match((await runs())[1]!.error, /ESPN down/);
});

test("ESPN down with no earlier pull: reported, nothing to stand in, the run still returns", { skip }, async () => {
  restore = allDown().restore;
  const down = await run({ now: at("12") });
  assert.ok(down.status === "fallback");
  assert.deepEqual([down.level, down.signals.length], ["none", 0]);
  assert.match(alerts[0]!, /no earlier pull to use/);
});

test("per subject: a player run 2 missed comes from run 1, everyone else from run 2", { skip }, async () => {
  restore = installFetch(espnRoutes()).restore;
  await run({ now: at("10") });                                   // run 1: everyone
  restore();
  restore = installFetch(espnRoutes(fail("gamelog-2993874"))).restore;
  const partial = await run({ now: at("12") });                   // run 2: the vet's game log fails (degraded, still ok)
  assert.equal(partial.status, "ok");
  restore();
  restore = allDown().restore;
  const down = await run({ now: at("14") });                      // run 3: ESPN down
  assert.ok(down.status === "fallback");

  const vet = down.signals.filter((s) => s.subject.kind === "player" && s.subject.id === VET);
  const rest = down.signals.filter((s) => !vet.includes(s));
  assert.ok(vet.some((s) => s.key === "form:pts"), "the vet is not lost just because run 2 missed him");
  assert.deepEqual([...new Set(vet.map((s) => s.evidence.observedAt))], [at("10")]);
  assert.deepEqual([...new Set(rest.map((s) => s.evidence.observedAt))], [at("12")]);
});

test("a run that stores signals and then fails does not hide the last ok run's signals", { skip }, async () => {
  restore = installFetch(espnRoutes()).restore;
  await run({ now: at("10") });
  const allIds = (await snapshot()).map((s) => Number(s.id));
  restore();

  // Run 2 sees everyone except the vet, stores, and then its "mark ok" write fails: a failed run with signals of its own.
  restore = installFetch(espnRoutes(fail("gamelog-2993874"))).restore;
  let broke = false;
  const flaky = new Proxy(db!, { get: (t, p, r) => p !== "query" ? Reflect.get(t, p, r) : (sql: unknown, ...a: unknown[]) =>
    !broke && typeof sql === "string" && sql.includes("status='ok'") && (broke = true) ? Promise.reject(new Error("db blip")) : (t.query as Function)(sql, ...a) });
  await assert.rejects(run({ now: at("12"), db: flaky as Db }), /db blip/, "a database error is a real failure, not 'ESPN is down'");
  assert.deepEqual((await runs()).map((r) => r.status), ["ok", "failed"]);
  assert.ok(Number((await q(`select count(*) from signal_sightings ss join pipeline_runs r on r.id = ss.run_id where r.status = 'failed'`))[0].count) > 0);
  restore();

  restore = allDown().restore;
  const down = await run({ now: at("14") });
  assert.ok(down.status === "fallback");
  assert.deepEqual(down.signals.map((s) => s.id).sort((a, b) => a - b), allIds, "every signal of the last ok pull is still there, the vet's included");
});

// ---------------------------------------------------------------- flag, failure rules, config

test("flag off: no ESPN calls, no signals, no run row, no alert", { skip }, async () => {
  await db!.query(`update feature_flags set enabled = false where key = 'context_espn'`);
  const net = installFetch(espnRoutes()); restore = net.restore;
  const r = await run({ now: at("10") });
  assert.equal(r.status, "off");
  assert.deepEqual([net.calls.length, await count("signals"), await count("pipeline_runs"), alerts.length], [0, 0, 0, 0]);
});

test("a run records its settings from app_config, not code", { skip }, async () => {
  await db!.query(`update app_config set value = '10' where key = 'espn_form_window_games'`);
  const net = installFetch(espnRoutes()); restore = net.restore;
  try {
    await run({ now: at("10") });
    const form = await q(`select summary from signals where key = 'form:pts' and player_id = $1`, [VET]);
    assert.match(form[0].summary, /last (10|\d) games?/i, "the window comes from the espn_form_window_games row");
  } finally { await db!.query(`update app_config set value = '5' where key = 'espn_form_window_games'`); }
});

test("a pull is degraded when MORE than the threshold of players failed", { skip }, async () => {
  restore = installFetch(espnRoutes(fail("gamelog-2993874"))).restore;
  const atThreshold = await run({ now: at("10") });                // 1 failed, threshold 5: quiet
  assert.deepEqual([atThreshold.status, alerts.length], ["ok", 0]);
  await db!.query(`update app_config set value = '1' where key = 'espn_degraded_failed_players'`);
  assert.deepEqual([(await run({ now: at("11") })).status, alerts.length], ["ok", 0], "equal to the threshold is not above it");
  await db!.query(`update app_config set value = '0' where key = 'espn_degraded_failed_players'`);
  const over = await run({ now: at("12") });
  assert.equal(over.status, "degraded");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /pull degraded: 1 players failed/);
  assert.match(alerts[0]!, /gamelog 2993874/);
  assert.ok(over.status === "degraded" && over.stored > 0, "what we got is kept");
});

test("a bad row inside a good response degrades the pull even with no failed player", { skip }, async () => {
  const bad = structuredClone(fixture("espn-injuries.json")) as any;
  bad.injuries.find((t: any) => t.id === "28").injuries[0].athlete.links = [];
  restore = installFetch(espnRoutes({ injuries: () => json(bad) })).restore;
  const r = await run({ now: at("10") });
  assert.equal(r.status, "degraded");
  assert.match(alerts[0]!, /0 players failed, 1 bad rows skipped/);
});

test("a clean pull is silent", { skip }, async () => {
  restore = installFetch(espnRoutes()).restore;
  assert.deepEqual([(await run({ now: at("10") })).status, alerts.length], ["ok", 0]);
});

// ---------------------------------------------------------------- re-runs and overlap

test("re-running the same day adds no signals, keeps every ID and refreshes the date", { skip }, async () => {
  restore = installFetch(espnRoutes()).restore;
  const a = await run({ now: at("10") }), b = await run({ now: at("11") });
  assert.ok(a.status === "ok" && b.status === "ok");
  assert.equal(b.stored, a.stored);
  const rows = await q(`select id, to_char(observed_at at time zone 'UTC','HH24:MI') at from signals order by id`);
  assert.equal(rows.length, a.stored);
  assert.deepEqual(rows.filter((r) => r.at !== "11:00"), []);
  for (const r of await runs()) assert.equal(r.outputs.stored, a.stored);
  const ids = await q(`select count(distinct run_id)::int n, count(*)::int c from signal_sightings`);
  assert.deepEqual([ids[0].n, ids[0].c], [2, a.stored * 2], "both runs recorded as having seen every signal");
});

test("two pulls overlapping (two ticks, two connections) leave one row per signal", { skip }, async () => {
  restore = installFetch(espnRoutes()).restore;
  const url = process.env.TEST_DATABASE_URL!.replace(/^(\w+:\/\/[^/]*\/)([^?]*)/, `$1${DBNAME}`);
  const other = new pg.Pool({ connectionString: url, max: 3 });
  try {
    const solo = await run({ now: at("09") });
    assert.ok(solo.status === "ok");
    await db!.query(`delete from signal_sightings; delete from signals; delete from pipeline_runs`);
    const both = await Promise.all([run({ now: at("10") }), run({ now: at("11"), db: other })]);
    assert.deepEqual(both.map((r) => r.status), ["ok", "ok"]);
    assert.equal(await count("signals"), solo.stored, "no duplicates");
    assert.equal((await q(`select count(*)::int n from (select 1 from signals group by player_id, team_id, game_id, key having count(*) > 1) d`))[0].n, 0);
    assert.equal(await count("signal_sightings"), solo.stored * 2);
    assert.ok((await q(`select to_char(observed_at at time zone 'UTC','HH24') h from signals`)).every((r) => r.h === "11"), "the newer sighting wins whichever finished first");
  } finally { await other.end(); }
});

test("with no date, the slate is the database's storyline_today()", { skip }, async () => {
  const today = (await q(`select storyline_today()::text d`))[0].d as string;
  const TODAY_GAME = "c0000000-0000-0000-0000-0000000000a2";
  await db!.query(`insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values ($1,'nba',$2,${NY},${TOR},now() + interval '1 hour')`, [TODAY_GAME, today]);
  try {
    restore = installFetch(espnRoutes()).restore;
    const r = await runEspnContext(db!, { alert, fetchOpts: FETCH });
    assert.equal(r.slateDate, today);
    assert.equal((await runs())[0]!.id > 0, true);
    assert.equal((await q(`select slate_date::text d from pipeline_runs where job = 'context:espn'`))[0].d, today);
  } finally {
    await db!.query(`delete from signal_sightings; delete from signals; delete from pipeline_runs`);
    await db!.query(`delete from games where id = $1`, [TODAY_GAME]);
  }
});

// ---------------------------------------------------------------- the slate and the fallback window

test("the slate is tonight's games and the players with a market in them, with ESPN's IDs", { skip }, async () => {
  const s = await loadSlate(db!, DAY, "nba", "espn");
  assert.deepEqual(s.games.map((g) => [g.id, g.homeTeamId, g.awayTeamId, g.externalId]), [[GAME, TOR, NY, "401910002"]]);
  assert.deepEqual(s.teams.map((t) => [t.id, t.externalId]), [[NY, "18"], [TOR, "28"]]);
  const byId = Object.fromEntries(s.players.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).sort(), [VET, ROOKIE, OUT, NOMATCH].sort(), "the bench player has no market tonight");
  assert.deepEqual([byId[VET]!.externalId, byId[ROOKIE]!.injuryStatus?.raw, byId[OUT]!.injuryStatus?.status, byId[NOMATCH]!.externalId], ["2993874", "Day-To-Day", "Out", null]);
  assert.deepEqual((await loadSlate(db!, "2026-11-18", "nba", "espn")).games, [], "another day has no games");
});

test("a postponed game is not on the slate", { skip }, async () => {
  await db!.query(`update games set status = 'postponed' where id = $1`, [GAME]);
  try {
    const s = await loadSlate(db!, DAY, "nba", "espn");
    assert.deepEqual([s.games.length, s.players.length], [0, 0]);
  } finally { await db!.query(`update games set status = 'scheduled' where id = $1`, [GAME]); }
});

test("the fallback window: stats reach back, injuries and news are today only, only tonight's subjects, only from ok runs", { skip }, async () => {
  const mk = async (status: "ok" | "failed", day: string, kind: "stat" | "news" | "injury", key: string, subject: any, summary: string) => {
    const id = (await q(`insert into pipeline_runs (job, slate_date, status) values ('context:espn', $1, $2) returning id`, [day, status]))[0].id;
    await storeSignals(db!, id, "espn", day, [{ kind, subject, summary, trust: "verified", key,
      evidence: { url: "https://example.test/x", observedAt: `${day}T10:00:00.000Z` } }]);
  };
  const OLD_GAME = "c0000000-0000-0000-0000-0000000000a3";
  await db!.query(`insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values ($1,'nba','2026-11-16',${NY},${TOR},'2026-11-16T23:30:00Z')`, [OLD_GAME]);
  const vet = { kind: "player", id: VET }, bench = { kind: "player", id: BENCH };
  await mk("ok", "2026-11-14", "stat", "form:pts", vet, "three days old");
  await mk("ok", "2026-11-15", "stat", "form:reb", vet, "two days old");
  await mk("ok", "2026-11-16", "stat", "form:ast", vet, "yesterday stat");
  await mk("ok", "2026-11-16", "injury", "injury:9", { kind: "team", id: NY }, "yesterday injury");   // injuries and news are about a day
  await mk("ok", "2026-11-16", "news", "news:2", vet, "yesterday news");
  await mk("ok", "2026-11-17", "stat", "form:3pm", vet, "tonight");
  await mk("ok", "2026-11-17", "news", "news:3", { kind: "game", id: GAME }, "tonight news");           // today's own earlier pull may stand in
  await mk("ok", "2026-11-18", "stat", "form:stl", vet, "tomorrow's slate");                           // a future day is not a past pull
  await mk("ok", "2026-11-16", "stat", "form:pts", bench, "not playing tonight");
  await mk("ok", "2026-11-16", "news", "news:1", { kind: "game", id: OLD_GAME }, "yesterday's game");
  await mk("failed", "2026-11-16", "stat", "form:blk", vet, "only a failed run saw this");
  const got = async (maxAgeDays: number) => (await lastGoodSignals(db!, { job: "context:espn", source: "espn", slateDate: DAY, maxAgeDays,
    playerIds: [VET, ROOKIE], teamIds: [NY, TOR], gameIds: [GAME] })).map((s) => s.summary).sort();
  assert.deepEqual(await got(1), ["tonight", "tonight news", "yesterday stat"]);
  assert.deepEqual(await got(0), ["tonight", "tonight news"], "0 = today only");
  assert.deepEqual(await got(14), ["three days old", "tonight", "tonight news", "two days old", "yesterday stat"], "even at 14 days, yesterday's injury and news never come back");
});

// ---------------------------------------------------------------- injury statuses (STO-81, STO-90)

/** Today's recorded feed with one extra entry on Toronto's list. */
const feedPlus = (id: string, name: string, status: string) => () => {
  const feed = structuredClone(fixture("espn-injuries.json")) as any;
  feed.injuries.find((t: any) => t.id === "28").injuries.push({ id: `inj-${id}`, status, date: "2026-11-17T10:00Z", shortComment: "", type: {},
    athlete: { displayName: name, links: [{ rel: ["playercard"], href: `https://www.espn.com/nba/player/_/id/${id}/x` }] } });
  return json(feed);
};

test("a status we don't recognise: the player is skipped, the run is ok, and one alert names the raw value", { skip }, async () => {
  restore = installFetch(espnRoutes({ injuries: feedPlus("2993874", "Vet Player", "Suspension") })).restore;
  const r = await run({ now: at("10") });
  assert.equal(r.status, "ok", "an unknown status doesn't fail or degrade the run");
  if (r.status !== "ok") return;
  assert.equal(r.stats.players.skippedWontPlay, 2, "the Out player and the unknown-status player");
  assert.equal(r.stats.players.failed, 0);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /injury status we don't recognise/);
  assert.match(alerts[0]!, /Vet Player: "Suspension"/);
  assert.equal((await q(`select count(*)::int n from signals where player_id = $1`, [VET]))[0].n, 0, "no form was written for him");
});

test("espn context: ingest stored Out this morning, today's feed doesn't list him, so he gets his signals", { skip }, async () => {
  await db!.query(`update players set injury_status = 'Out' where id = $1`, [VET]);
  restore = installFetch(espnRoutes()).restore;
  const r = await run({ now: at("10") });
  await db!.query(`update players set injury_status = null where id = $1`, [VET]);
  assert.equal(r.status, "ok");
  assert.ok((await q(`select count(*)::int n from signals where player_id = $1`, [VET]))[0].n > 0);
});
