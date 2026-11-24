// The test DB applies only .sql files from supabase/migrations, in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationFiles } from "./helpers/testDb.js";

test("test DB setup applies only .sql migrations, in order", () => {
  const files = migrationFiles();
  assert.ok(files.length > 0);
  assert.ok(files.every((f) => f.endsWith(".sql")), `non-SQL file in ${files}`);
  assert.deepEqual(files, [...files].sort());
});
