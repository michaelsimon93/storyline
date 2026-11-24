// Stores each curation attempt (STO-11, decision 1: its own table). One row per call to the curator: exactly what it
// was shown, what it answered, why that was rejected, and which attempt was accepted. This is how a pick traces back
// to what the model saw, and how rejected answers can be read back when tuning the prompt.
//
// Safe to run twice for the same run: (run_id, attempt) is unique and a repeat is ignored, so a retry of the store
// step can't double-count. A re-run of the whole job is a new pipeline_runs row, so it stores its own attempts.

import type { Db } from "../lib/db.js";
import type { Attempt } from "./curate.js";

/**
 * Postgres jsonb can't hold U+0000 or a lone surrogate, and a model's answer can contain either. One such character would make
 * the whole batch fail and lose every attempt of the run, the accepted one included. So both are replaced (with U+FFFD) in
 * every string and key before storing: what's kept is what the model said, minus the characters the database can't hold.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function storable(v: unknown): unknown {
  if (typeof v === "string") return v.replaceAll("\u0000", "\uFFFD").replace(LONE_SURROGATE, "\uFFFD");
  if (Array.isArray(v)) return v.map(storable);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [storable(k) as string, storable(x)]));
  return v;
}

export async function storeAttempts(db: Db, runId: number, attempts: Attempt[]): Promise<void> {
  if (attempts.length === 0) return;
  const rows = attempts.map((a) => ({
    attempt: a.attempt, request: a.request, output: a.output ?? null, violations: a.violations, error: a.error ?? null, accepted: a.accepted,
  }));
  await db.query(
    `insert into curation_attempts (run_id, attempt, request, output, violations, error, accepted)
     select $1, a.attempt, a.request, a.output, a.violations, a.error, a.accepted
     from jsonb_to_recordset($2::jsonb) as a(attempt int, request jsonb, output jsonb, violations jsonb, error text, accepted boolean)
     on conflict (run_id, attempt) do nothing`,
    [runId, JSON.stringify(storable(rows))]);
}
