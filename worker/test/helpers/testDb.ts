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
  await setup.query(readFileSync(join(SUPABASE, "tests", "supabase_stubs.sql"), "utf8"));
  for (const f of readdirSync(join(SUPABASE, "migrations")).sort()) {
    await setup.query(readFileSync(join(SUPABASE, "migrations", f), "utf8"));
  }
  await setup.end();

  return connect(url);
}
