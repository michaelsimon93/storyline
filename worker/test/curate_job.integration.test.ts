// The curation job (STO-11) end to end against real Postgres, with a FAKE curator: no network. It reads the story step's
// stored shortlist (story_shortlist), runs curation under the rules, stores every attempt, and posts the picks.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { runCuration, loadShortlist } from "../src/jobs/curate.js";
import { curateJob } from "../src/jobs/index.js";
import type { CurationRequest } from "../src/sources/curate.js";
import type { Curator } from "../src/sources/types.js";
import { freshDb } from "./helpers/testDb.js";
import { fakeWriter, GUIDE } from "./helpers/blurbs.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const DBNAME = "storyline_curate_job_test";
const [P1, P2, P3] = ["00000000-0000-0000-0000-0000000000e1", "00000000-0000-0000-0000-0000000000e2", "00000000-0000-0000-0000-0000000000e3"];
const [G1, G2] = ["00000000-0000-0000-0000-0000000000f1", "00000000-0000-0000-0000-0000000000f2"];
const DAY = "2026-11-23", OTHER_DAY = "2026-11-22";
let db: Db | null = null;
let sigA = 0, sigB = 0;

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows as T[];
const market = async (game: string, player: string, stat: string, strike: number, bid: number, ask: number) =>
  (await q<{ id: string }>(`insert into markets (league, game_id, kind, title, player_id, stat, strike, yes_bid_cents, yes_ask_cents, status)
    values ('nba', $1, 'player_stat', 't', $2, $3, $4, $5, $6, 'open') returning id`, [game, player, stat, strike, bid, ask]))[0]!.id;

