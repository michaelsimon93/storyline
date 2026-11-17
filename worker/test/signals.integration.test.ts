// The signals table and storeSignals against real Postgres (STO-10, merged from three files in STO-86):
//   1. the store is safe to re-run and to race,
//   2. QA on part 2 (PR #32): failures after a store, overlapping concurrent runs, big and bad batches,
//   3. QA on the sightings fix: every run records what it saw, which is what the ESPN-down fallback reads.
// The runner and the fallback end to end are in contextEspn.integration.test.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Db } from "../src/lib/db.js";
import { withRun } from "../src/lib/db.js";
import type { SignalDraft } from "../src/sources/types.js";
import { storeSignals } from "../src/sources/signals.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const DBNAME = "storyline_signals_test";
const PLAYER = "00000000-0000-0000-0000-0000000000b1";
let db: Db | null = null;

const draft = (key: string, summary: string, observedAt: string): SignalDraft => ({
  kind: "stat", subject: { kind: "player", id: PLAYER }, summary, trust: "verified", key,
  evidence: { url: `https://example.test/${key}`, observedAt },
});
const newRun = async () =>
  (await db!.query<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('context:espn', storyline_today(), 'ok') returning id`)).rows[0]!.id;
const dayPlus = async (n: number) => (await db!.query(`select (storyline_today() + $1::int)::text d`, [n])).rows[0].d as string;
const count = async (day: string) => Number((await db!.query(`select count(*) from signals where slate_date = $1`, [day])).rows[0].count);
const sightings = async (runId: number) =>
  (await db!.query(`select count(*)::int n from signal_sightings where run_id = $1`, [runId])).rows[0].n as number;
/** A second, independent pool: real separate connections, as in concurrency.integration.test.ts. */
const otherPool = () =>
  new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!.replace(/^(\w+:\/\/[^/]*\/)([^?]*)/, `$1${DBNAME}`), max: 2 });

before(async () => {
  db = await freshDb(DBNAME);
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, abbr) values (1,'nba','Spurs','SAS');
    insert into players (id, league, full_name, team_id) values ('${PLAYER}','nba','Player One',1);`);
});
after(async () => { await db?.end(); });

// ---------------------------------------------------------------- 1. re-runs and races
test("a re-run for the same day inserts nothing twice and keeps IDs", { skip }, async () => {
  const drafts = [draft("last5:pts", "21 ppg", "2026-11-17T10:00:00Z"), draft("last5:reb", "7 rpg", "2026-11-17T10:00:00Z")];
  const r1 = await newRun(), r2 = await newRun();
  const day = (await db!.query(`select storyline_today()::text d`)).rows[0].d;
  assert.equal(await storeSignals(db!, r1, "espn", day, drafts), 2);
  const before = (await db!.query(`select id, key from signals where slate_date = $1 order by key`, [day])).rows;
  assert.equal(await storeSignals(db!, r2, "espn", day, drafts), 2);
  assert.equal(await count(day), 2);
  assert.deepEqual((await db!.query(`select id, key from signals where slate_date = $1 order by key`, [day])).rows, before);
  // Both runs are recorded as having seen both signals (the fallback reads sightings).
  for (const r of [r1, r2]) {
    assert.equal((await db!.query(`select count(*) from signal_sightings where run_id = $1`, [r])).rows[0].count, "2");
  }
});

test("two runs racing on the same signals leave one row each", { skip }, async () => {
  const day = (await db!.query(`select (storyline_today() + 1)::text d`)).rows[0].d;
  const drafts = Array.from({ length: 20 }, (_, i) => draft(`race:${i}`, "x", "2026-11-17T10:00:00Z"));
  const runs = await Promise.all([newRun(), newRun(), newRun(), newRun()]);
  const settled = await Promise.allSettled(runs.map((r) => storeSignals(db!, r, "espn", day, drafts)));
  assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  assert.equal(Number((await db!.query(`select count(*) from signals where slate_date = $1`, [day])).rows[0].count), 20);
});

// ---------------------------------------------------------------- 2. QA on part 2 (PR #32)
// attacks: ESPN-down fallback ("newest ok run via signals.run_id"). withRun is not a transaction, so a run
// that stores signals and then fails has already re-stamped run_id; the last ok run then owns nothing.
test("a run that stores signals then fails doesn't take them away from the last ok run", { skip }, async () => {
  const day = await dayPlus(10);
  const drafts = [draft("fb:pts", "21 ppg", "2026-11-17T10:00:00Z")];
  const ok = await withRun(db!, "context:espn-qa", day, async (runId) => ({ n: await storeSignals(db!, runId, "espn", day, drafts) }));
  assert.equal(ok.n, 1);
  await assert.rejects(withRun(db!, "context:espn-qa", day, async (runId) => {
    await storeSignals(db!, runId, "espn", day, drafts);
    throw new Error("curation step after the store blew up");
  }));
  const { rows } = await db!.query(
    `select count(*)::int n from signal_sightings ss join signals s on s.id = ss.signal_id
      where s.source = 'espn' and s.slate_date = $1
        and ss.run_id = (select max(id) from pipeline_runs where job = 'context:espn-qa' and status = 'ok')`, [day]);
  assert.equal(rows[0].n, 1, "the last successful pull must still own its signal");
});

