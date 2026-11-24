// The curation job (STO-11) end to end against real Postgres, with a FAKE curator: no network. It reads the story step's
// stored shortlist (story_shortlist), runs curation under the rules, stores every attempt, and posts the picks.

import { test, before, after, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { runCuration, loadShortlist } from "../src/jobs/curate.js";
import { curateJob } from "../src/jobs/index.js";
import type { CurationRequest } from "../src/sources/curate.js";
import type { Curator } from "../src/sources/types.js";
import { freshDb } from "./helpers/testDb.js";
import { fakeWriter, cleanAnswer, GUIDE } from "./helpers/blurbs.js";
import type { BlurbRequest } from "../src/sources/claudeBlurbs.js";

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

// Blurbs through the job (STO-77): the loader, the stored attempts and the #testing post are real; only Claude is scripted.
// Rule-by-rule checks live in blurbRules.test.ts; these prove the wiring.
describe("blurbs", () => {
const DBNAME = "storyline_blurbs_job_test";
const DAY = "2026-11-23", OLD_DAY = "2026-11-20";
const [HIELD, BARNES, BANCHERO, JONES] = [1, 2, 3, 4].map((n) => `00000000-0000-0000-0000-00000000010${n}`) as [string, string, string, string];
const [G1, G2] = ["00000000-0000-0000-0000-0000000001f1", "00000000-0000-0000-0000-0000000001f2"] as [string, string];
let db: Db | null = null;
const S: Record<string, number> = {};                // signal ids by name
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows as T[];

const scriptedCurator = (answer: () => Promise<unknown>): Curator<CurationRequest, unknown> & { seen: CurationRequest[] } => {
  const seen: CurationRequest[] = [];
  return { name: "fake", seen, async curate(r) { seen.push(r); return answer(); } };
};
const sid = async (position: number) => String((await q<{ id: string }>(`select id from story_shortlist where slate_date = $1 and position = $2`, [DAY, position]))[0]!.id);
const mid = async (player: string, strike: number) => (await q<{ id: string }>(`select id from markets where player_id = $1 and strike = $2`, [player, strike]))[0]!.id;

/** Positions: 1 Hield hot_streak, 2 Hield backup_steps_in (two stories, one player), 3 Barnes (dated stat), 4 Banchero (only an unreviewed signal), 5 Jones (no signals). */
async function picks(...positions: number[]) {
  const all: Record<number, [string, number]> = { 1: [HIELD, 4], 2: [HIELD, 4], 3: [BARNES, 10], 4: [BANCHERO, 6], 5: [JONES, 15] };
  const ps = await Promise.all(positions.map(async (n) => ({ storyId: await sid(n), marketId: await mid(...all[n]!), reason: "why a fan cares" })));
  return { ranking: await Promise.all([1, 2, 3, 4, 5].map(sid)), picks: ps };
}
const config = (n: number) => q(`update app_config set value = $1 where key = 'cards_per_day'`, [String(n)]);

before(async () => {
  db = await freshDb(DBNAME);
  if (!db) return;
  await q(`insert into teams (id, league, name, abbr) values (1, 'nba', 'Bulls', 'CHI'), (2, 'nba', 'Raptors', 'TOR'), (3, 'nba', 'Magic', 'ORL'), (4, 'nba', 'Heat', 'MIA')`);
  await q(`insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values ($1,'nba',$3,2,1,'2026-11-23T23:30:00Z'), ($2,'nba',$3,3,4,'2026-11-23T23:30:00Z')`, [G1, G2, DAY]);
  await q(`insert into players (id, league, full_name, team_id) values ($1,'nba','Buddy Hield',1), ($2,'nba','Scottie Barnes',2), ($3,'nba','Paolo Banchero',3), ($4,'nba','Tyler Herro',4)`, [HIELD, BARNES, BANCHERO, JONES]);
  const run = (await q<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('story', $1, 'ok') returning id`, [DAY]))[0]!.id;
  const sig = async (name: string, player: string, kind: string, day: string, observed: string, summary: string, trust = "verified", url?: string) => {
    S[name] = Number((await q<{ id: string }>(
      `insert into signals (source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id)
       values ('espn', $2::signal_kind, $3, $1, $4, $5, $6::jsonb, $7, $8::signal_trust, $9) returning id`,
      [player, kind, day, name, summary, JSON.stringify(url ? { url } : { quote: "q" }), observed, trust, run]))[0]!.id);
  };
  await sig("form", HIELD, "stat", DAY, "2026-11-23T14:00:00Z", "last 5 games: 4.0 threes a game");
  await sig("powell", HIELD, "injury", DAY, "2026-11-23T14:05:00Z", "Norman Powell is out tonight");
  await sig("oldForm", BARNES, "stat", OLD_DAY, "2026-11-20T15:00:00Z", "last 5 games: 10 rebounds a night");
  await sig("rumour", BANCHERO, "buzz", DAY, "2026-11-23T14:10:00Z", "a post says he is playing through a sore ankle", "unreviewed", "https://x.test/p/9");
  await q(`insert into markets (league, game_id, kind, title, player_id, stat, strike, yes_bid_cents, yes_ask_cents, status) values
    ('nba',$1,'player_stat','t',$2,'threes',4,47,49,'open'), ('nba',$1,'player_stat','t',$3,'rebounds',10,48,50,'open'),
    ('nba',$4,'player_stat','t',$5,'assists',6,53,55,'open'), ('nba',$4,'player_stat','t',$6,'points',15,53,55,'open')`, [G1, HIELD, BARNES, G2, BANCHERO, JONES]);
  const short = async (pos: number, p: string, team: number, g: string, angle: string, stat: string, sigs: number[]) => {
    const id = (await q<{ id: string }>(
      `insert into story_shortlist (run_id, slate_date, league, position, player_id, game_id, team_id, angle, stat, score, summary, market_id, slot_kind)
       values ($1,$2,'nba',$3,$4,$5,$6,$7,$8,10,$9,(select id from markets where player_id = $4 limit 1),'quota') returning id`, [run, DAY, pos, p, g, team, angle, stat, `${angle} story`]))[0]!.id;
    for (const s of sigs) await q(`insert into story_shortlist_signals (shortlist_id, signal_id) values ($1, $2)`, [id, s]);
  };
  await short(1, HIELD, 1, G1, "hot_streak", "3pm", [S.form!]);
  await short(2, HIELD, 1, G1, "backup_steps_in", "3pm", [S.powell!]);
  await short(3, BARNES, 2, G1, "hot_streak", "reb", [S.oldForm!]);
  await short(4, BANCHERO, 3, G2, "back_from_injury", "ast", [S.rumour!]);
  await short(5, JONES, 4, G2, "backup_steps_in", "pts", []);
});
beforeEach(async () => { await q(`update app_config set value = '200' where key = 'blurb_max_chars'`); });
after(async () => { await db?.end(); });

/** The rules allow exactly cards_per_day picks (or fewer on a thin slate), so each test sets it to the number it picks. */
const run = async (positions: number[], writer: ReturnType<typeof fakeWriter>, alerts: string[] = []) => {
  await config(positions.length);
  return runCuration(db!, { alert: async (m) => { alerts.push(m); }, date: DAY, curator: scriptedCurator(async () => picks(...positions)), blurbWriter: writer, styleGuide: GUIDE });
};
const stepRows = (runId: number, step: string) => q<{ attempt: number; accepted: boolean; violations: { kind: string }[]; request: { styleGuide?: string } }>(
  `select attempt, accepted, violations, request from curation_attempts where run_id = $1 and step = $2 order by attempt`, [runId, step]);
const outputs = async (runId: number) => (await q<{ outputs: { picks: { storyId: string; blurb: string; blurbFacts: { level: string; signals: { id: number; via: string; observedAt: string; slateDate: string }[]; market: Record<string, unknown> } }[]; levels: Record<string, number> } }>(
  `select outputs from pipeline_runs where id = $1`, [runId]))[0]!.outputs;

test("blurbs: each pick gets a blurb, stored with the facts it cites, and the guide it was written under is on the record", { skip }, async () => {
  const w = fakeWriter();
  const r = await run([1, 3], w);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const out = await outputs(r.runId);
  assert.deepEqual(out.picks.map((p) => p.blurb), ["Buddy Hield is the story tonight.", "Scottie Barnes is the story tonight."]);
  assert.deepEqual(out.picks[0]!.blurbFacts.signals.map((s) => [s.id, s.via]), [[S.form, "own"]]);
  assert.equal(out.picks[0]!.blurbFacts.market.strike, 4);
  assert.deepEqual(out.picks[0]!.blurbFacts.market, { player: "Buddy Hield", team: "Bulls", opponent: "Raptors", home: false, stat: "threes", strike: 4, yesPriceCents: 49 });
  const pick = await stepRows(r.runId, "pick"), blurb = await stepRows(r.runId, "blurb");
  assert.deepEqual([pick.map((a) => a.accepted), blurb.map((a) => a.accepted)], [[true], [true]]);
  assert.equal(blurb[0]!.request.styleGuide, GUIDE, "STO-77: each run stores what the writer was given, the style guide included");
  assert.ok(!JSON.stringify(w.seen[0]).includes("why a fan cares"), "the curator's reason isn't passed to the writer: uncited claims can't leak into a blurb");
});

test("blurbs: the writer is shown a dated signal with its own slateDate and observedAt, and the stored fact keeps the date", { skip }, async () => {
  const w = fakeWriter();
  const r = await run([3], w);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const shown = w.seen[0]!.input.stories[0]!.signals[0]!;
  assert.deepEqual([shown.slateDate, shown.observedAt], [OLD_DAY, "2026-11-20T15:00:00.000Z"]);
  assert.equal((await outputs(r.runId)).picks[0]!.blurbFacts.signals[0]!.slateDate, OLD_DAY);
});

test("blurbs: Hield, picked on hot_streak, is shown Powell's absence as the same player's other angle, and the stored fact says where it came from", { skip }, async () => {
  const w = fakeWriter([(r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Hield is hot from deep, and with Norman Powell out more shots should come his way.", signalIds: [S.form, S.powell] }] })]);
  await config(1);
  const curator = scriptedCurator(async () => picks(1));
  const r = await runCuration(db!, { alert: async () => {}, date: DAY, curator, blurbWriter: w, styleGuide: GUIDE });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  // the curator saw the other angle too, and the other player's signals never cross over
  const seenByCurator = curator.seen[0]!.input.stories;
  assert.deepEqual(seenByCurator.filter((s) => s.playerName === "Buddy Hield").map((s) => [s.angle, s.otherAngleSignals.map((g) => [g.id, g.angle])]),
    [["hot_streak", [[S.powell, "backup_steps_in"]]], ["backup_steps_in", [[S.form, "hot_streak"]]]]);
  assert.deepEqual(seenByCurator.filter((s) => s.playerName !== "Buddy Hield").flatMap((s) => s.otherAngleSignals), []);
  assert.deepEqual(w.seen[0]!.input.stories[0]!.otherAngleSignals.map((g) => [g.id, g.angle]), [[S.powell, "backup_steps_in"]]);
  assert.deepEqual((await outputs(r.runId)).picks[0]!.blurbFacts.signals.map((s) => [s.id, s.via]), [[S.form, "own"], [S.powell, "other_angle:backup_steps_in"]]);
});

test("blurbs: an unreviewed signal never reaches the writer, so a story with only that is written market-only", { skip }, async () => {
  const w = fakeWriter();
  const r = await run([4], w);
  assert.equal(r.status, "ok");
  const s = w.seen[0]!.input.stories[0]!;
  assert.deepEqual([s.level, s.signals, s.otherAngleSignals], ["market_only", [], []]);
  assert.ok(!JSON.stringify(w.seen).includes("sore ankle"), "an unreviewed post never reaches the blurb prompt");
});

test("blurbs: market-only level (ADR-024 rule 7.3): no signals at all gives a thinner blurb from the market facts, and it is recorded as such", { skip }, async () => {
  const w = fakeWriter();
  const r = await run([5, 1], w);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const out = await outputs(r.runId);
  assert.deepEqual(out.levels, { full: 1, market_only: 1 });
  assert.deepEqual([out.picks[0]!.blurbFacts.level, out.picks[0]!.blurbFacts.signals, out.picks[0]!.blurb], ["market_only", [], "Tyler Herro and the Heat take on the Magic."]);
});

test("blurbs: every attempt fails: one alert, the run is failed, the picks' and the blurbs' attempts are kept, nothing is posted", { skip }, async () => {
  const bad = (r: BlurbRequest) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Smash it.", signalIds: [S.form] }] });
  const posted: string[] = [], alerts: string[] = [];
  await config(1);
  const out = await curateJob(async (m) => { alerts.push(m); }, { post: async (m) => { posted.push(m); } }, DAY,
    scriptedCurator(async () => picks(1)), fakeWriter([bad, bad, bad]), GUIDE).run(db!) as { status: string; runId: number };
  assert.equal(out.status, "failed");
  assert.deepEqual(posted, []);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /Blurbs failed for 2026-11-23: 3 attempts/);
  assert.match(alerts[0]!, /banned_word/);
  const run = (await q<{ status: string; error: string; outputs: unknown }>(`select status, error, outputs from pipeline_runs where id = $1`, [out.runId]))[0]!;
  assert.equal(run.status, "failed");
  assert.match(run.error, /every one of 3 blurb attempts/);
  assert.deepEqual([(await stepRows(out.runId, "pick")).map((a) => a.accepted), (await stepRows(out.runId, "blurb")).map((a) => a.accepted)], [[true], [false, false, false]]);
});

test("blurbs: a writer that errors is retried like any failed attempt, and the error is kept", { skip }, async () => {
  const w = fakeWriter([new Error("HTTP 529"), cleanAnswer]);
  const r = await run([1], w);
  assert.equal(r.status, "ok");
  const rows = await q<{ error: string | null; accepted: boolean }>(`select error, accepted from curation_attempts where run_id = $1 and step = 'blurb' order by attempt`, [(r as { runId: number }).runId]);
  assert.deepEqual(rows.map((x) => [x.error, x.accepted]), [["HTTP 529", false], [null, true]]);
});

test("blurbs: the length limit given to the writer is the blurb_max_chars setting", { skip }, async () => {
  await q(`update app_config set value = '40' where key = 'blurb_max_chars'`);
  const w = fakeWriter([(r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Hield has been hot from deep.", signalIds: [S.form] }] })]);
  assert.equal((await run([1], w)).status, "ok");
  assert.equal(w.seen[0]!.rules.maxChars, 40);
});

test("blurbs: safe to re-run: each run keeps its own blurb attempts and its own one accepted set, and the shortlist is untouched", { skip }, async () => {
  const before = (await q<{ n: string }>(`select count(*) n from story_shortlist`))[0]!.n;
  const r1 = await run([1], fakeWriter()), r2 = await run([1], fakeWriter());
  assert.ok(r1.status === "ok" && r2.status === "ok" && r1.runId !== r2.runId);
  const per = await q<{ run_id: string; n: string; acc: string }>(
    `select run_id, count(*) n, count(*) filter (where accepted) acc from curation_attempts where step = 'blurb' and run_id = any($1::bigint[]) group by run_id order by run_id`,
    [[(r1 as { runId: number }).runId, (r2 as { runId: number }).runId]]);
  assert.deepEqual(per.map((x) => [x.n, x.acc]), [["1", "1"], ["1", "1"]]);
  assert.equal((await q<{ n: string }>(`select count(*) n from story_shortlist`))[0]!.n, before);
});

test("blurbs: the #testing post shows each blurb, the signal ids it cites (the other angle's marked), and the level mix", { skip }, async () => {
  const posted: string[] = [];
  await config(2);
  const w = fakeWriter([(r) => ({ blurbs: [
    { storyId: r.input.stories[0]!.storyId, blurb: "Hield is hot from deep, and with Powell out more shots come his way.", signalIds: [S.form, S.powell] },
    { storyId: r.input.stories[1]!.storyId, blurb: "Tyler Herro and the Heat take on the Magic.", signalIds: [] },
  ] })]);
  const out = await curateJob(async () => {}, { post: async (m) => { posted.push(m); } }, DAY, scriptedCurator(async () => picks(1, 5)), w, GUIDE).run(db!) as { status: string };
  assert.equal(out.status, "ok");
  const text = posted.join("\n");
  assert.match(text, /> Hield is hot from deep, and with Powell out more shots come his way\./);
  assert.ok(text.includes(`cites ${S.form}, ${S.powell} (same player, other angle) · full`));
  assert.match(text, /cites nothing \(market only\) · market_only/);
  assert.match(text, /Blurbs: full 1, market_only 1\./);
  assert.ok(posted.every((m) => m.length <= 1900), "each Discord message stays under the limit");
});
});
