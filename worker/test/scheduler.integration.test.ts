// The scheduler against real Postgres: advisory locks, failure isolation, alerting, shutdown.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { connect, type Db } from "../src/lib/db.js";
import { connectLockClient, runJob, startScheduler, type Job } from "../src/scheduler.js";
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
  // Checked from a separate session: advisory locks are re-entrant within one session, so
  // re-running the job on a reused connection would not prove anything.
  const { rows } = await db!.query(`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
  assert.equal(rows[0].n, 0, "no advisory lock is left behind after a failure");
});

test("the lock holds across separate processes (separate connections)", { skip }, async () => {
  // Simulate an overlapping deploy: another process already holds the job's lock.
  const other = await db!.connect();
  await other.query(`select pg_advisory_lock(hashtext('storyline-job:ingest'))`);
  try {
    const alerts: string[] = [];
    const out = await runJob(db!, { name: "ingest", run: async () => ({}) }, async (m) => { alerts.push(m); });
    assert.equal(out.status, "skipped");
    assert.match(alerts[0] ?? "", /ingest skipped: another copy is still running/, "a skip is alerted, not silent");
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

test("if the database is unreachable, the run fails with an alert instead of crashing", { skip }, async () => {
  const dead = connect("postgresql://postgres@/nowhere?host=/tmp/no-such-socket-dir&port=1");
  const alerts: string[] = [];
  let ran = false;
  try {
    const out = await runJob(dead, { name: "ingest", run: async () => { ran = true; return {}; } },
      async (m) => { alerts.push(m); });
    assert.equal(out.status, "failed");
    assert.equal(ran, false, "the job must not run without its lock");
    assert.match(alerts[0] ?? "", /ingest could not start/);
  } finally {
    await dead.end();
  }
});

test("if the lock connection dies mid-run, the worker survives and alerts", { skip }, async () => {
  // e.g. a network blip or a Supabase restart while curation is running. Postgres drops the
  // lock with the session, so another copy could start; that must be loud, not a crash.
  let lockPid!: number;
  let noticed!: () => void;
  const lockErrored = new Promise<void>((r) => (noticed = r));
  const connectLock = async () => {
    const lockClient: pg.Client = await connectLockClient(db!);
    lockPid = (await lockClient.query(`select pg_backend_pid() as pid`)).rows[0].pid;
    lockClient.on("error", () => noticed());
    return lockClient;
  };
  const alerts: string[] = [];
  const job: Job = {
    name: "curation-like",
    run: async (d) => {
      await d.query(`select pg_terminate_backend($1)`, [lockPid]);
      await lockErrored;                         // the dead connection has been noticed
      return { published: 10 };
    },
  };
  const out = await runJob(db!, job, async (m) => { alerts.push(m); }, connectLock);

  assert.deepEqual(out, { status: "ok", outputs: { published: 10 } }, "the job's own result is kept");
  assert.ok(alerts.some((a) => /curation-like lost its lock connection/.test(a)), `alerts: ${alerts}`);
});

test("more running jobs than pool connections don't deadlock", { skip }, async () => {
  // Locks live on their own connections, so they can't starve the pool the jobs query through.
  const jobs = Array.from({ length: 6 }, (_, i): Job => ({
    name: `busy-${i}`, run: async (d) => { await d.query(`select pg_sleep(0.2)`); return {}; },
  }));
  const all = Promise.all(jobs.map((j) => runJob(db!, j, noAlert)));
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000).unref());
  const result = await Promise.race([all, timeout]);
  assert.notEqual(result, "timeout", "jobs deadlocked waiting for pool connections");
  assert.ok((result as { status: string }[]).every((o) => o.status === "ok"));
});

test("a failing job's alert points at its pipeline_runs row", { skip }, async () => {
  const { withRun } = await import("../src/lib/db.js");
  const alerts: string[] = [];
  await runJob(db!, {
    name: "logged-job",
    run: (d) => withRun(d, "logged-job", "2026-11-13", async () => { throw new Error("Kalshi changed a field"); }),
  }, async (m) => { alerts.push(m); });

  const { rows } = await db!.query(`select id, status from pipeline_runs where job = 'logged-job'`);
  assert.equal(rows[0].status, "failed");
  assert.match(alerts[0] ?? "", new RegExp(`pipeline_runs id ${rows[0].id} \\(slate 2026-11-13\\)`));
  assert.match(alerts[0] ?? "", /logged-job failed: Kalshi changed a field/);
});

test("an every-N-seconds job (the price poller) waits its interval between runs", { skip }, async () => {
  // 2s, not 1s: croner only applies `interval` above 1, so a 1s test can't tell whether the
  // interval is honored. Without it the job would fire every second (and hammer Kalshi).
  const starts: number[] = [];
  const scheduler = startScheduler(db!, [
    { job: { name: "every-2s", run: async () => { starts.push(Date.now()); return {}; } }, everySeconds: 2 },
  ], noAlert);
  await new Promise((r) => setTimeout(r, 5_500));
  await scheduler.stop();
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  assert.ok(starts.length >= 2 && starts.length <= 3, `ran ${starts.length}x in 5.5s at a 2s interval`);
  assert.ok(gaps.every((g) => g >= 1_800), `gaps between runs: ${gaps.join(", ")}ms`);
});

test("an invalid interval fails at startup", { skip }, async () => {
  for (const everySeconds of [0, -5, 1.5]) {
    assert.throws(() => startScheduler(db!, [{ job: { name: "bad", run: async () => ({}) }, everySeconds }], noAlert),
      /Invalid interval for bad/);
  }
});
