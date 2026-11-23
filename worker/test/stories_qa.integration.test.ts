// QA attacks on the story step (STO-76/102/103/107, PR #43). Real Postgres, mocked ESPN, the same small world as
// stories.integration.test.ts. Each test says what it attacks. A failing test here is a finding: leave it failing.
// Requires TEST_DATABASE_URL (skipped otherwise).

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Db } from "../src/lib/db.js";
import { runStories } from "../src/jobs/stories.js";
import { storyJob } from "../src/jobs/index.js";
import { runJob } from "../src/scheduler.js";
import { storeSignals } from "../src/sources/signals.js";
import { parseGameLog } from "../src/domain/espnParse.js";
import { playerSignals, teamInjurySignals } from "../src/domain/espnSignals.js";
import { freshDb } from "./helpers/testDb.js";
import { installFetch, json } from "./helpers/mockFetch.js";
import { P, STAR, NY, TOR, DAY, GAME, LOGS, HURT_TODAY, storyRoutes, injuries, gameLog } from "./helpers/storyWorld.js";

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
  db = await freshDb("storyline_stories_qa_test");
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, abbr) values (${NY}, 'nba', 'Knicks', 'NYK'), (${TOR}, 'nba', 'Raptors', 'TOR'), (5, 'nba', 'Other', 'OTH');
    insert into external_ids (source, kind, league, external_id, team_id) values ('espn','team','nba','${NY}',${NY}), ('espn','team','nba','${TOR}',${TOR});
    insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values ('${GAME}','nba','${DAY}',${TOR},${NY},'${DAY}T23:30:00Z');
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
  const barrier = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL!.replace(/^(\w+:\/\/[^/]*\/)([^?]*)/, "$1storyline_stories_qa_test") });
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
