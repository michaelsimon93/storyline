// Startup schema check (STO-130): the worker waits for missing migrations, then gives up loudly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { appliedMigration, waitForSchema } from "../src/lib/schema.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
let db: Db | null = null;
before(async () => { db = await freshDb("storyline_schema_test"); });
after(async () => { await db?.end(); });

const alerts: string[] = [];
const alert = async (m: string) => { alerts.push(m); };
const noWait = async () => {};

test("an up-to-date database passes without alerting", { skip }, async () => {
  alerts.length = 0;
  const applied = await appliedMigration(db!);
  await waitForSchema(db!, alert, { required: applied!, wait: noWait });
  assert.equal(alerts.length, 0);
});

test("a database that's behind alerts once, then passes when the migration lands", { skip }, async () => {
  alerts.length = 0;
  let polls = 0;
  const wait = async () => {
    if (++polls === 2) await db!.query(`insert into supabase_migrations.schema_migrations (version) values ('99990101000000')`);
  };
  await waitForSchema(db!, alert, { required: "99990101000000", intervalMs: 1, maxMs: 10, wait });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /database is behind/);
  assert.equal(polls, 2);
  await db!.query(`delete from supabase_migrations.schema_migrations where version = '99990101000000'`);
});

test("gives up with an error if the migration never lands", { skip }, async () => {
  alerts.length = 0;
  await assert.rejects(
    waitForSchema(db!, alert, { required: "99990101000000", intervalMs: 1, maxMs: 3, wait: noWait }),
    /still missing migration 99990101000000/,
  );
  assert.equal(alerts.length, 1);
});

test("a database with no migration record counts as behind, not as ready", { skip }, async () => {
  await db!.query(`alter table supabase_migrations.schema_migrations rename to schema_migrations_hidden`);
  try {
    assert.equal(await appliedMigration(db!), null);
    await assert.rejects(waitForSchema(db!, alert, { required: "1", intervalMs: 1, maxMs: 1, wait: noWait }));
  } finally {
    await db!.query(`alter table supabase_migrations.schema_migrations_hidden rename to schema_migrations`);
  }
});
