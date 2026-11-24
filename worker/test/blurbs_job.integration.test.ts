// Blurbs through the curation job (STO-77, STO-91, STO-120) against real Postgres with a FAKE curator and a FAKE writer: no network.
// The loader, the rules, the stored attempts and the #testing post are real; only Claude is scripted.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { runCuration } from "../src/jobs/curate.js";
import { curateJob } from "../src/jobs/index.js";
import type { CurationRequest } from "../src/sources/curate.js";
import type { Curator } from "../src/sources/types.js";
import { freshDb } from "./helpers/testDb.js";
import { fakeWriter, cleanAnswer, GUIDE } from "./helpers/blurbs.js";
import type { BlurbRequest } from "../src/sources/claudeBlurbs.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
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

test("a good run: each pick gets a blurb, stored with the facts it cites, and the guide it was written under is on the record", { skip }, async () => {
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

test("STO-91: the writer is shown a dated signal with its own slateDate and observedAt, and a blurb can't pass it off as breaking news", { skip }, async () => {
  const w = fakeWriter([
    (r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Breaking: Barnes is grabbing ten boards a night.", signalIds: [S.oldForm] }] }),
    (r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Barnes has grabbed ten boards a night over his last five.", signalIds: [S.oldForm] }] }),
  ]);
  const r = await run([3], w);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const shown = w.seen[0]!.input.stories[0]!.signals[0]!;
  assert.deepEqual([shown.slateDate, shown.observedAt], [OLD_DAY, "2026-11-20T15:00:00.000Z"]);
  assert.deepEqual((await stepRows(r.runId, "blurb")).map((a) => [a.accepted, a.violations.map((v) => v.kind)]), [[false, ["dated_phrasing"]], [true, []]]);
  assert.match(w.seen[1]!.feedback.join(" "), /don't word it as breaking/);
  assert.equal((await outputs(r.runId)).picks[0]!.blurbFacts.signals[0]!.slateDate, OLD_DAY, "the date is kept on the stored fact too");
});

test("STO-120: Hield, picked on hot_streak, is shown Powell's absence as 'same player, other angle', and cites it only by that signal's id", { skip }, async () => {
  const w = fakeWriter([
    // attempt 1 cites an id that isn't his at all (Barnes's); attempt 2 cites his own form and the other angle's absence
    (r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Hield is hot and Powell is out.", signalIds: [S.oldForm] }] }),
    (r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Hield is hot from deep, and with Norman Powell out more shots should come his way.", signalIds: [S.form, S.powell] }] }),
  ]);
  await config(1);
  const curator = scriptedCurator(async () => picks(1));
  const r = await runCuration(db!, { alert: async () => {}, date: DAY, curator, blurbWriter: w, styleGuide: GUIDE });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  // the curator saw the other angle too (STO-120 for the picking step)
  const seenByCurator = curator.seen[0]!.input.stories.filter((s) => s.playerName === "Buddy Hield");
  assert.deepEqual(seenByCurator.map((s) => [s.angle, s.otherAngleSignals.map((g) => [g.id, g.angle])]), [["hot_streak", [[S.powell, "backup_steps_in"]]], ["backup_steps_in", [[S.form, "hot_streak"]]]]);
  // the writer saw it on the story it was asked to write
  assert.deepEqual(w.seen[0]!.input.stories[0]!.otherAngleSignals.map((g) => [g.id, g.angle]), [[S.powell, "backup_steps_in"]]);
  assert.deepEqual((await stepRows(r.runId, "blurb")).map((a) => [a.accepted, a.violations.map((v) => v.kind)]), [[false, ["unknown_signal"]], [true, []]]);
  assert.deepEqual((await outputs(r.runId)).picks[0]!.blurbFacts.signals.map((s) => [s.id, s.via]), [[S.form, "own"], [S.powell, "other_angle:backup_steps_in"]]);
});

test("trust: an unreviewed signal is never shown to the writer, so a story with only that is written market-only and can't cite it", { skip }, async () => {
  const w = fakeWriter([
    (r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Banchero is playing through a sore ankle.", signalIds: [S.rumour] }] }),
    (r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Banchero and the Magic host the Heat tonight.", signalIds: [] }] }),
  ]);
  const r = await run([4], w);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const s = w.seen[0]!.input.stories[0]!;
  assert.deepEqual([s.level, s.signals, s.otherAngleSignals], ["market_only", [], []]);
  assert.ok(!JSON.stringify(w.seen).includes("sore ankle"), "an unreviewed post never reaches the blurb prompt");
  assert.deepEqual((await stepRows(r.runId, "blurb")).map((a) => a.violations.map((v) => v.kind)), [["unknown_signal"], []]);
});

test("market-only level (ADR-024 rule 7.3): no signals at all gives a thinner blurb from the market facts, and it is recorded as such", { skip }, async () => {
  const w = fakeWriter();
  const r = await run([5, 1], w);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const out = await outputs(r.runId);
  assert.deepEqual(out.levels, { full: 1, market_only: 1 });
  assert.deepEqual([out.picks[0]!.blurbFacts.level, out.picks[0]!.blurbFacts.signals, out.picks[0]!.blurb], ["market_only", [], "Tyler Herro and the Heat take on the Magic."]);
});

test("every blurb attempt fails: one alert, the run is failed, the picks' and the blurbs' attempts are kept, nothing is posted", { skip }, async () => {
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

test("a writer that errors is retried like any failed attempt, and the error is kept", { skip }, async () => {
  const w = fakeWriter([new Error("HTTP 529"), cleanAnswer]);
  const r = await run([1], w);
  assert.equal(r.status, "ok");
  const rows = await q<{ error: string | null; accepted: boolean }>(`select error, accepted from curation_attempts where run_id = $1 and step = 'blurb' order by attempt`, [(r as { runId: number }).runId]);
  assert.deepEqual(rows.map((x) => [x.error, x.accepted]), [["HTTP 529", false], [null, true]]);
});

test("the blurb length limit is the blurb_max_chars setting", { skip }, async () => {
  await q(`update app_config set value = '40' where key = 'blurb_max_chars'`);
  const w = fakeWriter([
    (r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Hield is hitting four threes a night over his last five games.", signalIds: [S.form] }] }),
    (r) => ({ blurbs: [{ storyId: r.input.stories[0]!.storyId, blurb: "Hield has been hot from deep.", signalIds: [S.form] }] }),
  ]);
  const r = await run([1], w);
  assert.equal(r.status, "ok");
  assert.equal(w.seen[0]!.rules.maxChars, 40);
  assert.deepEqual((await stepRows((r as { runId: number }).runId, "blurb")).map((a) => a.violations.map((v) => v.kind)), [["length"], []]);
});

test("safe to re-run: each run keeps its own blurb attempts and its own one accepted set, and the shortlist is untouched", { skip }, async () => {
  const before = (await q<{ n: string }>(`select count(*) n from story_shortlist`))[0]!.n;
  const r1 = await run([1], fakeWriter()), r2 = await run([1], fakeWriter());
  assert.ok(r1.status === "ok" && r2.status === "ok" && r1.runId !== r2.runId);
  const per = await q<{ run_id: string; n: string; acc: string }>(
    `select run_id, count(*) n, count(*) filter (where accepted) acc from curation_attempts where step = 'blurb' and run_id = any($1::bigint[]) group by run_id order by run_id`,
    [[(r1 as { runId: number }).runId, (r2 as { runId: number }).runId]]);
  assert.deepEqual(per.map((x) => [x.n, x.acc]), [["1", "1"], ["1", "1"]]);
  assert.equal((await q<{ n: string }>(`select count(*) n from story_shortlist`))[0]!.n, before);
});

test("the #testing post shows each blurb, the signal ids it cites (the other angle's marked), and the level mix", { skip }, async () => {
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
