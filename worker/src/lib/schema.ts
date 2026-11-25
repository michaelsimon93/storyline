// The worker refuses to run against a database that's missing migrations it was built with (STO-130).
//
// Migrations apply automatically when a PR merges to main (the `migrate` job in tests.yml), and
// Railway's "Wait for CI" holds the worker deploy until that job finishes. Railway's docs say not
// to rely on Wait for CI alone for migrations, so the worker checks for itself at startup: if the
// database is behind, it alerts, waits, and re-checks, and only gives up after SCHEMA_WAIT.maxMs.
//
// `supabase db push` records each applied migration in supabase_migrations.schema_migrations
// (version = the file's timestamp prefix). The test database helper records them the same way.

import type { Db } from "./db.js";
import type { Alert } from "./alert.js";
import { alertText } from "./alertText.js";

/**
 * Timestamp of the newest file in supabase/migrations. A unit test fails if this falls behind,
 * so every migration PR updates it.
 */
export const REQUIRED_MIGRATION = "20261125200000";

/**
 * How long startup waits for the migrate job. Hard-coded on purpose, not in app_config (ADR-018):
 * this runs before the worker can trust the schema, and app_config rows may be what's missing.
 */
export const SCHEMA_WAIT = { intervalMs: 30_000, maxMs: 15 * 60_000 };

/** The newest applied migration's version, or null if none are recorded (or the table is missing). */
export async function appliedMigration(db: Db): Promise<string | null> {
  // Two queries: naming a missing table fails at parse time, even inside a CASE.
  const exists = await db.query<{ t: string | null }>(`select to_regclass('supabase_migrations.schema_migrations')::text as t`);
  if (!exists.rows[0]?.t) return null;
  const { rows } = await db.query<{ v: string | null }>(`select max(version) as v from supabase_migrations.schema_migrations`);
  return rows[0]?.v ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves once the database has `required` (or newer). While it's behind, alerts once and polls.
 * Throws after `maxMs`, which the caller turns into the usual "worker failed to start" alert.
 */
export async function waitForSchema(
  db: Db,
  alert: Alert,
  { required = REQUIRED_MIGRATION, intervalMs = SCHEMA_WAIT.intervalMs, maxMs = SCHEMA_WAIT.maxMs, wait = sleep } = {},
): Promise<void> {
  let applied = await appliedMigration(db);
  if (applied !== null && applied >= required) return;

  await alert(alertText({
    severity: "warning", job: "worker",
    headline: `database is behind: has migration ${applied ?? "none"}, worker needs ${required}`,
    note: `waiting up to ${Math.round(maxMs / 60_000)} min for the migrate job in GitHub Actions; check it ran on the latest merge to main`,
  }));

  for (let waited = 0; waited < maxMs; waited += intervalMs) {
    await wait(intervalMs);
    applied = await appliedMigration(db);
    if (applied !== null && applied >= required) {
      console.log(`schema ready: migration ${applied}`);
      return;
    }
  }
  throw new Error(`database still missing migration ${required} after ${Math.round(maxMs / 60_000)} min (has ${applied ?? "none"})`);
}
