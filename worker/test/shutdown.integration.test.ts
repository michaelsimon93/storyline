// The deployed worker (STO-54): Railway builds it with Railpack, which runs deploy.startCommand
// from railpack.json as `/bin/bash -c <command>`, and stops it with SIGTERM on every deploy.
// This runs that exact command the same way and proves SIGTERM reaches the worker's own handler:
// running jobs finish, the process exits 0, and nothing is left behind.
//
// Regressions this catches (both fail this test):
//  - `npm start`: npm dies on SIGTERM without passing it on, orphaning the worker.
//  - no `exec`: under some shells (dash) the shell stays as the parent, takes the signal and
//    dies, orphaning the worker. `exec` makes node the process Railway signals.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "../src/lib/db.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");
const START = JSON.parse(readFileSync(join(WORKER, "railpack.json"), "utf8")).deploy.startCommand as string;
let db: Db | null = null;

before(async () => {
  db = await freshDb("storyline_shutdown_test");
  // Tests never hit the network: keep ingest (ESPN, Kalshi) from coming due while the worker runs.
  // The poller can run; with no cards today it makes no external calls.
  await db?.query(`update app_config set value = '"0 0 1 1 *"' where key = 'ingest_schedule_et'`);
});
after(async () => { await db?.end(); });

const isRunning = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What's left in the process group, for the failure message. */
const leftovers = (pgid: number) => {
  try { return execSync("ps -eo pid,pgid,stat,args --no-headers").toString().split("\n")
    .filter((l) => l.trim().split(/\s+/)[1] === String(pgid)).join("\n"); } catch { return "(ps failed)"; }
};

/**
 * True once nothing in the group is left. Helpers (tsx's esbuild service) exit a few milliseconds
 * after node and can briefly linger until reaped, so allow a short grace period. An orphaned
 * worker, the regression this guards against, keeps running indefinitely and still fails.
 */
async function groupExits(pgid: number, graceMs = 2_000): Promise<boolean> {
  const end = Date.now() + graceMs;
  while (isRunning(pgid)) {
    if (Date.now() > end) return false;
    await sleep(50);
  }
  return true;
}

for (const shell of ["bash", "sh"]) test(`the start command shuts down cleanly on SIGTERM (${shell} -c)`, { skip, timeout: 30_000 }, async () => {
  const child = spawn(shell, ["-c", START], {
    cwd: WORKER,
    env: { ...process.env, DATABASE_URL: db!.options.connectionString, ALERT_WEBHOOK_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,   // its own process group, so cleanup reaches anything it leaves behind
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

  try {
    // Wait until the scheduler is up (it logs each job's next run), then stop it like Railway does.
    const deadline = Date.now() + 20_000;
    while (!out.includes("scheduled price_poll")) {
      if (child.exitCode !== null) assert.fail(`worker exited early (${child.exitCode}):\n${out}`);
      if (Date.now() > deadline) assert.fail(`worker never started:\n${out}`);
      await sleep(100);
    }
    child.kill("SIGTERM");

    const code = await Promise.race([exited, new Promise<"hung">((r) => setTimeout(() => r("hung"), 10_000))]);
    assert.equal(code, 0, `expected a clean exit, got ${code}:\n${out}`);
    assert.match(out, /SIGTERM: stopping scheduler, waiting for running jobs/);
    assert.ok(await groupExits(child.pid!), `a process outlived the shutdown:\n${leftovers(child.pid!)}\n${out}`);
  } finally {
    // Whatever happened, leave nothing running: an orphan would hold the test's pipes open.
    if (isRunning(child.pid!)) process.kill(-child.pid!, "SIGKILL");
  }
});
