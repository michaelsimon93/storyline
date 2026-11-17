// The job registry: every scheduled job and the config key holding its schedule.
// New jobs (poller, curation, settlement, out-status) are added here in their own PRs.

import type { Config } from "../lib/config.js";
import type { TestFeed } from "../lib/testFeed.js";
import { ingestSummaryText } from "../lib/feedText.js";
import type { Job, Scheduled } from "../scheduler.js";
import { ingest } from "./ingest.js";
import { pollPrices } from "./poller.js";
import { runEspnContext, JOB as CONTEXT_ESPN_JOB, type ContextRunResult } from "./contextEspn.js";
import type { Alert } from "../lib/alert.js";

/** Ingest, then post its summary to the test feed. No date = today's slate (storyline_today()). */
export function ingestJob(feed: TestFeed, date?: string): Job {
  return {
    name: "ingest",
    run: async (db) => {
      const summary = await ingest(db, date);
      // The run is already recorded ok: nothing about the test feed may fail it (STO-40).
      try {
        await feed.post(ingestSummaryText(summary));
      } catch (err) {
        console.error(`test feed: could not post ingest summary: ${err instanceof Error ? err.message : err}`);
      }
      return summary;
    },
  };
}

/** The ESPN context pull. Scheduled runs use today's slate; the result is trimmed (no signal bodies) for the log. */
export function contextEspnJob(alert: Alert, date?: string): Job {
  return {
    name: CONTEXT_ESPN_JOB,
    run: async (db) => {
      const r: ContextRunResult = await runEspnContext(db, { alert, date });
      if (r.status !== "fallback") return r;
      const dates = r.signals.map((s) => s.evidence.observedAt).sort();   // how stale the stand-in is, for whoever reads the log
      return { ...r, signals: r.signals.length, oldestObservedAt: dates[0] ?? null, newestObservedAt: dates[dates.length - 1] ?? null };
    },
  };
}

export function scheduledJobs(config: Config, feed: TestFeed, alert: Alert): Scheduled[] {
  return [
    { job: ingestJob(feed), pattern: config.ingestScheduleEt },
    { job: contextEspnJob(alert), pattern: config.contextEspnScheduleEt },
    { job: { name: "price_poll", run: (db) => pollPrices(db) }, everySeconds: config.pollerIntervalSeconds },
  ];
}
