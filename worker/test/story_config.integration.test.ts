// STO-106: the outage of Nov 18, reproduced. The worker deployed before the story settings were in the database;
// loadConfig (read at startup by every job) refused to start. A missing story setting must stop only the story step.
// Requires TEST_DATABASE_URL (skipped otherwise). Runs in CI.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { loadConfig, loadStoryConfig, ConfigError } from "../src/lib/config.js";
import { freshDb } from "./helpers/testDb.js";

let db: Db | null = null;
before(async () => { db = await freshDb("storyline_story_config_test"); });
after(async () => { await db?.end(); });

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";

test("the story settings in the real database load, typed", { skip }, async () => {
  const c = await loadStoryConfig(db!);
  assert.deepEqual([c.storyMinMinutes, c.storyHotStreakMinGames, c.storyHotStreakMarginPct, c.storyScoreMax], [10, 3, 20, 100]);
});

// Order matters: this test deletes the story rows from this file's own database, so the test above must run first (node:test runs a file's tests in order).
test("with the story settings missing from the database, startup config still loads and only the story loader fails, naming the keys", { skip }, async () => {
  await db!.query(`delete from app_config where key like 'story\\_%'`);   // this file's database is its own, so nothing to restore
  const boot = await loadConfig(db!);                       // what every job reads at startup
  assert.equal(boot.cardsPerDay, 10, "the worker starts: ingest, poller and settlement keep running");
  await assert.rejects(loadStoryConfig(db!), (e: unknown) =>
    e instanceof ConfigError && /missing story_min_minutes/.test(e.message) && /missing story_score_return/.test(e.message));
});
