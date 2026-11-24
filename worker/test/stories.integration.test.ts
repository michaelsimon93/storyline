// The story step end to end (STO-76, STO-102, STO-103, STO-107): ESPN responses through a mocked fetch, a real Postgres,
// the real migrations. Written to prove:
//   STO-102  a player who is Out tonight never reaches the shortlist, even with the best hot streak of the day
//   STO-103  the shortlist holds a quota per angle, so a low-scoring angle still has its place; fills go by score
//   STO-107  a missing story setting fails only this job's run, with an alert naming the keys; other jobs still run
//   STO-76   stored for the run with its signals; re-running a day is safe; ESPN down keeps the old list
// Requires TEST_DATABASE_URL (skipped otherwise). Runs in CI.

import { test, before, after, beforeEach, afterEach, describe } from "node:test";
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
import { P, STAR, NY, TOR, DAY, GAME, LOGS, HURT_TODAY, storyRoutes, injuries, gameLog } from "./helpers/storyWorld.js";
import pg from "pg";

describe("the story step end to end", () => {
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

});

describe("hostile and boundary inputs", () => {
const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const FETCH = { retries: 0, baseDelayMs: 1 };
const OBSERVED = `${DAY}T10:00:00.000Z`;

let db: Db | null = null;
let restore = () => {};
let alerts: string[] = [];
const alert = async (m: string) => { alerts.push(m); };
const run = () => runStories(db!, { alert, date: DAY, fetchOpts: FETCH });
const q = async <T = any>(sql: string, args: unknown[] = []) => (await db!.query(sql, args)).rows as T[];
const list = () => q(`select p.full_name as player, s.angle, s.stat, s.score, s.slot_kind, s.position, s.run_id
                        from story_shortlist s join players p on p.id = s.player_id order by s.position`);
const net = (over: Parameters<typeof storyRoutes>[0] = {}) => { restore(); restore = installFetch(storyRoutes(over)).restore; };

before(async () => {
  db = await freshDb("storyline_stories_hostile_test");
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, abbr) values (${NY}, 'nba', 'Knicks', 'NYK'), (${TOR}, 'nba', 'Raptors', 'TOR'), (5, 'nba', 'Other', 'OTH');
    insert into external_ids (source, kind, league, external_id, team_id) values ('espn','team','nba','${NY}',${NY}), ('espn','team','nba','${TOR}',${TOR});
    insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values ('${GAME}','nba','${DAY}',${TOR},${NY}, now() + interval '6 hours');
    insert into external_ids (source, kind, league, external_id, game_id) values ('espn','game','nba','401910099','${GAME}');`);
  for (const p of Object.values(P)) {
    await db.query(`insert into players (id, league, full_name, team_id, injury_status) values ($1,'nba',$2,$3,$4)`, [p.id, p.name, p.team, p.name === P.HOTOUT.name ? "Out" : null]);
    await db.query(`insert into external_ids (source, kind, league, external_id, player_id) values ('espn','player','nba',$1,$2)`, [p.espn, p.id]);
    await db.query(`insert into markets (league, game_id, kind, title, player_id, stat, strike, status, yes_bid_cents, yes_ask_cents) values
      ('nba','${GAME}','player_stat','pts 15+',$1,'points',15,'open',50,52)`, [p.id]);
  }
  await db.query(`update app_config set value = '0' where key = 'espn_pause_ms'`);
});
after(async () => { await db?.end(); });

async function seedSignals() {
  const run1 = (await q(`insert into pipeline_runs (job, slate_date, status) values ('context:espn', $1, 'ok') returning id`, [DAY]))[0].id;
  const drafts = Object.values(P).flatMap((p) => playerSignals({ playerId: p.id, espnId: p.espn, log: parseGameLog(LOGS[p.espn]).rows, windowGames: 5, observedAt: OBSERVED }));
  for (const t of [NY, TOR]) {
    const entries = HURT_TODAY.filter((h) => h.team === t).map((h) => ({ athleteId: h.athleteId, name: h.name, status: h.status, date: OBSERVED, comment: "" }));
    drafts.push(...teamInjurySignals({ teamId: t, entries, observedAt: OBSERVED }));
  }
  await storeSignals(db!, run1, "espn", DAY, drafts);
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
  await db.query(`delete from markets where title like 'qa %'`);
  await db.query(`update markets set status = 'open', yes_bid_cents = 50, yes_ask_cents = 52 where title = 'pts 15+'`);
  await db.query(`update app_config set value = '25' where key = 'price_band_min'; update app_config set value = '75' where key = 'price_band_max'`);
  await seedSignals();
  net();
});
afterEach(() => restore());

/** The injuries feed for the world, with HOTOUT's row edited by `edit` (to break it in some way). */
function feedWithHotOut(edit: (row: Record<string, unknown>) => void) {
  const body = injuries(HURT_TODAY) as { injuries: { injuries: Record<string, unknown>[] }[] };
  for (const t of body.injuries) for (const r of t.injuries) if ((r.athlete as { displayName: string }).displayName === P.HOTOUT.name) edit(r);
  return () => json(body);
}

// ---------------------------------------------------------------- STO-102: hostile / malformed injury data

// Attacks STO-102 fail-closed: ESPN sends the Out player's row without a `date`; the row is skipped, so he looks healthy.
test("QA STO-102: an Out player whose injury row is malformed (skipped) still never reaches the shortlist", { skip }, async () => {
  net({ injuries: feedWithHotOut((r) => { delete r.date; }) });
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok(r.summary.inputs.skippedRows > 0, "the bad row was skipped (precondition)");
  const rows = await list();
  assert.ok(!rows.some((x) => x.player === P.HOTOUT.name),
    `ingest stored him as Out and ESPN listed him (row unreadable), yet he is on the list: ${JSON.stringify(rows.map((x) => [x.player, x.angle]))}`);
});

// Attacks STO-102 fail-closed: the Out player's row has no athlete id link, so it can't be tied to him.
test("QA STO-102: an Out player whose injury row has no athlete id never reaches the shortlist", { skip }, async () => {
  net({ injuries: feedWithHotOut((r) => { (r.athlete as { links: unknown[] }).links = []; }) });
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok(!(await list()).some((x) => x.player === P.HOTOUT.name), "an unreadable injury row must not make an Out player healthy");
});

// Coverage: duplicate injury rows in the wrong order (Day-To-Day listed after Out) — the worse status wins.
test("QA STO-102: a player listed twice (Out and Day-To-Day) is dropped whichever order ESPN lists them", { skip }, async () => {
  const body = injuries([{ team: NY, athleteId: P.HOTOUT.espn, name: P.HOTOUT.name, status: "Day-To-Day" }, ...HURT_TODAY]);
  net({ injuries: () => json(body) });
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok(!(await list()).some((x) => x.player === P.HOTOUT.name));
});

// Coverage: player traded mid-season — ESPN lists him Out under a team that isn't on the slate.
test("QA STO-102: Out under another team (traded) is still Out for us", { skip }, async () => {
  const body = injuries([{ team: 5, athleteId: P.HOTOUT.espn, name: P.HOTOUT.name, status: "Out" }, ...HURT_TODAY.filter((h) => h.athleteId !== P.HOTOUT.espn)]);
  net({ injuries: () => json(body) });
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok(!(await list()).some((x) => x.player === P.HOTOUT.name));
});

// ---------------------------------------------------------------- the transactional replace

// Coverage: an insert fails half way through the replace; the old list must survive whole, nothing partial.
test("QA replace: an insert that fails half way leaves yesterday's list intact and the run failed", { skip }, async () => {
  await run();
  const before = await list();
  assert.ok(before.length >= 2, "need at least two rows to fail on the second");
  await db!.query(`
    create or replace function qa_fail_second() returns trigger language plpgsql as $$
    begin if new.position = 2 then raise exception 'qa: insert failed half way'; end if; return new; end $$;
    create trigger qa_fail_second before insert on story_shortlist for each row execute function qa_fail_second();`);
  try {
    await assert.rejects(run(), /half way/);
    assert.deepEqual(await list(), before, "old list, untouched");
    assert.equal(Number((await q(`select count(*) from story_shortlist_signals l left join story_shortlist s on s.id = l.shortlist_id where s.id is null`))[0].count), 0, "no orphan links");
    assert.deepEqual((await q(`select status from pipeline_runs where job = 'story' order by id`)).map((x) => x.status), ["ok", "failed"]);
  } finally {
    await db!.query(`drop trigger qa_fail_second on story_shortlist; drop function qa_fail_second()`);
  }
});

// Coverage: a re-run after a market closes removes that story and its signal links; nothing lingers.
test("QA replace: a re-run after a market closes drops that story and its links", { skip }, async () => {
  await run();
  assert.ok((await list()).some((x) => x.player === P.HOT.name));
  await db!.query(`update markets set status = 'closed' where player_id = $1`, [P.HOT.id]);
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok(!(await list()).some((x) => x.player === P.HOT.name));
  assert.equal(Number((await q(`select count(distinct run_id) from story_shortlist`))[0].count), 1);
  const links = await q(`select count(*)::int as n from story_shortlist_signals l join story_shortlist s on s.id = l.shortlist_id where s.run_id <> $1`, [r.summary.runId]);
  assert.equal(links[0].n, 0);
});

// ---------------------------------------------------------------- concurrency: two runs for one day at once

// Coverage: two scheduler runs of the story job at the same moment; the advisory lock lets one through.
test("QA concurrency: two runJob(story) at once → one runs, one is skipped, one list", { skip }, async () => {
  const feed = { post: async () => {} };
  const [a, b] = await Promise.all([runJob(db!, storyJob(alert, feed, DAY), alert), runJob(db!, storyJob(alert, feed, DAY), alert)]);
  assert.deepEqual([a.status, b.status].sort(), ["ok", "skipped"]);
  const rows = await list();
  assert.ok(rows.length > 0);
  assert.equal(new Set(rows.map((x) => x.run_id)).size, 1);
});

// Attacks the replace itself without the lock (e.g. a manual `runStories` call, or the lock connection dropped):
// whatever happens, the list must be one run's list, never a mix or duplicates, and no run left 'running'.
test("QA concurrency: two runStories for one day at once (no lock) never leave a mixed or doubled list", { skip }, async () => {
  await run();
  const single = (await list()).map(({ run_id, ...x }) => x);
  // Barrier on a second real connection: hold SHARE on the table so both runs queue at their `delete`, then release
  // them together, so the two replaces truly overlap (without it, ESPN mock timing serialises them).
  const barrier = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL!.replace(/^(\w+:\/\/[^/]*\/)([^?]*)/, "$1storyline_stories_hostile_test") });
  await barrier.connect();
  await barrier.query(`begin; lock table story_shortlist in share mode`);
  const both = Promise.allSettled([run(), run()]);
  const t0 = Date.now();
  while (Number((await barrier.query(`select count(*) from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'story_shortlist' and not l.granted`)).rows[0].count) < 2) {
    if (Date.now() - t0 > 20000) throw new Error("both runs never reached the replace");
    await new Promise((r) => setTimeout(r, 20));
  }
  await barrier.query(`commit`); await barrier.end();
  const results = await both;
  for (const x of results) if (x.status === "rejected") assert.match(String(x.reason), /story_shortlist_one_(story|position)/, "the loser fails loudly on the unique key");
  assert.ok(results.some((x) => x.status === "fulfilled"), `at least one run succeeds: ${JSON.stringify(results.map((x) => x.status === "rejected" ? String(x.reason) : "ok"))}`);
  const rows = await list();
  assert.deepEqual(rows.map(({ run_id, ...x }) => x), single, "same list as one run");
  assert.equal(new Set(rows.map((x) => x.run_id)).size, 1, "all rows from one run");
  assert.equal(Number((await q(`select count(*) from pipeline_runs where job = 'story' and status = 'running'`))[0].count), 0);
});

// ---------------------------------------------------------------- markets with odd prices

// Coverage: only an open, unsettled, in-band, tight market matches; every odd one is "no market".
test("QA market: closed, settled, null-priced, crossed, wide, 1¢ and 99¢ markets never match", { skip }, async () => {
  await db!.query(`update markets set status = 'closed' where player_id = $1`, [P.HOT.id]);
  let strike = 20;
  const ins = (title: string, status: string, bid: number | null, ask: number | null, result: string | null = null) =>
    db!.query(`insert into markets (league, game_id, kind, title, player_id, stat, strike, status, yes_bid_cents, yes_ask_cents, result) values
      ('nba',$1,'player_stat',$2,$3,'points',$4,$5,$6,$7,$8)`, [GAME, `qa ${title}`, P.HOT.id, strike++, status, bid, ask, result]);
  await ins("1c", "open", 0, 1);
  await ins("99c", "open", 98, 99);
  await ins("no bid", "open", null, 50);
  await ins("no ask", "open", 50, null);
  await ins("crossed", "open", 55, 50);
  await ins("wide", "open", 40, 50);
  await ins("settled", "open", 49, 50, "yes");
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok(!(await list()).some((x) => x.player === P.HOT.name));
  assert.ok(r.summary.noMarketSamples.some((s) => s.startsWith(P.HOT.name)), "counted as no market");
});

// Coverage: the band comes from app_config — widened to 1..99, a 1¢ ask with a 1¢ spread is matchable at the edge.
test("QA market: band edges come from app_config (1¢ matches once the band is 1..99)", { skip }, async () => {
  await db!.query(`update app_config set value = '1' where key = 'price_band_min'; update app_config set value = '99' where key = 'price_band_max'`);
  await db!.query(`update markets set status = 'closed' where player_id = $1`, [P.HOT.id]);
  await db!.query(`insert into markets (league, game_id, kind, title, player_id, stat, strike, status, yes_bid_cents, yes_ask_cents) values
    ('nba',$1,'player_stat','qa 1c',$2,'points',30,'open',0,1)`, [GAME, P.HOT.id]);
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok((await list()).some((x) => x.player === P.HOT.name));
});

// ---------------------------------------------------------------- a player with several stories

// Coverage: Hot Hand streaks on points AND rebounds with markets on both; he takes one hot_streak slot, his best stat.
test("QA several stories: one player hot on two stats with two markets gets one hot_streak row", { skip }, async () => {
  const log = gameLog(NY, Array.from({ length: 10 }, (_, k) => ({ game: k + 1, min: 30, pts: k + 1 > 7 ? 16 : 12, reb: k + 1 > 7 ? 7 : 4, ast: 2, fg3m: 0 })));
  net({ [`gamelog-${P.HOT.espn}`]: () => json(log) });
  await db!.query(`insert into markets (league, game_id, kind, title, player_id, stat, strike, status, yes_bid_cents, yes_ask_cents) values
    ('nba',$1,'player_stat','qa reb',$2,'rebounds',5,'open',50,52)`, [GAME, P.HOT.id]);
  const r = await run();
  assert.ok(r.status === "ok");
  assert.ok(r.summary.foundByAngle.hot_streak! >= 3, "both his stats were found (precondition)");
  const hot = (await list()).filter((x) => x.player === P.HOT.name && x.angle === "hot_streak");
  assert.equal(hot.length, 1, JSON.stringify(hot));
  assert.equal(hot[0].stat, "reb", "his best-scoring stat");
});

// Hostile: STAR (not on the slate, no market) is Out; nothing about him is stored on the shortlist.
test("QA slate: a player who isn't on the slate never gets a row, even though his log was fetched", { skip }, async () => {
  const r = await run();
  assert.ok(r.status === "ok");
  assert.equal(Number((await q(`select count(*) from story_shortlist s join players p on p.id = s.player_id where p.full_name = $1`, [STAR.name]))[0].count), 0);
  assert.ok(alerts.length === 0, `a clean run sends no alert: ${alerts.join(" | ")}`);
});
});

describe("shortlist and market row locks (STO-109)", () => {
const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const GAME = "00000000-0000-0000-0000-00000109e001";
const PLAYER = "00000000-0000-0000-0000-00000109b001";
const MARKET = "00000000-0000-0000-0000-00000109f001";
const RUN = 109001;
let db: Db | null = null;
let pos = 0;

before(async () => {
  db = await freshDb("storyline_sto109_locks");
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
});
