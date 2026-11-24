// Worker entry point.
//   npm start                        always-on: run every job on its schedule (STO-8)
//   npm run job -- <name>            run one job now, under the same lock + alerting
//   npm run ingest [-- YYYY-MM-DD]   one-off ingest for a specific date, under the ingest lock

import { connect } from "./lib/db.js";
import { loadConfig } from "./lib/config.js";
import { webhookAlert } from "./lib/alert.js";
import { testFeed } from "./lib/testFeed.js";
import { alertText } from "./lib/alertText.js";
import { waitForSchema } from "./lib/schema.js";
import { ingestJob, scheduledJobs, onDemandJobs } from "./jobs/index.js";
import { runJob, startScheduler, type RunOutcome } from "./scheduler.js";

const [command, arg] = process.argv.slice(2);
const alert = webhookAlert();
const feed = testFeed();

/** One-off commands exit non-zero unless the job actually ran and succeeded. */
function report(outcome: RunOutcome) {
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.status !== "ok") process.exitCode = 1;
}

async function main() {
  const db = connect();
  // Never run against a database that's missing this build's migrations (STO-130).
  await waitForSchema(db, alert);

  switch (command) {
    case "run": {
      const config = await loadConfig(db);
      const scheduler = startScheduler(db, scheduledJobs(config, feed, alert), alert);
      for (const { job, next } of scheduler.nextRuns()) {
        console.log(`scheduled ${job}: next run ${next?.toISOString() ?? "never"}`);
      }
      // Railway sends SIGTERM on deploy: finish running jobs, then exit. The advisory locks
      // make an overlapping new instance skip any job this one is still running.
      let stopping = false;
      const shutdown = async (signal: string) => {
        if (stopping) return;            // a second signal must not end the pool twice
        stopping = true;
        console.log(`${signal}: stopping scheduler, waiting for running jobs`);
        await scheduler.stop();
        await db.end();
        process.exit(0);
      };
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("SIGINT", () => void shutdown("SIGINT"));
      return; // keep running
    }
    case "job": {
      const config = await loadConfig(db);
      const job = [...scheduledJobs(config, feed, alert).map((s) => s.job), ...onDemandJobs(feed, alert)].find((j) => j.name === arg);
      if (!job) throw new Error(`Unknown job: ${arg}`);
      report(await runJob(db, job, alert));
      break;
    }
    case "ingest": {
      // Same lock as the scheduled ingest, so a manual run can't overlap a scheduled one.
      report(await runJob(db, ingestJob(feed, arg), alert));
      break;
    }
    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}. Try: run | job <name> | ingest [YYYY-MM-DD]`);
  }
  await db.end();
}

main().catch(async (err) => {
  console.error(err);
  // A worker that can't start (bad config, database down) must not crash-loop silently.
  if (command === "run") {
    await alert(alertText({ severity: "failed", job: "worker", headline: "worker failed to start", error: err,
      note: "no jobs will run until this is fixed; the error above is usually config, the database, or a migration that never applied" }));
  }
  process.exit(1);
});
