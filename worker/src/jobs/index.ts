// The job registry: every scheduled job and the config key holding its schedule.
// New jobs (poller, curation, settlement, out-status) are added here in their own PRs.

import type { Config } from "../lib/config.js";
import type { TestFeed } from "../lib/testFeed.js";
import { ingestSummaryText } from "../lib/feedText.js";
import type { Job, Scheduled } from "../scheduler.js";
import { ingest } from "./ingest.js";
import { pollPrices } from "./poller.js";

/** Ingest, then post its summary to the test feed. No date = today's slate (storyline_today()). */
export function ingestJob(feed: TestFeed, date?: string): Job {
  return {
    name: "ingest",
    run: async (db) => {
      const summary = await ingest(db, date);
      await feed.post(ingestSummaryText(summary));   // never throws, so it can't fail the run (STO-40)
      return summary;
    },
  };
}

export function scheduledJobs(config: Config, feed: TestFeed): Scheduled[] {
  return [
    { job: ingestJob(feed), pattern: config.ingestScheduleEt },
    { job: { name: "price_poll", run: (db) => pollPrices(db) }, everySeconds: config.pollerIntervalSeconds },
  ];
}
