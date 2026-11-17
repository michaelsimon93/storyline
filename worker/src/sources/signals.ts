// Writes a run's signals to the signals table (ADR-024 rule 2). The rules (one signal per
// source/subject/day/key, newer sighting refreshes, run_id re-stamped) live in store_signals in
// SQL, so they exist once. This is only the call.

import type { Db } from "../lib/db.js";
import type { SignalDraft } from "./types.js";

/** Stores drafts from one source for one slate day under a run. Safe to re-run. Returns how many distinct signals it covered. */
export async function storeSignals(
  db: Db,
  runId: number,
  source: string,
  slateDate: string,
  drafts: SignalDraft[],
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select store_signals($1, $2, $3, $4::jsonb) as n`,
    [runId, source, slateDate, JSON.stringify(drafts)],
  );
  return rows[0]!.n;
}
