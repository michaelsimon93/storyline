// The story step end to end (STO-76, STO-102, STO-103, STO-107): ESPN responses through a mocked fetch, a real Postgres,
// the real migrations. Written to prove:
//   STO-102  a player who is Out tonight never reaches the shortlist, even with the best hot streak of the day
//   STO-103  the shortlist holds a quota per angle, so a low-scoring angle still has its place; fills go by score
//   STO-107  a missing story setting fails only this job's run, with an alert naming the keys; other jobs still run
//   STO-76   stored for the run with its signals; re-running a day is safe; ESPN down keeps the old list
// Requires TEST_DATABASE_URL (skipped otherwise). Runs in CI.

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { runStories } from "../src/jobs/stories.js";
import { storyJob } from "../src/jobs/index.js";
import { runJob } from "../src/scheduler.js";
import { loadConfig } from "../src/lib/config.js";
import { storeSignals } from "../src/sources/signals.js";
import { parseGameLog } from "../src/domain/espnParse.js";
import { playerSignals, teamInjurySignals } from "../src/domain/espnSignals.js";
import { freshDb } from "./helpers/testDb.js";
import { installFetch, json } from "./helpers/mockFetch.js";
import { P, STAR, NY, TOR, DAY, GAME, LOGS, HURT_TODAY, storyRoutes } from "./helpers/storyWorld.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const FETCH = { retries: 0, baseDelayMs: 1 };
const OBSERVED = `${DAY}T10:00:00.000Z`;

let db: Db | null = null;
let restore = () => {};
let alerts: string[] = [];
const alert = async (m: string) => { alerts.push(m); };
const run = () => runStories(db!, { alert, date: DAY, fetchOpts: FETCH });
const q = async <T = any>(sql: string, args: unknown[] = []) => (await db!.query(sql, args)).rows as T[];
const list = () => q(`select p.full_name as player, s.angle, s.stat, s.score, s.slot_kind, s.position, s.league, s.team_id, s.market_id
                        from story_shortlist s join players p on p.id = s.player_id order by s.position`);

const setConfig = (k: string, v: number) => db!.query(`update app_config set value = $2::jsonb where key = $1`, [k, String(v)]);
const DEFAULTS: Record<string, number> = { shortlist_size: 50, shortlist_split_hot_streak: 1, shortlist_split_back_from_injury: 1, shortlist_split_backup_steps_in: 1 };

