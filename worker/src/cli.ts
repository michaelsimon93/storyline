// Entry point: `npm run ingest [-- YYYY-MM-DD]`.
// Later jobs (price poller, curation, settlement) get added here and to the scheduler.

import { connect } from "./lib/db.js";
import { ingest } from "./jobs/ingest.js";

const [command, arg] = process.argv.slice(2);

async function main() {
  const db = connect();
  try {
    switch (command) {
      case "ingest": {
        const started = Date.now();
        const summary = await ingest(db, arg);
        console.log(JSON.stringify({ ...summary, seconds: (Date.now() - started) / 1000 }, null, 2));
        break;
      }
      default:
        throw new Error(`Unknown command: ${command ?? "(none)"}. Try: ingest [YYYY-MM-DD]`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
