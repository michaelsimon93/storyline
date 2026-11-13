// The job registry: every scheduled job and the config key holding its schedule.
// New jobs (poller, curation, settlement, out-status) are added here in their own PRs.

import type { Config } from "../lib/config.js";
import type { Scheduled } from "../scheduler.js";
import { ingest } from "./ingest.js";
import { pollPrices } from "./poller.js";

export function scheduledJobs(config: Config): Scheduled[] {
  return [
    { job: { name: "ingest", run: (db) => ingest(db) }, pattern: config.ingestScheduleEt },
    { job: { name: "price_poll", run: (db) => pollPrices(db) }, everySeconds: config.pollerIntervalSeconds },
  ];
}
