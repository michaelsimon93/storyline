// The scheduler against real Postgres: advisory locks, failure isolation, alerting, shutdown.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { runJob, startScheduler, type Job } from "../src/scheduler.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
let db: Db | null = null;

before(async () => { db = await freshDb("storyline_scheduler_test"); });
after(async () => { await db?.end(); });

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const noAlert = async () => {};

test("a job runs and returns its outputs", { skip }, async () => {
  const out = await runJob(db!, { name: "hello", run: async () => ({ n: 1 }) }, noAlert);
  assert.deepEqual(out, { status: "ok", outputs: { n: 1 } });
});

test("only one copy of a job runs at a time", { skip }, async () => {
  const release = gate();
  let started!: () => void;
  const firstStarted = new Promise<void>((r) => (started = r));
  let runs = 0;
  // Only the first copy blocks; if the lock were missing, a second copy would run to completion
  // and the assertions below would fail clearly (instead of the test hanging).
  const job: Job = { name: "curation-like", run: async () => { runs++; if (runs === 1) { started(); await release.p; } return {}; } };

  const first = runJob(db!, job, noAlert);
  await firstStarted;                        // first copy holds the lock
  const second = await runJob(db!, job, noAlert);
  release.open();
  const firstOutcome = await first;

  assert.equal(second.status, "skipped", "an overlapping copy must skip, not run");
  assert.equal(firstOutcome.status, "ok");
  assert.equal(runs, 1);
});

test("different jobs run at the same time", { skip }, async () => {
  const release = gate();
  let aStarted!: () => void;
  const aRunning = new Promise<void>((r) => (aStarted = r));
  const a = runJob(db!, { name: "job-a", run: async () => { aStarted(); await release.p; return {}; } }, noAlert);
  await aRunning;
  const b = await runJob(db!, { name: "job-b", run: async () => ({ ran: true }) }, noAlert);
  release.open();
  await a;
  assert.equal(b.status, "ok");
});

test("a failing job is reported and alerted, never thrown, and releases its lock", { skip }, async () => {
  const alerts: string[] = [];
  const failing: Job = { name: "flaky", run: async () => { throw new Error("ESPN returned garbage"); } };
  const out = await runJob(db!, failing, async (m) => { alerts.push(m); });

  assert.deepEqual(out, { status: "failed", error: "ESPN returned garbage" });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /flaky failed: ESPN returned garbage/);
  const again = await runJob(db!, { name: "flaky", run: async () => ({}) }, noAlert);
  assert.equal(again.status, "ok", "the lock was released after the failure");
});

test("the lock holds across separate processes (separate connections)", { skip }, async () => {
  // Simulate an overlapping deploy: another process already holds the job's lock.
  const other = await db!.connect();
  await other.query(`select pg_advisory_lock(hashtext('storyline-job:ingest'))`);
  try {
    const out = await runJob(db!, { name: "ingest", run: async () => ({}) }, noAlert);
    assert.equal(out.status, "skipped");
  } finally {
    await other.query(`select pg_advisory_unlock(hashtext('storyline-job:ingest'))`);
    other.release();
  }
});

test("scheduled jobs run, a failing one doesn't stop the others, and stop() waits for running jobs", { skip }, async () => {
  const release = gate();
  let okRuns = 0;
  let slowFinished = false;
  let slowStarted!: () => void;
  const slowRunning = new Promise<void>((r) => (slowStarted = r));
  const alerts: string[] = [];

  const scheduler = startScheduler(db!, [
    { job: { name: "sched-fails", run: async () => { throw new Error("nope"); } }, pattern: "* * * * * *" },
    { job: { name: "sched-ok", run: async () => { okRuns++; return {}; } }, pattern: "* * * * * *" },
    { job: { name: "sched-slow", run: async () => { slowStarted(); await release.p; slowFinished = true; return {}; } }, pattern: "* * * * * *" },
  ], async (m) => { alerts.push(m); });

  await slowRunning;
  await new Promise((r) => setTimeout(r, 2_200));   // let the per-second jobs fire a couple of times
  const stopping = scheduler.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(stopped, false, "stop() must wait for the running job");
  release.open();
  await stopping;

  assert.ok(slowFinished, "the in-flight job finished before stop() resolved");
  assert.ok(okRuns >= 2, `healthy job kept running alongside the failing one (ran ${okRuns}x)`);
  assert.ok(alerts.some((a) => /sched-fails failed: nope/.test(a)), "the failure was alerted");
});