// attacks: concurrent runs on two real connections with overlapping keys in opposite order and different
// observedAt; must not deadlock, must not duplicate, and the newest text must end up on every key.
// (Rounds share a day, so after round 0 this can't see the lower-run-id-drops-newer-text bug; the
// deterministic version of that is in scenario_94_signals_qa.sql.)
test("two connections racing with overlapping keys: no deadlock, no duplicates, newest text wins", { skip }, async () => {
  const day = await dayPlus(11);
  const keys = Array.from({ length: 200 }, (_, i) => `ov:${i}`);
  const early = keys.map((k) => draft(k, "early", "2026-11-17T10:00:00Z"));
  const late = keys.map((k) => draft(k, "late", "2026-11-17T12:00:00Z")).reverse();
  const a = otherPool(), b = otherPool();
  try {
    for (let round = 0; round < 5; round++) {
      const [r1, r2] = [await newRun(), await newRun()];
      // lower run id carries the NEWER sighting on odd rounds, the older one on even rounds
      const [d1, d2] = round % 2 ? [late, early] : [early, late];
      const settled = await Promise.allSettled([storeSignals(a, r1, "espn", day, d1), storeSignals(b, r2, "espn", day, d2)]);
      assert.deepEqual(settled.map((s) => (s.status === "rejected" ? String(s.reason) : s.status)), ["fulfilled", "fulfilled"]);
    }
  } finally { await a.end(); await b.end(); }
  const { rows } = await db!.query(
    `select count(*)::int n, count(distinct id)::int ids, count(*) filter (where summary = 'late')::int late
       from signals where slate_date = $1`, [day]);
  assert.equal(rows[0].n, 200);
  assert.equal(rows[0].late, 200, "every key must carry the newest sighting's text");
});

// coverage: the same run racing itself (a retried request replayed concurrently) stores each fact once.
test("the same run replayed concurrently stores each signal once", { skip }, async () => {
  const day = await dayPlus(12);
  const r = await newRun();
  const drafts = Array.from({ length: 50 }, (_, i) => draft(`replay:${i}`, "x", "2026-11-17T10:00:00Z"));
  const a = otherPool(), b = otherPool();
  try {
    const settled = await Promise.allSettled([storeSignals(a, r, "espn", day, drafts), storeSignals(b, r, "espn", day, drafts)]);
    assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "fulfilled"]);
  } finally { await a.end(); await b.end(); }
  assert.equal((await db!.query(`select count(*)::int n from signals where slate_date = $1`, [day])).rows[0].n, 50);
});

// coverage: a large batch (10k drafts) goes through one call and is safe to re-run.
test("a 10k-signal batch stores and re-runs without duplicates", { skip }, async () => {
  const day = await dayPlus(13);
  const drafts = Array.from({ length: 10_000 }, (_, i) => draft(`big:${i}`, "x", "2026-11-17T10:00:00Z"));
  assert.equal(await storeSignals(db!, await newRun(), "espn", day, drafts), 10_000);
  assert.equal(await storeSignals(db!, await newRun(), "espn", day, drafts), 10_000);
  assert.equal((await db!.query(`select count(*)::int n from signals where slate_date = $1`, [day])).rows[0].n, 10_000);
});

// coverage: an empty batch from a source that returned nothing is a no-op, not an error.
test("an empty batch stores nothing and returns 0", { skip }, async () => {
  assert.equal(await storeSignals(db!, await newRun(), "espn", await dayPlus(14), []), 0);
});

// attacks: a malformed draft in the middle of a batch must reject the whole batch (no partial write).
test("one malformed draft rejects the whole batch", { skip }, async () => {
  const day = await dayPlus(15);
  const bad = { ...draft("bad", "x", "2026-11-17T10:00:00Z"), subject: { kind: "player", id: "not-a-uuid" } } as SignalDraft;
  await assert.rejects(storeSignals(db!, await newRun(), "espn", day, [draft("good", "x", "2026-11-17T10:00:00Z"), bad]));
  assert.equal((await db!.query(`select count(*)::int n from signals where slate_date = $1`, [day])).rows[0].n, 0);
});

