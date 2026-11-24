// qa (STO-11, PR #44): attacks on the curation job against real Postgres, with fake curators. No network.
// A test that fails here is a finding for the author; a passing one is labelled "coverage".

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { runCuration } from "../src/jobs/curate.js";
import { fakeWriter, GUIDE } from "./helpers/blurbs.js";
import { loadCurationInput } from "../src/sources/curationInput.js";
import type { CurationRequest } from "../src/sources/curate.js";
import type { Curator } from "../src/sources/types.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const DBNAME = "storyline_curation_qa_test";
const [P1, P2, P3] = ["00000000-0000-0000-0000-00000000a0e1", "00000000-0000-0000-0000-00000000a0e2", "00000000-0000-0000-0000-00000000a0e3"];
const [G1, G2] = ["00000000-0000-0000-0000-00000000a0f1", "00000000-0000-0000-0000-00000000a0f2"];
const DAY = "2026-11-23";
let db: Db | null = null;
const ids: { s1: string; s2: string; m1: string; m2: string } = { s1: "", s2: "", m1: "", m2: "" };

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows as T[];

before(async () => {
  db = await freshDb(DBNAME);
  if (!db) return;
  await q(`insert into teams (id, league, name, abbr) values (1,'nba','Knicks','NYK'), (2,'nba','Raptors','TOR'), (3,'nba','Heat','MIA'), (4,'nba','Magic','ORL')`);
  await q(`insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values
    ($1,'nba',$3,2,1,'2026-11-23T23:30:00Z'), ($2,'nba',$3,4,3,'2026-11-23T23:30:00Z')`, [G1, G2, DAY]);
  await q(`insert into players (id, league, full_name, team_id) values ($1,'nba','Jalen Brunson',1), ($2,'nba','Scottie Barnes',2), ($3,'nba','Paolo Banchero',4)`, [P1, P2, P3]);
  const run = (await q<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('story', $1, 'ok') returning id`, [DAY]))[0]!.id;
  const market = async (g: string, p: string, stat: string, strike: number, bid: number, ask: number) => (await q<{ id: string }>(
    `insert into markets (league, game_id, kind, title, player_id, stat, strike, yes_bid_cents, yes_ask_cents, status)
     values ('nba',$1,'player_stat','t',$2,$3,$4,$5,$6,'open') returning id`, [g, p, stat, strike, bid, ask]))[0]!.id;
  ids.m1 = await market(G1, P1, "points", 25, 58, 60);
  ids.m2 = await market(G1, P2, "rebounds", 10, 48, 50);
  const m3 = await market(G2, P3, "assists", 6, 93, 95);           // P3's only rung is out of band: an empty in-band ladder
  const short = async (pos: number, p: string, team: number, g: string, angle: string, stat: string, m: string) => String((await q<{ id: string }>(
    `insert into story_shortlist (run_id, slate_date, league, position, player_id, game_id, team_id, angle, stat, score, summary, market_id, slot_kind)
     values ($1,$2,'nba',$3,$4,$5,$6,$7,$8,50,'s',$9,'quota') returning id`, [run, DAY, pos, p, g, team, angle, stat, m]))[0]!.id);
  ids.s1 = await short(1, P1, 1, G1, "hot_streak", "pts", ids.m1);
  ids.s2 = await short(2, P2, 2, G1, "backup_steps_in", "reb", ids.m2);
  await short(3, P3, 4, G2, "back_from_injury", "ast", m3);
  await q(`update app_config set value = '2' where key = 'cards_per_day'`);
});
after(async () => { await db?.end(); });

const answer = (reason1 = "Five straight 28+ games") => ({
  ranking: [ids.s1, ids.s2],
  picks: [{ storyId: ids.s1, marketId: ids.m1, reason: reason1 }, { storyId: ids.s2, marketId: ids.m2, reason: "Starting for the star" }],
});
const fake = (a: unknown, delayMs = 0): Curator<CurationRequest, unknown> =>
  ({ name: "fake", async curate() { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return a; } });
const attemptsOf = async (runId: number | undefined) =>
  q<{ attempt: number; accepted: boolean }>(`select attempt, accepted from curation_attempts where run_id = $1 and step = 'pick' order by attempt`, [runId]);

// ---------------------------------------------------------------- findings (expected to FAIL until fixed)

// attacks: model output Postgres jsonb can't hold (U+0000). The reason passes every rule, then storeAttempts throws:
// the job crashes instead of returning ok/failed, and every attempt of the run (the accepted one included) is lost.
test("qa: an answer containing U+0000 doesn't crash the job or lose the run's attempts", { skip }, async () => {
  let r: Awaited<ReturnType<typeof runCuration>> | undefined, err: unknown;
  try { r = await runCuration(db!, { alert: async () => {}, date: DAY, curator: fake(answer("Five straight\u0000 28+ games")), blurbWriter: fakeWriter(), styleGuide: GUIDE }); } catch (e) { err = e; }
  assert.equal(err, undefined, `runCuration threw: ${(err as Error)?.message}`);
  assert.ok((await attemptsOf((r as { runId: number }).runId)).length >= 1, "the attempt isn't stored, so the pick can't be traced");
});

// attacks: same storage path with a rejected answer: one bad attempt (lone surrogate / NUL) must not erase the others.
test("qa: a rejected answer Postgres can't store doesn't erase the run's other attempts", { skip }, async () => {
  const answers = [{ ranking: ["\u0000"], picks: [] }, answer()];
  let i = 0;
  const c: Curator<CurationRequest, unknown> = { name: "fake", async curate() { return answers[i++]; } };
  let r: Awaited<ReturnType<typeof runCuration>> | undefined, err: unknown;
  try { r = await runCuration(db!, { alert: async () => {}, date: DAY, curator: c, blurbWriter: fakeWriter(), styleGuide: GUIDE }); } catch (e) { err = e; }
  assert.equal(err, undefined, `runCuration threw: ${(err as Error)?.message}`);
  assert.equal(r?.status, "ok");
  assert.equal((await attemptsOf((r as { runId: number }).runId)).length, 2);
});

// ---------------------------------------------------------------- coverage (expected to PASS)

// coverage: two runs at the same moment (two pool connections): each gets its own run, attempts and one accepted answer.
test("qa coverage: two concurrent runs don't share or double attempts", { skip }, async () => {
  const [a, b] = await Promise.all([
    runCuration(db!, { alert: async () => {}, date: DAY, curator: fake(answer(), 50), blurbWriter: fakeWriter(), styleGuide: GUIDE }),
    runCuration(db!, { alert: async () => {}, date: DAY, curator: fake(answer(), 50), blurbWriter: fakeWriter(), styleGuide: GUIDE }),
  ]);
  assert.ok(a.status === "ok" && b.status === "ok");
  assert.notEqual(a.runId, b.runId);
  for (const r of [a, b]) assert.deepEqual((await attemptsOf(r.runId)).map((x) => [x.attempt, x.accepted]), [[1, true]]);
});

// coverage: a story whose ladder has nothing in band is loaded with its (out-of-band) ladder, hidden from the model,
// and not required in the ranking; the pick count ignores that player.
test("qa coverage: a story with no in-band strike is loaded, hidden, and not counted", { skip }, async () => {
  const seen: CurationRequest[] = [];
  const c: Curator<CurationRequest, unknown> = { name: "fake", async curate(req) { seen.push(req); return answer(); } };
  await q(`update app_config set value = '3' where key = 'cards_per_day'`);
  try {
    const r = await runCuration(db!, { alert: async () => {}, date: DAY, curator: c, blurbWriter: fakeWriter(), styleGuide: GUIDE });
    assert.equal(r.status, "ok");
    assert.deepEqual(seen[0]!.input.stories.map((s) => s.storyId), [ids.s1, ids.s2]);
  } finally { await q(`update app_config set value = '2' where key = 'cards_per_day'`); }
});

// coverage: an entry listing the same signal id twice yields the signal twice (the table's PK prevents it from the store).
test("qa coverage: the loader tolerates a repeated signal id and an entry with no signals", { skip }, async () => {
  const run = (await q<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('qa', $1, 'ok') returning id`, [DAY]))[0]!.id;
  const sig = Number((await q<{ id: string }>(`insert into signals (source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id)
    values ('espn','stat',$1,$2,'qa:k','fact','{"quote":"q"}', now(), 'verified', $3) returning id`, [DAY, P1, run]))[0]!.id);
  const input = await loadCurationInput(db!, DAY, [
    { id: 1, playerId: P1, gameId: G1, angle: "hot_streak", stat: "pts", summary: "s", signalIds: [sig, sig] },
    { id: 2, playerId: P2, gameId: G1, angle: "hot_streak", stat: "reb", summary: "s", signalIds: [] },
  ], 5);
  assert.deepEqual(input.stories.map((s) => s.signals.length), [2, 0]);
  await assert.rejects(q(`insert into story_shortlist_signals (shortlist_id, signal_id) values ($1, $2), ($1, $2)`, [ids.s1, sig]));
});
