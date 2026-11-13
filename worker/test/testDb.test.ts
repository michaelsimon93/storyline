// Regression: the DEPLOYED manifest in supabase/migrations was being executed as SQL,
// and the failed setup left a connection open, hanging the test run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationFiles } from "./helpers/testDb.js";

test("test DB setup applies only .sql migrations, in order", () => {
  const files = migrationFiles();
  assert.ok(files.length > 0);
  assert.ok(files.every((f) => f.endsWith(".sql")), `non-SQL file in ${files}`);
  assert.deepEqual(files, [...files].sort());
});
