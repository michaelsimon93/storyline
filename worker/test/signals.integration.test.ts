// storeSignals against real Postgres: safe to re-run, safe to race (STO-10).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import type { SignalDraft } from "../src/sources/types.js";
import { storeSignals } from "../src/sources/signals.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const PLAYER = "00000000-0000-0000-0000-0000000000b1";
let db: Db | null = null;

const draft = (key: string, summary: string, observedAt: string): SignalDraft => ({
  kind: "stat", subject: { kind: "player", id: PLAYER }, summary, trust: "verified", key,
  evidence: { url: `https://example.test/${key}`, observedAt },
});
const newRun = async () =>
  (await db!.query<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('context:espn', storyline_today(), 'ok') returning id`)).rows[0]!.id;
const count = async () => Number((await db!.query(`select count(*) from signals`)).rows[0].count);

before(async () => {
  db = await freshDb("storyline_signals_test");
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, abbr) values (1,'nba','Spurs','SAS');
    insert into players (id, league, full_name, team_id) values ('${PLAYER}','nba','Player One',1);`);
});
after(async () => { await db?.end(); });

test("a re-run for the same day inserts nothing twice and keeps IDs", { skip }, async () => {
  const drafts = [draft("last5:pts", "21 ppg", "2026-11-17T10:00:00Z"), draft("last5:reb", "7 rpg", "2026-11-17T10:00:00Z")];
  const r1 = await newRun(), r2 = await newRun();
  const day = (await db!.query(`select storyline_today()::text d`)).rows[0].d;
  assert.equal(await storeSignals(db!, r1, "espn", day, drafts), 2);
  const before = (await db!.query(`select id, key from signals order by key`)).rows;
  assert.equal(await storeSignals(db!, r2, "espn", day, drafts), 2);
  assert.equal(await count(), 2);
  assert.deepEqual((await db!.query(`select id, key from signals order by key`)).rows, before);
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