before(async () => {
  db = await freshDb("storyline_stories_test");
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, abbr) values (${NY}, 'nba', 'Knicks', 'NYK'), (${TOR}, 'nba', 'Raptors', 'TOR');
    insert into external_ids (source, kind, league, external_id, team_id) values ('espn','team','nba','${NY}',${NY}), ('espn','team','nba','${TOR}',${TOR});
    insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values ('${GAME}','nba','${DAY}',${TOR},${NY}, now() + interval '6 hours');
    insert into external_ids (source, kind, league, external_id, game_id) values ('espn','game','nba','401910099','${GAME}');`);
  for (const p of Object.values(P)) {
    await db.query(`insert into players (id, league, full_name, team_id, injury_status) values ($1,'nba',$2,$3,$4)`, [p.id, p.name, p.team, p.name === P.HOTOUT.name ? "Out" : null]);
    await db.query(`insert into external_ids (source, kind, league, external_id, player_id) values ('espn','player','nba',$1,$2)`, [p.espn, p.id]);
    // an open points market in the band (yes 50/52), plus one out of the band (yes 90/92) that must never be picked
    await db.query(`insert into markets (league, game_id, kind, title, player_id, stat, strike, status, yes_bid_cents, yes_ask_cents) values
      ('nba','${GAME}','player_stat','pts 15+',$1,'points',15,'open',50,52), ('nba','${GAME}','player_stat','pts 5+',$1,'points',5,'open',90,92)`, [p.id]);
  }
  await db.query(`update app_config set value = '0' where key = 'espn_pause_ms'`);   // no pacing in tests
});
after(async () => { await db?.end(); });

/** What the context pull would have stored today, from the same logs: form signals for the players, tonight's injuries, and Just Back's earlier injury. */
async function seedSignals() {
  const run1 = (await q(`insert into pipeline_runs (job, slate_date, status) values ('context:espn', $1, 'ok') returning id`, [DAY]))[0].id;
  const drafts = Object.values(P).flatMap((p) => playerSignals({ playerId: p.id, espnId: p.espn, log: parseGameLog(LOGS[p.espn]).rows, windowGames: 5, observedAt: OBSERVED }));
  for (const t of [NY, TOR]) {
    const entries = HURT_TODAY.filter((h) => h.team === t).map((h) => ({ athleteId: h.athleteId, name: h.name, status: h.status, date: OBSERVED, comment: "" }));
    drafts.push(...teamInjurySignals({ teamId: t, entries, observedAt: OBSERVED }));
  }
  await storeSignals(db!, run1, "espn", DAY, drafts);
  // Just Back was listed hurt the day before, and is not on today's list: that is what makes him "back".
  const run0 = (await q(`insert into pipeline_runs (job, slate_date, status) values ('context:espn', '2026-11-19', 'ok') returning id`))[0].id;
  await storeSignals(db!, run0, "espn", "2026-11-19", teamInjurySignals({
    teamId: TOR, observedAt: "2026-11-19T10:00:00.000Z",
    entries: [{ athleteId: P.RET.espn, name: P.RET.name, status: "Out", date: "2026-11-19T10:00:00Z", comment: "" }],
  }));
}

beforeEach(async () => {
  if (!db) return;
  alerts = [];
  await db.query(`delete from story_shortlist; delete from signal_sightings; delete from signals; delete from pipeline_runs;`);
  for (const [k, v] of Object.entries(DEFAULTS)) await setConfig(k, v);
  await seedSignals();
  restore = installFetch(storyRoutes()).restore;
});
afterEach(() => restore());

// ---------------------------------------------------------------- STO-102

test("STO-102: a player who is Out tonight never reaches the shortlist, even with a hot streak that was found", { skip }, async () => {
  const r = await run();
  assert.equal(r.status, "ok");
  assert.ok(r.status === "ok");
  // the detector did find his streak (so the filter had something to drop) ...
  assert.equal(r.summary.foundByAngle.hot_streak, 2, "Hot Hand and Hot But Out both have the streak");
  assert.equal(r.summary.notPlaying, 1);
  // ... and he is nowhere on the shortlist
  const rows = await list();
  assert.ok(!rows.some((x) => x.player === P.HOTOUT.name), "Out player must not be on the list");
  assert.ok(rows.some((x) => x.player === P.HOT.name && x.angle === "hot_streak"), "his healthy teammate's streak is");
});

// ---------------------------------------------------------------- STO-76: the three angles, stored with their signals

test("each angle produces its story, matched to the in-band market, stored with its signals and the new fields", { skip }, async () => {
  const r = await run();
  assert.ok(r.status === "ok");
  const rows = await list();
  const story = (name: string, angle: string) => rows.find((x) => x.player === name && x.angle === angle && x.stat === "pts");
  const hot = story(P.HOT.name, "hot_streak"), ret = story(P.RET.name, "back_from_injury"), bk = story(P.BACKUP.name, "backup_steps_in");
  assert.ok(hot && ret && bk, `expected all three, got ${JSON.stringify(rows.map((x) => [x.player, x.angle, x.stat]))}`);
  assert.deepEqual([hot.score, ret.score, bk.score], [21, 63, 34], "each angle on its own scale");
  assert.ok(rows.every((x) => x.league === "nba" && [NY, TOR].includes(x.team_id)));
  assert.deepEqual([hot.team_id, ret.team_id, bk.team_id], [NY, TOR, TOR]);
  // the market is the in-band one (yes ask 52), never the 92 one
  const asks = await q(`select m.yes_ask_cents as ask from story_shortlist s join markets m on m.id = s.market_id`);
  assert.ok(asks.length > 0 && asks.every((a) => a.ask === 52));
  // positions are 1..n with no gaps
  assert.deepEqual(rows.map((x) => x.position), rows.map((_, i) => i + 1));
  // each story's signals are stored with it: the return rests on the form signal AND the earlier injury
  const sig = await q(`select sg.key, sg.slate_date::text as date from story_shortlist s
                         join story_shortlist_signals l on l.shortlist_id = s.id join signals sg on sg.id = l.signal_id
                        join players p on p.id = s.player_id where p.full_name = $1 and s.angle = 'back_from_injury' and s.stat = 'pts' order by sg.key`, [P.RET.name]);
  assert.deepEqual(sig, [{ key: "form:pts", date: DAY }, { key: `injury:${P.RET.espn}`, date: "2026-11-19" }]);
  // stories without a market (rebounds, assists: no market exists) are counted, not stored
  assert.ok(r.summary.noMarket > 0);
  assert.equal(rows.some((x) => x.stat !== "pts"), false);
  // the run is recorded
  assert.deepEqual((await q(`select status from pipeline_runs where job = 'story'`)).map((x) => x.status), ["ok"]);
  assert.equal(Number((await q(`select count(distinct run_id) from story_shortlist`))[0].count), 1);
});

// ---------------------------------------------------------------- STO-103: the quota

test("STO-103: each angle keeps its quota even when another angle outscores it", { skip }, async () => {
  // Scores: return 63, backup 34, hot streak 21. Two slots, split hot streak : return : backup = 1 : 1 : 0.
  await setConfig("shortlist_size", 2); await setConfig("shortlist_split_backup_steps_in", 0);
  const r = await run();
  assert.ok(r.status === "ok");
  assert.deepEqual((await list()).map((x) => [x.angle, x.score, x.slot_kind]), [["hot_streak", 21, "quota"], ["back_from_injury", 63, "quota"]],
    "the lowest-scoring angle holds its place; the backup (34) is out although it outscores the streak");
});

test("STO-103: with no quotas at all the same two slots go purely by score", { skip }, async () => {
  await setConfig("shortlist_size", 2);
  for (const k of ["hot_streak", "back_from_injury", "backup_steps_in"]) await setConfig(`shortlist_split_${k}`, 0);
  const r = await run();
  assert.ok(r.status === "ok");
  assert.deepEqual((await list()).map((x) => [x.angle, x.score, x.slot_kind]), [["back_from_injury", 63, "fill"], ["backup_steps_in", 34, "fill"]]);
});

test("STO-103: slots no angle used are filled by score, and the summary shows quota and fill per angle", { skip }, async () => {
  await setConfig("shortlist_size", 3); await setConfig("shortlist_split_hot_streak", 2);   // quota: hot 3*2/4=1, return 3/4=0, backup 0
  const r = await run();
  assert.ok(r.status === "ok");
  assert.deepEqual(r.summary.byAngle.hot_streak, { matched: 1, quota: 1, fill: 0 });
  assert.deepEqual([r.summary.byAngle.back_from_injury!.quota, r.summary.byAngle.back_from_injury!.fill], [0, 1]);
  assert.equal(r.summary.shortlisted, 3);
});

// ---------------------------------------------------------------- re-runs and failures

test("re-running the same day gives the same shortlist: no duplicates, the old run's rows are replaced", { skip }, async () => {
  await run();
  const strip = (rows: any[]) => rows.map(({ market_id, ...r }) => r);
  const first = await list();
  const links = Number((await q(`select count(*) from story_shortlist_signals`))[0].count);
  await run(); await run();
  assert.deepEqual(strip(await list()), strip(first));
  assert.equal(Number((await q(`select count(*) from story_shortlist_signals`))[0].count), links, "links replaced, not accumulated");
  assert.equal(Number((await q(`select count(distinct run_id) from story_shortlist`))[0].count), 1, "all rows belong to the latest run");
  assert.deepEqual((await q(`select status from pipeline_runs where job = 'story' order by id`)).map((x) => x.status), ["ok", "ok", "ok"]);
});

test("ESPN down: the run fails, the alert path is the scheduler's, and the earlier shortlist is untouched", { skip }, async () => {
  await run();
  const before = await list();
  restore(); restore = installFetch(() => json({}, 503)).restore;
  await assert.rejects(run(), /ESPN down/);
  assert.deepEqual(await list(), before, "a failed run changes nothing");
  assert.deepEqual((await q(`select status from pipeline_runs where job = 'story' order by id`)).map((x) => x.status), ["ok", "failed"]);
});

test("without today's stored signals (the context pull hasn't run) stories are dropped, not cited from nothing", { skip }, async () => {
  await db!.query(`delete from signal_sightings; delete from signals`);
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok(r.summary.found > 0 && r.summary.noSignals > 0 && r.summary.shortlisted === 0);
});

// ---------------------------------------------------------------- STO-110, STO-111

test("STO-110: a game that has already tipped off is never matched, even if its status still says scheduled", { skip }, async () => {
  await db!.query(`update games set tip_off_at = now() - interval '1 minute' where id = '${GAME}'`);
  try {
    const r = await run();
    assert.ok(r.status === "ok");
    assert.ok(r.summary.found > 0 && r.summary.matched === 0 && r.summary.shortlisted === 0, "stories are found but none gets a market");
    assert.equal((await list()).length, 0);
  } finally {
    await db!.query(`update games set tip_off_at = now() + interval '6 hours' where id = '${GAME}'`);
  }
});

test("STO-111: a missing startup setting (not a story_ one) is also a failed story run with the same alert, not just a scheduler alert", { skip }, async () => {
  const saved = (await q(`select * from app_config where key = 'max_spread_cents'`))[0];
  await db!.query(`delete from app_config where key = 'max_spread_cents'`);
  const net = installFetch(() => undefined); restore = net.restore;
  try {
    const r = await run();
    assert.equal(r.status, "config_error");
    assert.ok(r.status === "config_error" && r.problems.some((x) => /max_spread_cents/.test(x)));
    assert.match(alerts[0]!, /missing max_spread_cents/);
    assert.deepEqual(net.calls, [], "it stopped before calling ESPN");
    assert.deepEqual((await q(`select status from pipeline_runs where job = 'story'`)).map((x) => x.status), ["failed"], "on the record as a failed story run");
  } finally {
    await db!.query(`insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values ($1,$2,$3,$4,$5,$6,$7)`,
      [saved.key, JSON.stringify(saved.value), saved.value_type, saved.min_value, saved.max_value, saved.is_public, saved.description]);
  }
});

// ---------------------------------------------------------------- STO-107 (last: it deletes settings from this file's own database)

test("STO-107: a missing story setting fails only the story run, alerts naming each key, and the other jobs still run", { skip }, async () => {
  await run();
  const before = await list();
  restore(); const net = installFetch(() => undefined); restore = net.restore;
  await db!.query(`delete from app_config where key in ('story_score_max', 'shortlist_size')`);

  const other = { name: "other_job", run: async () => ({ ran: true }) };
  const story = await runJob(db!, storyJob(alert, { post: async () => {} }, DAY), alert);
  const rest = await runJob(db!, other, alert);

  assert.equal((await loadConfig(db!)).cardsPerDay, 10, "the startup config still loads: the worker keeps running");
  assert.equal(rest.status, "ok", "another job runs as normal");
  assert.equal(story.status, "ok", "the scheduler sees a handled outcome, so it doesn't alert a second time");
  assert.ok(story.status === "ok" && (story.outputs as { status: string }).status === "config_error");
  assert.equal(alerts.length, 1, "exactly one alert");
  assert.match(alerts[0]!, /story can't run/);
  assert.match(alerts[0]!, /missing story_score_max/);
  assert.match(alerts[0]!, /missing shortlist_size/);
  assert.deepEqual(net.calls, [], "it stopped before calling ESPN");
  assert.deepEqual((await q(`select status from pipeline_runs where job = 'story' order by id`)).map((x) => x.status), ["ok", "failed"], "this job's run is the failed one");
  assert.match((await q(`select error from pipeline_runs where job = 'story' and status = 'failed'`))[0].error, /story_score_max/);
  assert.deepEqual(await list(), before, "yesterday's good list is not wiped by a config error");
});
