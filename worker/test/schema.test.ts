import { test } from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_MIGRATION } from "../src/lib/schema.js";
import { migrationFiles } from "./helpers/testDb.js";

// Fails on any migration PR that doesn't bump REQUIRED_MIGRATION, so the worker never deploys
// expecting less than its own schema.
test("REQUIRED_MIGRATION is the newest migration file", () => {
  const newest = migrationFiles().at(-1)!.split("_")[0];
  assert.equal(REQUIRED_MIGRATION, newest, `set REQUIRED_MIGRATION in src/lib/schema.ts to "${newest}"`);
});
