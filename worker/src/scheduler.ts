// The worker's scheduler (STO-8). Runs each job on a cron schedule in ET and guarantees:
//   - only one copy of a job runs at a time, across processes (Postgres advisory lock),
//     so an overlapping deploy can't run curation twice;
//   - a failing job is logged, alerted, and never stops the other jobs;
//   - shutdown waits for in-flight jobs to finish.
// Each job logs its own runs to pipeline_runs via withRun (CLAUDE.md).

import { Cron } from "croner";
import type { Db } from "./lib/db.js";
import type { Alert } from "./lib/alert.js";

export const TIMEZONE = "America/New_York";

export interface Job {
  name: string;
  run: (db: Db) => Promise<object>;
}

export type RunOutcome =
  | { status: "ok"; outputs: object }
  | { status: "failed"; error: string }
  | { status: "skipped" };              // another copy of this job holds the lock

const lockKey = (jobName: string) => `storyline-job:${jobName}`;

/**
 * Run one job under its advisory lock. Never throws: failures are returned and alerted,
 * so one job can't take down the scheduler.
 */
export async function runJob(db: Db, job: Job, alert: Alert): Promise<RunOutcome> {
  // A session-level advisory lock lives on one connection, so hold a dedicated client for
  // the whole run. The job itself uses the pool for its queries.
  const lock = await db.connect();
  try {
    const { rows } = await lock.query<{ got: boolean }>(
      `select pg_try_advisory_lock(hashtext($1)) as got`, [lockKey(job.name)]);
    if (!rows[0]!.got) {
      console.log(`[${job.name}] skipped: already running elsewhere`);
      return { status: "skipped" };
    }
    try {
      const outputs = await job.run(db);
      return { status: "ok", outputs };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await alert(`job ${job.name} failed: ${error}`);
      return { status: "failed", error };
    } finally {
      await lock.query(`select pg_advisory_unlock(hashtext($1))`, [lockKey(job.name)]);
    }
  } finally {
    lock.release();
  }
}

/** Throws one error listing every invalid cron pattern, so a bad config fails at startup. */
export function validateSchedules(schedules: Record<string, string>): void {
  const problems: string[] = [];
  for (const [job, pattern] of Object.entries(schedules)) {
    try {
      new Cron(pattern, { timezone: TIMEZONE, paused: true }).stop();
    } catch (err) {
      problems.push(`${job}: "${pattern}" (${err instanceof Error ? err.message : err})`);
    }
  }
  if (problems.length) throw new Error(`Invalid job schedule(s): ${problems.join("; ")}`);
}

/** Next run of a cron pattern in ET after `from` (used for startup logging and tests). */
export function nextRunEt(pattern: string, from: Date): Date | null {
  const c = new Cron(pattern, { timezone: TIMEZONE, paused: true });
  const next = c.nextRun(from);
  c.stop();
  return next;
}

export interface Scheduled { job: Job; pattern: string }

export function startScheduler(db: Db, scheduled: Scheduled[], alert: Alert) {
  validateSchedules(Object.fromEntries(scheduled.map((s) => [s.job.name, s.pattern])));
  const inFlight = new Set<Promise<RunOutcome>>();

  const crons = scheduled.map(({ job, pattern }) =>
    new Cron(pattern, { timezone: TIMEZONE, protect: true }, async () => {
      const p = runJob(db, job, alert);
      inFlight.add(p);
      try { await p; } finally { inFlight.delete(p); }
    }));

  return {
    nextRuns: () => scheduled.map(({ job }, i) => ({ job: job.name, next: crons[i]!.nextRun() })),
    /** Stop scheduling new runs and wait for running jobs to finish. */
    async stop() {
      for (const c of crons) c.stop();
      await Promise.allSettled([...inFlight]);
    },
  };
}
