// Curation against real Postgres (STO-11): loading the shortlist's signals and ladders, running a fake curator under
// the rules, and storing every attempt so a pick traces back to what the model saw. The curator is fake: no network.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { loadCurationConfig, ConfigError } from "../src/lib/config.js";
import { loadCurationInput, type CurationEntry } from "../src/sources/curationInput.js";
import { curateWithRules, type CurationRequest } from "../src/sources/curate.js";
import { storeAttempts } from "../src/sources/curationStore.js";
import type { CurationRules } from "../src/domain/curationRules.js";
import type { Curator } from "../src/sources/types.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const DBNAME = "storyline_curation_test";
const [P1, P2] = ["00000000-0000-0000-0000-0000000000c1", "00000000-0000-0000-0000-0000000000c2"];
const GAME = "00000000-0000-0000-0000-0000000000d1";
const DAY = "2026-11-23";
let db: Db | null = null;
let sig1 = 0, sig2 = 0;

const RULES: CurationRules = { n: 2, bandMin: 25, bandMax: 75, maxPerGame: 2, maxPerStat: 2, maxAttempts: 3 };
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows as T[];
const newRun = async () => (await q<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('curation', $1, 'ok') returning id`, [DAY]))[0]!.id;
/** Insert one market on P's ladder; price and status vary per test case. */
const market = (player: string, stat: string, strike: number, bid: number | null, ask: number | null, status = "open") =>
  q(`insert into markets (league, game_id, kind, title, player_id, stat, strike, yes_bid_cents, yes_ask_cents, status)
     values ('nba', $1, 'player_stat', $2, $3, $4, $5, $6, $7, $8::market_status)`, [GAME, `${player} ${stat} ${strike}+`, player, stat, strike, bid, ask, status]);

before(async () => {
  db = await freshDb(DBNAME);
  if (!db) return;
  await q(`insert into teams (id, league, name, abbr) values (1, 'nba', 'Knicks', 'NYK'), (2, 'nba', 'Raptors', 'TOR')`);
  await q(`insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at)
           values ($1, 'nba', $2, 2, 1, '2026-11-23T23:30:00Z')`, [GAME, DAY]);
  await q(`insert into players (id, league, full_name, team_id) values ($1, 'nba', 'Jalen Brunson', 1), ($2, 'nba', 'Scottie Barnes', 2)`, [P1, P2]);
  const run = await newRun();
  const s = (player: string, key: string, summary: string, trust: string) => q<{ id: string }>(
    `insert into signals (source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id)
     values ('espn', 'stat', $1, $2, $3, $4, '{"quote":"q"}', now(), $5::signal_trust, $6) returning id`, [DAY, player, key, summary, trust, run]);
  sig1 = Number((await s(P1, "form:pts", "last 5: 31, 28, 35, 30, 29", "verified"))[0]!.id);
  sig2 = Number((await s(P2, "form:reb", "last 5: 9, 11, 10, 12, 10", "verified"))[0]!.id);
  // P1's points ladder: 20 (80c), 25 (60c), 30 (40c) are good; 35 is closed; 40 has a 15c spread; 45 has no ask; 50 has no bid.
  await market(P1, "points", 20, 78, 80); await market(P1, "points", 25, 58, 60); await market(P1, "points", 30, 38, 40);
  await market(P1, "points", 35, 28, 30, "closed"); await market(P1, "points", 40, 5, 20); await market(P1, "points", 45, 10, null); await market(P1, "points", 50, null, 12);
  await market(P1, "rebounds", 8, 48, 50);                     // same player, other stat: not on a points ladder
  await market(P2, "rebounds", 10, 48, 50); await market(P2, "rebounds", 12, 28, 30);
});
after(async () => { await db?.end(); });

const E1: CurationEntry = { id: 101, playerId: P1, gameId: GAME, angle: "hot_streak", stat: "pts", summary: "Hot streak: 30.6 PTS", signalIds: [] };
const E2: CurationEntry = { id: 102, playerId: P2, gameId: GAME, angle: "backup_steps_in", stat: "reb", summary: "Backup stepping in", signalIds: [] };
const entries = (): CurationEntry[] => [{ ...E1, signalIds: [sig1] }, { ...E2, signalIds: [sig2] }];

test("loads each story's signal text and its player's open, tight-spread ladder for that stat", { skip }, async () => {
  const input = await loadCurationInput(db!, DAY, entries(), 5);
  assert.equal(input.slateDate, DAY);
  const [a, b] = input.stories;
  assert.equal(a!.storyId, "101");
  assert.equal(a!.playerName, "Jalen Brunson");
  assert.deepEqual(a!.signals, [{ id: sig1, source: "espn", kind: "stat", trust: "verified", summary: "last 5: 31, 28, 35, 30, 29" }]);
  // closed, wide-spread, no-ask and no-bid markets are not rungs; the other stat is not on this ladder
  assert.deepEqual(a!.ladder.map((l) => [l.strike, l.yesPriceCents]), [[20, 80], [25, 60], [30, 40]]);
  assert.match(a!.ladder[0]!.marketId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(b!.ladder.map((l) => [l.strike, l.yesPriceCents]), [[10, 50], [12, 30]]);
});

test("the spread limit comes from config: a looser limit lets the 15c-spread strike in", { skip }, async () => {
  const input = await loadCurationInput(db!, DAY, [{ ...E1, signalIds: [sig1] }], 15);
  assert.deepEqual(input.stories[0]!.ladder.map((l) => l.strike), [20, 25, 30, 40]);
});

test("a shortlist entry pointing at a signal or player that isn't there fails loudly", { skip }, async () => {
  await assert.rejects(loadCurationInput(db!, DAY, [{ ...E1, signalIds: [987654] }], 5), /no signal 987654/);
  await assert.rejects(loadCurationInput(db!, DAY, [{ ...E1, playerId: "00000000-0000-0000-0000-00000000dead", signalIds: [] }], 5), /no player/);
});

/** A curator that answers from a script and records what it was shown. */
const scripted = (answers: unknown[]): Curator<CurationRequest, unknown> & { seen: CurationRequest[] } => {
  const seen: CurationRequest[] = [];
  return { name: "fake", seen, async curate(r) { seen.push(r); const a = answers[seen.length - 1]; if (a instanceof Error) throw a; return a; } };
};
const pickOf = (input: Awaited<ReturnType<typeof loadCurationInput>>, storyId: string, strike: number) =>
  ({ storyId, marketId: input.stories.find((s) => s.storyId === storyId)!.ladder.find((l) => l.strike === strike)!.marketId, reason: "He is hot" });

test("end to end: the model is shown only in-band strikes, the answer is stored, and the pick traces to what it saw", { skip }, async () => {
  const input = await loadCurationInput(db!, DAY, entries(), 5);
  const good = { ranking: ["101", "102"], picks: [pickOf(input, "101", 30), pickOf(input, "102", 12)] };
  const c = scripted([good]);
  const r = await curateWithRules(c, input, RULES, async () => assert.fail("no alert expected"));
  assert.equal(r.ok, true);
  assert.deepEqual(c.seen[0]!.input.stories[0]!.ladder.map((l) => l.strike), [25, 30]);   // 20 (80c) was hidden
  const runId = await newRun();
  await storeAttempts(db!, runId, r.attempts);
  const rows = await q<{ accepted: boolean; request: CurationRequest; output: typeof good }>(`select accepted, request, output from curation_attempts where run_id = $1`, [runId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.accepted, true);
  assert.deepEqual(rows[0]!.output, good);
  // trace: for the chosen market, find exactly what the model was shown for that story, signals included
  const chosen = rows[0]!.output.picks[0]!;
  const seen = rows[0]!.request.input.stories.find((s) => s.storyId === chosen.storyId)!;
  assert.deepEqual(seen.ladder.map((l) => l.marketId).includes(chosen.marketId), true);
  assert.deepEqual(seen.signals.map((s) => s.id), [sig1]);
  assert.equal(rows[0]!.request.rules.n, 2);
});

test("a rejected attempt is stored too, with its reasons, and the retry that passed is the accepted one", { skip }, async () => {
  const input = await loadCurationInput(db!, DAY, entries(), 5);
  const hidden = input.stories[0]!.ladder.find((l) => l.strike === 20)!.marketId;   // 80c: never shown
  const bad = { ranking: ["101", "102"], picks: [{ storyId: "101", marketId: hidden, reason: "r" }, pickOf(input, "102", 12)] };
  const good = { ranking: ["102", "101"], picks: [pickOf(input, "102", 12), pickOf(input, "101", 25)] };
  const c = scripted([bad, good]);
  const r = await curateWithRules(c, input, RULES, async () => {});
  assert.equal(r.ok, true);
  const runId = await newRun();
  await storeAttempts(db!, runId, r.attempts);
  const rows = await q<{ attempt: number; accepted: boolean; violations: { kind: string }[] }>(`select attempt, accepted, violations from curation_attempts where run_id = $1 order by attempt`, [runId]);
  assert.deepEqual(rows.map((x) => x.accepted), [false, true]);
  assert.deepEqual(rows[0]!.violations.map((v) => v.kind), ["out_of_band"]);
});

test("when every attempt fails: one alert, nothing accepted, every attempt still stored", { skip }, async () => {
  const input = await loadCurationInput(db!, DAY, entries(), 5);
  const c = scripted([{ nope: 1 }, new Error("HTTP 529"), "just words"]);
  const alerts: string[] = [];
  const r = await curateWithRules(c, input, RULES, async (m) => { alerts.push(m); });
  assert.equal(r.ok, false);
  assert.equal(alerts.length, 1);
  const runId = await newRun();
  await storeAttempts(db!, runId, r.attempts);
  const rows = await q<{ accepted: boolean; error: string | null; output: unknown }>(`select accepted, error, output from curation_attempts where run_id = $1 order by attempt`, [runId]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => !x.accepted));
  assert.equal(rows[1]!.error, "HTTP 529");
  assert.equal(rows[1]!.output, null);
  assert.equal(rows[2]!.output, "just words");    // a non-JSON answer is kept as the text it was
});

test("storing the same run's attempts twice changes nothing, and a re-run (a new run) stores its own", { skip }, async () => {
  const input = await loadCurationInput(db!, DAY, entries(), 5);
  const good = { ranking: ["101", "102"], picks: [pickOf(input, "101", 30), pickOf(input, "102", 12)] };
  const r = await curateWithRules(scripted([good]), input, RULES, async () => {});
  const run1 = await newRun(), run2 = await newRun();
  await storeAttempts(db!, run1, r.attempts);
  await storeAttempts(db!, run1, r.attempts);
  await storeAttempts(db!, run2, r.attempts);
  const n = async (run: number) => Number((await q<{ n: string }>(`select count(*) n from curation_attempts where run_id = $1`, [run]))[0]!.n);
  assert.deepEqual([await n(run1), await n(run2)], [1, 1]);
  await storeAttempts(db!, run1, []);    // nothing to store is fine
});

test("curation settings load from app_config, and a missing one names itself", { skip }, async () => {
  const c = await loadCurationConfig(db!);
  assert.equal(c.cardsPerDay, 10);
  assert.equal(c.curationMaxAttempts, 3);
  assert.equal(typeof c.curationModel, "string");
  await q(`delete from app_config where key = 'curation_max_per_game'`);
  await assert.rejects(loadCurationConfig(db!), (e: Error) => e instanceof ConfigError && /missing curation_max_per_game/.test(e.message));
});