// ---------------------------------------------------------------- 3. QA on the sightings fix
// attacks: two runs racing on overlapping keys (opposite order) on two connections; each run must end up with a
// sighting for every signal it saw, even the ones the other run inserted first (ON CONFLICT path).
test("two runs racing: each run records a sighting of every signal it saw", { skip }, async () => {
  const day = await dayPlus(20);
  const keys = Array.from({ length: 200 }, (_, i) => `race:${i}`);
  const a = otherPool(), b = otherPool();
  try {
    for (let round = 0; round < 5; round++) {
      const [r1, r2] = [await newRun(), await newRun()];
      const d1 = keys.map((k) => draft(k, `r${round}a`, "2026-11-17T10:00:00Z"));
      const d2 = keys.map((k) => draft(k, `r${round}b`, "2026-11-17T11:00:00Z")).reverse();
      const settled = await Promise.allSettled([storeSignals(a, r1, "espn", day, d1), storeSignals(b, r2, "espn", day, d2)]);
      assert.deepEqual(settled.map((s) => (s.status === "rejected" ? String(s.reason) : s.status)), ["fulfilled", "fulfilled"]);
      assert.deepEqual([await sightings(r1), await sightings(r2)], [200, 200], `round ${round}`);
    }
  } finally { await a.end(); await b.end(); }
  assert.equal((await db!.query(`select count(*)::int n from signals where slate_date = $1`, [day])).rows[0].n, 200);
});

// attacks: the same run replayed concurrently on two connections races on the sightings PK; neither call may
// fail (ON CONFLICT DO NOTHING must absorb it) and the run has exactly one sighting per signal.
test("the same run replayed concurrently: no PK error, one sighting per signal", { skip }, async () => {
  const day = await dayPlus(21);
  const drafts = Array.from({ length: 100 }, (_, i) => draft(`rep:${i}`, "x", "2026-11-17T10:00:00Z"));
  const a = otherPool(), b = otherPool();
  try {
    for (let round = 0; round < 5; round++) {
      const r = await newRun();
      const settled = await Promise.allSettled([storeSignals(a, r, "espn", day, drafts), storeSignals(b, r, "espn", day, drafts)]);
      assert.deepEqual(settled.map((s) => (s.status === "rejected" ? String(s.reason) : s.status)), ["fulfilled", "fulfilled"]);
      assert.equal(await sightings(r), 100, `round ${round}`);
    }
  } finally { await a.end(); await b.end(); }
});

// attacks: a bad batch racing a good one on the same keys; the bad run must leave no sightings and must not
// block or roll back the good run's sightings.
test("a bad batch racing a good one leaves no sightings and doesn't hurt the good run", { skip }, async () => {
  const day = await dayPlus(22);
  const good = Array.from({ length: 100 }, (_, i) => draft(`mix:${i}`, "good", "2026-11-17T10:00:00Z"));
  const bad = [...good.slice(0, 99), { ...draft("mix:bad", "x", "2026-11-17T10:00:00Z"), subject: { kind: "player", id: "00000000-0000-0000-0000-0000000000ff" } } as SignalDraft];
  const [rg, rb] = [await newRun(), await newRun()];
  const a = otherPool(), b = otherPool();
  try {
    const settled = await Promise.allSettled([storeSignals(a, rg, "espn", day, good), storeSignals(b, rb, "espn", day, bad)]);
    assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "rejected"]);
  } finally { await a.end(); await b.end(); }
  assert.deepEqual([await sightings(rg), await sightings(rb)], [100, 0]);
});

// coverage: the designed-for fallback end to end through withRun. Run 1 ok (3 signals), run 2 ok but ESPN returned
// only 2, run 3 stores and then fails. "Last successful pull" = run 2's 2 signals, each with its own observed_at.
test("fallback via sightings: last ok run's set, each signal keeping its date", { skip }, async () => {
  const day = await dayPlus(23);
  const job = "context:espn-fb95";
  await withRun(db!, job, day, async (id) => ({ n: await storeSignals(db!, id, "espn-fb", day,
    [draft("fb:a", "a1", "2026-11-17T10:00:00Z"), draft("fb:b", "b1", "2026-11-17T10:00:00Z"), draft("fb:c", "c1", "2026-11-17T10:00:00Z")]) }));
  await withRun(db!, job, day, async (id) => ({ n: await storeSignals(db!, id, "espn-fb", day,
    [draft("fb:a", "a2", "2026-11-17T12:00:00Z"), draft("fb:b", "b-old", "2026-11-17T09:00:00Z")]) }));
  await assert.rejects(withRun(db!, job, day, async (id) => {
    await storeSignals(db!, id, "espn-fb", day, [draft("fb:c", "c3", "2026-11-17T13:00:00Z")]);
    throw new Error("ESPN went down mid-run");
  }));
  const { rows } = await db!.query(
    `select s.key, s.summary, to_char(s.observed_at at time zone 'UTC', 'HH24:MI') at
       from signal_sightings ss join signals s on s.id = ss.signal_id
      where s.source = 'espn-fb' and s.slate_date = $1
        and ss.run_id = (select max(id) from pipeline_runs where job = $2 and status = 'ok')
      order by s.key`, [day, job]);
  assert.deepEqual(rows, [
    { key: "fb:a", summary: "a2", at: "12:00" },     // refreshed by the newer sighting
    { key: "fb:b", summary: "b1", at: "10:00" },     // run 2 saw it with an OLDER observedAt: run 1 text and date kept
  ]);
});