before(async () => {
  db = await freshDb(DBNAME);
  if (!db) return;
  await q(`insert into teams (id, league, name, abbr) values (1, 'nba', 'Knicks', 'NYK'), (2, 'nba', 'Raptors', 'TOR'), (3, 'nba', 'Heat', 'MIA'), (4, 'nba', 'Magic', 'ORL')`);
  await q(`insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values
    ($1, 'nba', $3, 2, 1, '2026-11-23T23:30:00Z'), ($2, 'nba', $3, 4, 3, '2026-11-23T23:30:00Z')`, [G1, G2, DAY]);
  await q(`insert into players (id, league, full_name, team_id) values ($1,'nba','Jalen Brunson',1), ($2,'nba','Scottie Barnes',2), ($3,'nba','Paolo Banchero',4)`, [P1, P2, P3]);
  const run = (await q<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('story', $1, 'ok') returning id`, [DAY]))[0]!.id;
  const sig = async (player: string, key: string, summary: string) => Number((await q<{ id: string }>(
    `insert into signals (source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id)
     values ('espn','stat',$1,$2,$3,$4,'{"quote":"q"}', now(), 'verified', $5) returning id`, [DAY, player, key, summary, run]))[0]!.id);
  sigA = await sig(P1, "form:pts", "last 5: 31, 28, 35, 30, 29");
  sigB = await sig(P2, "form:reb", "last 5: 9, 11, 10, 12, 10");
  // ladders: P1 points 20 (80c, out of band), 25 (60c), 30 (40c); P2 rebounds 10 (50c); P3 assists 6 (55c)
  const m1 = await market(G1, P1, "points", 25, 58, 60); await market(G1, P1, "points", 20, 78, 80); await market(G1, P1, "points", 30, 38, 40);
  const m2 = await market(G1, P2, "rebounds", 10, 48, 50);
  const m3 = await market(G2, P3, "assists", 6, 53, 55);
  const short = async (pos: number, p: string, team: number, g: string, angle: string, stat: string, score: number, m: string, summary: string, sigs: number[]) => {
    const id = (await q<{ id: string }>(
      `insert into story_shortlist (run_id, slate_date, league, position, player_id, game_id, team_id, angle, stat, score, summary, market_id, slot_kind)
       values ($1, $2, 'nba', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'quota') returning id`, [run, DAY, pos, p, g, team, angle, stat, score, summary, m]))[0]!.id;
    for (const s of sigs) await q(`insert into story_shortlist_signals (shortlist_id, signal_id) values ($1, $2)`, [id, s]);
  };
  await short(1, P1, 1, G1, "hot_streak", "pts", 42, m1, "Hot streak: 30.6 PTS over his last 5", [sigA]);
  await short(2, P2, 2, G1, "backup_steps_in", "reb", 55, m2, "Backup stepping in", [sigB]);
  await short(3, P3, 4, G2, "back_from_injury", "ast", 63, m3, "Back from injury", []);
});
after(async () => { await db?.end(); });

const scripted = (answers: unknown[]): Curator<CurationRequest, unknown> & { seen: CurationRequest[] } => {
  const seen: CurationRequest[] = [];
  return { name: "fake", seen, async curate(r) { seen.push(r); const a = answers[seen.length - 1]; if (a instanceof Error) throw a; return a; } };
};
const alerts = () => { const sent: string[] = []; return { sent, alert: async (m: string) => { sent.push(m); } }; };
const idOf = async (position: number) => String((await q<{ id: string }>(`select id from story_shortlist where slate_date = $1 and position = $2`, [DAY, position]))[0]!.id);
const marketOf = async (player: string, strike: number) => (await q<{ id: string }>(`select id from markets where player_id = $1 and strike = $2`, [player, strike]))[0]!.id;
const goodAnswer = async () => ({
  ranking: [await idOf(3), await idOf(1), await idOf(2)],
  picks: [{ storyId: await idOf(1), marketId: await marketOf(P1, 30), reason: "Five straight 28+ games" }, { storyId: await idOf(2), marketId: await marketOf(P2, 10), reason: "Starting in place of the star" }],
});
const config = (n: number) => q(`update app_config set value = $1 where key = 'cards_per_day'`, [String(n)]);

test("loads the day's shortlist in display order with each story's signal IDs", { skip }, async () => {
  const list = await loadShortlist(db!, DAY);
  assert.deepEqual(list.map((e) => [e.position, e.angle, e.stat]), [[1, "hot_streak", "pts"], [2, "backup_steps_in", "reb"], [3, "back_from_injury", "ast"]]);
  assert.deepEqual(list.map((e) => e.signalIds), [[sigA], [sigB], []]);
  assert.equal(typeof list[0]!.id, "number");
  assert.deepEqual(await loadShortlist(db!, OTHER_DAY), []);
});

test("a good answer: ok run on the record, picks in its outputs, the attempt stored, no alert", { skip }, async () => {
  await config(2);
  const a = alerts(), c = scripted([await goodAnswer()]);
  const r = await runCuration(db!, { alert: a.alert, date: DAY, curator: c, blurbWriter: fakeWriter(), styleGuide: GUIDE });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.picks, 2);
  assert.deepEqual(a.sent, []);
  const run = (await q<{ status: string; outputs: { picks: { reason: string }[]; stories: number; shown: number } }>(`select status, outputs from pipeline_runs where id = $1`, [r.runId]))[0]!;
  assert.equal(run.status, "ok");
  assert.deepEqual(run.outputs.picks.map((p) => p.reason), ["Five straight 28+ games", "Starting in place of the star"]);
  assert.equal(run.outputs.stories, 3);
  const att = await q<{ accepted: boolean }>(`select accepted from curation_attempts where run_id = $1 and step = 'pick'`, [r.runId]);
  assert.deepEqual(att.map((x) => x.accepted), [true]);
});

test("what the model was shown: the story ids, signal text and in-band strikes, and no detector scores", { skip }, async () => {
  await config(2);
  const c = scripted([await goodAnswer()]);
  await runCuration(db!, { alert: async () => {}, date: DAY, curator: c, blurbWriter: fakeWriter(), styleGuide: GUIDE });
  const req = c.seen[0]!;
  assert.equal(req.input.stories.length, 3);
  assert.deepEqual(req.input.stories[0]!.ladder.map((l) => l.strike), [25, 30]);      // the 80c strike was cut
  assert.equal(req.input.stories[0]!.signals[0]!.summary, "last 5: 31, 28, 35, 30, 29");
  assert.equal(req.rules.n, 2);
  assert.ok(!JSON.stringify(req).includes('"score"'), "scores aren't comparable across angles, so they aren't sent");
  assert.ok(!JSON.stringify(req).includes("slotKind"));
});

test("every attempt fails: one alert, the run is failed, every attempt is kept, nothing is posted", { skip }, async () => {
  await config(2);
  const a = alerts(), c = scripted([{ nope: 1 }, new Error("HTTP 529"), "just words"]);
  const r = await runCuration(db!, { alert: a.alert, date: DAY, curator: c, blurbWriter: fakeWriter(), styleGuide: GUIDE });
  assert.equal(r.status, "failed");
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0]!, /Curation failed for 2026-11-23: 3 attempts/);
  const run = (await q<{ status: string; error: string }>(`select status, error from pipeline_runs where id = $1`, [(r as { runId: number }).runId]))[0]!;
  assert.equal(run.status, "failed");
  assert.match(run.error, /every one of 3 curation attempts/);
  const att = await q<{ accepted: boolean }>(`select accepted from curation_attempts where run_id = $1 and step = 'pick' order by attempt`, [(r as { runId: number }).runId]);
  assert.deepEqual(att.map((x) => x.accepted), [false, false, false]);

  // through the job wrapper: nothing reaches #testing
  const posted: string[] = [];
  const out = await curateJob(async () => {}, { post: async (m) => { posted.push(m); } }, DAY, scripted([{ nope: 1 }, { nope: 2 }, { nope: 3 }]), fakeWriter(), GUIDE).run(db!) as { status: string };
  assert.equal(out.status, "failed");
  assert.deepEqual(posted, []);
});

test("a retry that passes is accepted and the rejected attempt is still kept", { skip }, async () => {
  await config(2);
  const bad = { ranking: ["x"], picks: [] };
  const r = await runCuration(db!, { alert: async () => {}, date: DAY, curator: scripted([bad, await goodAnswer()]), blurbWriter: fakeWriter(), styleGuide: GUIDE });
  assert.equal(r.status, "ok");
  const att = await q<{ attempt: number; accepted: boolean; violations: { kind: string }[] }>(`select attempt, accepted, violations from curation_attempts where run_id = $1 and step = 'pick' order by attempt`, [(r as { runId: number }).runId]);
  assert.deepEqual(att.map((x) => x.accepted), [false, true]);
  assert.ok(att[0]!.violations.some((v) => v.kind === "ranking"));
});

test("no shortlist for the day: reported, the model is never called, yesterday's list is not used", { skip }, async () => {
  const a = alerts(), c = scripted([]);
  const r = await runCuration(db!, { alert: a.alert, date: OTHER_DAY, curator: c, blurbWriter: fakeWriter(), styleGuide: GUIDE });
  assert.equal(r.status, "no_shortlist");
  assert.equal(c.seen.length, 0);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0]!, /no story shortlist for 2026-11-22/);
  assert.match(a.sent[0]!, /npm run job -- story/);
});

test("a missing curation setting stops only this step, naming the key", { skip }, async () => {
  await q(`update app_config set value = '3' where key = 'curation_max_attempts'`);   // keep the row; remove a different one below
  const saved = (await q<{ value: unknown }>(`select value from app_config where key = 'curation_max_per_stat'`))[0]!.value;
  await q(`delete from app_config where key = 'curation_max_per_stat'`);
  try {
    const a = alerts(), c = scripted([]);
    const r = await runCuration(db!, { alert: a.alert, date: DAY, curator: c, blurbWriter: fakeWriter(), styleGuide: GUIDE });
    assert.equal(r.status, "config_error");
    assert.deepEqual((r as { problems: string[] }).problems, ["missing curation_max_per_stat"]);
    assert.equal(c.seen.length, 0);
    assert.equal(a.sent.length, 1);
    assert.match(a.sent[0]!, /curation_max_per_stat/);
    assert.equal((await q<{ status: string }>(`select status from pipeline_runs where id = $1`, [(r as { runId: number }).runId]))[0]!.status, "failed");
  } finally {
    await q(`insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values ('curation_max_per_stat', $1, 'int', 1, 30, false, 'restored')`, [JSON.stringify(saved)]);
  }
});

test("running it twice is safe: each run has its own attempts and its own accepted answer, the shortlist is untouched", { skip }, async () => {
  await config(2);
  const before = (await q<{ n: string }>(`select count(*) n from story_shortlist`))[0]!.n;
  const r1 = await runCuration(db!, { alert: async () => {}, date: DAY, curator: scripted([await goodAnswer()]), blurbWriter: fakeWriter(), styleGuide: GUIDE });
  const r2 = await runCuration(db!, { alert: async () => {}, date: DAY, curator: scripted([await goodAnswer()]), blurbWriter: fakeWriter(), styleGuide: GUIDE });
  assert.ok(r1.status === "ok" && r2.status === "ok" && r1.runId !== r2.runId);
  const per = await q<{ run_id: string; n: string; acc: string }>(
    `select run_id, count(*) n, count(*) filter (where accepted) acc from curation_attempts where step = 'pick' and run_id = any($1::bigint[]) group by run_id order by run_id`, [[(r1 as { runId: number }).runId, (r2 as { runId: number }).runId]]);
  assert.deepEqual(per.map((x) => [x.n, x.acc]), [["1", "1"], ["1", "1"]]);
  assert.equal((await q<{ n: string }>(`select count(*) n from story_shortlist`))[0]!.n, before);
});

test("the job posts the picks, with each story type, to #testing, and a failing feed doesn't fail the run", { skip }, async () => {
  await config(2);
  const posted: string[] = [];
  const out = await curateJob(async () => {}, { post: async (m) => { posted.push(m); } }, DAY, scripted([await goodAnswer()]), fakeWriter(), GUIDE).run(db!) as { status: string; posted?: unknown };
  assert.equal(out.status, "ok");
  assert.ok(!("posted" in out), "the run's result is the counts, not the whole deck");
  const text = posted.join("\n");
  assert.match(text, /\*\*Jalen Brunson\*\* pts 30\+ at 40c · `hot_streak`/);
  assert.match(text, /\*\*Scottie Barnes\*\* reb 10\+ at 50c · `backup_steps_in`/);
  assert.match(text, /Story types picked: backup_steps_in 1, hot_streak 1\./);

  // a feed that throws can't fail a run that already succeeded
  const runsBefore = Number((await q<{ n: string }>(`select count(*) n from pipeline_runs where job = 'curate' and status = 'ok'`))[0]!.n);
  const out2 = await curateJob(async () => {}, { post: async () => { throw new Error("discord down"); } }, DAY, scripted([await goodAnswer()]), fakeWriter(), GUIDE).run(db!) as { status: string };
  assert.equal(out2.status, "ok");
  assert.equal(Number((await q<{ n: string }>(`select count(*) n from pipeline_runs where job = 'curate' and status = 'ok'`))[0]!.n), runsBefore + 1);
});
