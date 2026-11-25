// Schedules for jobs that must never be able to stop the worker (STO-112, STO-117; STO-106's pattern).
//
// loadConfig (read at startup) throws if any row is missing, so a schedule row added there would crash-loop the worker
// whenever it deployed before its migration, or someone deleted or mistyped the row. Each schedule here is read on its own:
// a bad row skips that one job and alerts, and every other job still starts.

import type { Db } from "./db.js";
import type { Alert } from "./alert.js";
import { alertText } from "./alertText.js";
import { validateSchedules, type Job, type Scheduled } from "../scheduler.js";

export interface OptionalSchedule { key: string; job: Job }

/** Pure: the cron pattern in an app_config row, or the reason it can't be used. */
export function parseSchedule(key: string, rows: { key: string; value: unknown }[], job: string): { ok: true; pattern: string } | { ok: false; problem: string } {
  const row = rows.find((r) => r.key === key);
  if (!row) return { ok: false, problem: `missing ${key}` };
  if (typeof row.value !== "string") return { ok: false, problem: `${key} should be a cron string, got ${JSON.stringify(row.value)}` };
  try { validateSchedules({ [job]: row.value }); } catch (err) { return { ok: false, problem: `${key}: ${err instanceof Error ? err.message : err}` }; }
  return { ok: true, pattern: row.value };
}

/**
 * The schedule for each job that has a usable row. A job whose row is missing, malformed or unreadable is left out and
 * alerted by name; the others are unaffected. Never throws (an alert that can't be sent is logged), so it can't stop startup.
 */
export async function loadOptionalSchedules(db: Db, alert: Alert, jobs: OptionalSchedule[]): Promise<Scheduled[]> {
  const out: Scheduled[] = [];
  for (const { key, job } of jobs) {
    let problem: string | undefined;
    let cause: unknown;
    try {
      const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from app_config where key = $1`, [key]);
      const parsed = parseSchedule(key, rows, job.name);
      if (parsed.ok) out.push({ job, pattern: parsed.pattern }); else problem = parsed.problem;
    } catch (err) {
      problem = `${key} could not be read: ${err instanceof Error ? err.message : err}`;
      cause = err;
    }
    if (problem === undefined) continue;
    try {
      await alert(alertText({
        severity: "failed", job: job.name, headline: `${job.name} is not scheduled: ${problem}`, error: cause,
        note: `Only ${job.name} is off the schedule; every other job keeps running. Fix or add the app_config row (a migration), then restart the worker. ` +
          `Until then run it by hand: npm run job -- ${job.name}`,
      }));
    } catch (err) {
      console.error(`could not send the "${job.name} not scheduled" alert: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}
