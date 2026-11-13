// Worker entry point.
//   npm start                        always-on: run every job on its schedule (STO-8)
//   npm run job -- <name>            run one job now, under the same lock + alerting
//   npm run ingest [-- YYYY-MM-DD]   one-off ingest for a specific date (bypasses the scheduler)

import { connect } from "./lib/db.js";
import { loadConfig } from "./lib/config.js";
import { webhookAlert } from "./lib/alert.js";
import { ingest } from "./jobs/ingest.js";
import { scheduledJobs } from "./jobs/index.js";
import { runJob, startScheduler } from "./scheduler.js";

const [command, arg] = process.argv.slice(2);

async function main() {
  const db = connect();
  const alert = webhookAlert();

  switch (command) {
    case "run": {
      const config = await loadConfig(db);
      const scheduler = startScheduler(db, scheduledJobs(config), alert);
      for (const { job, next } of scheduler.nextRuns()) {
        console.log(`scheduled ${job}: next run ${next?.toISOString() ?? "never"}`);
      }
      // Railway sends SIGTERM on deploy: finish running jobs, then exit. The advisory locks
      // make an overlapping new instance skip any job this one is still running.
      const shutdown = async (signal: string) => {
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
      const entry = scheduledJobs(config).find((s) => s.job.name === arg);
      if (!entry) throw new Error(`Unknown job: ${arg}`);
      console.log(JSON.stringify(await runJob(db, entry.job, alert), null, 2));
      break;
    }
    case "ingest": {
      const started = Date.now();
      const summary = await ingest(db, arg);
      console.log(JSON.stringify({ ...summary, seconds: (Date.now() - started) / 1000 }, null, 2));
      break;
    }
    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}. Try: run | job <name> | ingest [YYYY-MM-DD]`);
  }
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
