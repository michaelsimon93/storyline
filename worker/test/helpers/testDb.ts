// Creates a fresh, migrated database for an integration test. Applies the same
// Supabase stubs + migrations the SQL tests use, so the worker is tested against
// the real schema, constraints and functions.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { connect, type Db } from "../../src/lib/db.js";

const SUPABASE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "supabase");

export async function freshDb(name: string): Promise<Db | null> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) return null; // integration tests skip without a database

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  // Swap the database name in the connection string. (Not via `new URL`: Postgres
  // socket URLs like postgresql://user@/db?host=/tmp aren't valid WHATWG URLs.)
  const url = adminUrl.replace(/^(\w+:\/\/[^/]*\/)([^?]*)/, `$1${name}`);
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  try {
    await setup.query(readFileSync(join(SUPABASE, "tests", "supabase_stubs.sql"), "utf8"));
    // Record each migration the way `supabase db push` does, so the worker's startup schema
    // check (lib/schema.ts) sees a database like production's.
    await setup.query(`create schema supabase_migrations;
      create table supabase_migrations.schema_migrations (version text primary key, name text)`);
    for (const f of migrationFiles()) {
      await setup.query(readFileSync(join(SUPABASE, "migrations", f), "utf8"));
      const [version, ...rest] = f.replace(/\.sql$/, "").split("_");
      await setup.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)`,
        [version, rest.join("_")]);
    }
  } finally {
    // Always close: a failed setup must fail the test, not hang the process.
    await setup.end();
  }

  return connect(url);
}

/** Only *.sql files, in order. */
export function migrationFiles(): string[] {
  return readdirSync(join(SUPABASE, "migrations")).filter((f) => f.endsWith(".sql")).sort();
}
