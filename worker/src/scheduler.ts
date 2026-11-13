// The worker's scheduler (STO-8). Runs each job on a cron schedule in ET and guarantees:
//   - only one copy of a job runs at a time, across processes (Postgres advisory lock),
//     so an overlapping deploy can't run curation twice;
//   - a failing job is logged, alerted, and never stops the other jobs;
//   - shutdown waits for in-flight jobs to finish.
// Each job logs its own runs to pipeline_runs via withRun (CLAUDE.md).

import { Cron } from "croner";
import pg from "pg";
import type { Db } from "./lib/db.js";
import type { Alert } from "./lib/alert.js";
import { alertText } from "./lib/alertText.js";

// Must match storyline_day() in SQL, which owns the ET slate-day rule; croner needs the zone itself.
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
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The lock lives on its own short-lived connection, outside the job pool, so N running jobs
 * can never exhaust the pool their own queries need. Closing that connection releases the lock.
 * Needs a direct or session-mode connection: transaction-mode poolers break session locks.
 */
export async function connectLockClient(db: Db): Promise<pg.Client> {
  const client = new pg.Client({ ...db.options, keepAlive: true });
  await client.connect();
  return client;
}

/**
 * Run one job under its advisory lock. Never throws: every failure (the job, the database
 * being unreachable, the lock connection dying mid-run) is returned and alerted, so one job
 * can't take down the always-on worker.
 */
export async function runJob(
  db: Db, job: Job, alert: Alert,
  connectLock: () => Promise<pg.Client> = () => connectLockClient(db),
): Promise<RunOutcome> {
  let lock: pg.Client | undefined;
  let lockLost: unknown;
  const startedAt = new Date();
  try {
    try {
      lock = await connectLock();
      // Without a listener, a dropped connection is an uncaught 'error' that kills the process.
      lock.on("error", (err) => { lockLost = err; });
      const { rows } = await lock.query<{ got: boolean }>(
        `select pg_try_advisory_lock(hashtext($1)) as got`, [lockKey(job.name)]);
      if (!rows[0]!.got) {
        // At our cadence an overlap is unusual (a stuck run, or a deploy overlapping a long job),
        // so every skip is alerted rather than silently logged.
        await alert(alertText({
          severity: "warning", job: job.name, headline: `${job.name} skipped: another copy is still running`,
          note: "a previous run may be stuck; check pipeline_runs for a row still 'running', or a second worker",
        }));
        return { status: "skipped" };
      }
    } catch (err) {
      const error = `could not start: ${message(err)}`;
      await alert(alertText({
        severity: "failed", job: job.name, headline: `${job.name} ${error}`, error: err, startedAt,
        note: "the job did not run; usually the database is unreachable (check Supabase status / DATABASE_URL)",
      }));
      return { status: "failed", error };
    }

    let outcome: RunOutcome;
    try {
      outcome = { status: "ok", outputs: await job.run(db) };
    } catch (err) {
      outcome = { status: "failed", error: message(err) };
      await alert(alertText({
        severity: "failed", job: job.name, headline: `${job.name} failed: ${outcome.error}`, error: err, startedAt,
      }));
    }
    if (lockLost !== undefined) {
      // Postgres dropped the lock with the session, so another copy may have run alongside.
      await alert(alertText({
        severity: "warning", job: job.name, error: lockLost, startedAt,
        headline: `${job.name} lost its lock connection mid-run`,
        note: `the job finished with status ${outcome.status}, but another copy may have run at the same time; ` +
          "check pipeline_runs for overlapping rows",
      }));
    }
    return outcome;
  } finally {
    // Ending the session releases the advisory lock; errors here (dead socket) are irrelevant.
    if (lock) await lock.end().catch(() => {});
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

/**
 * A job runs either on a cron pattern in ET, or every N seconds (cron can't go below a minute,
 * and the price poller needs ~30s).
 */
export type Scheduled =
  | { job: Job; pattern: string; everySeconds?: never }
  | { job: Job; everySeconds: number; pattern?: never };

const EVERY_SECOND = "* * * * * *";
const cronFor = (s: Scheduled) => s.pattern ?? EVERY_SECOND;

export function startScheduler(db: Db, scheduled: Scheduled[], alert: Alert) {
  validateSchedules(Object.fromEntries(scheduled.filter((s) => s.pattern).map((s) => [s.job.name, s.pattern!])));
  for (const s of scheduled) {
    if (s.everySeconds !== undefined && !(Number.isInteger(s.everySeconds) && s.everySeconds >= 1)) {
      throw new Error(`Invalid interval for ${s.job.name}: ${s.everySeconds}s`);
    }
  }
  const inFlight = new Set<Promise<RunOutcome>>();

  // protect: a run still going when the next is due is skipped in-process (no overlap).
  // interval: croner's minimum gap between runs, for every-N-seconds jobs.
  const crons = scheduled.map((s) => { const { job } = s; return (
    new Cron(cronFor(s), { timezone: TIMEZONE, protect: true, interval: s.everySeconds }, async () => {
      // runJob never throws; the catch is a backstop so a bug can't become an unhandled rejection.
      const p = runJob(db, job, alert).catch(async (err): Promise<RunOutcome> => {
        await alert(alertText({ severity: "failed", job: job.name, headline: `scheduler error running ${job.name}`, error: err }));
        return { status: "failed", error: message(err) };
      });
      inFlight.add(p);
      try { await p; } finally { inFlight.delete(p); }
    })); });

  return {
    nextRuns: () => scheduled.map(({ job }, i) => ({ job: job.name, next: crons[i]!.nextRun() })),
    /** Stop scheduling new runs and wait for running jobs to finish. */
    async stop() {
      for (const c of crons) c.stop();
      await Promise.allSettled([...inFlight]);
    },
  };
}
