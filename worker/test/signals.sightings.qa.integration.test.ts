// QA for STO-10 part 2 fix (PR #32, ad689e8): signal_sightings under concurrent runs, concurrent replays,
// a concurrent bad batch, and the ESPN-down fallback through real withRun. Failing tests here are findings.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { Db } from "../src/lib/db.js";
import { withRun } from "../src/lib/db.js";
import type { SignalDraft } from "../src/sources/types.js";
import { storeSignals } from "../src/sources/signals.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const DBNAME = "storyline_signals_sight_qa_test";
const PLAYER = "00000000-0000-0000-0000-0000000000b1";
let db: Db | null = null;

const draft = (key: string, summary: string, observedAt: string): SignalDraft => ({
  kind: "stat", subject: { kind: "player", id: PLAYER }, summary, trust: "verified", key,
  evidence: { url: `https://example.test/${key}`, observedAt },
});
const newRun = async () =>
  (await db!.query<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('context:espn', storyline_today(), 'ok') returning id`)).rows[0]!.id;
const dayPlus = async (n: number) => (await db!.query(`select (storyline_today() + $1::int)::text d`, [n])).rows[0].d as string;
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
