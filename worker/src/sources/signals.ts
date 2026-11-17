// Writes a run's signals to the signals table (ADR-024 rule 2). The rules (one signal per
// source/subject/day/key, newer sighting refreshes, a sighting recorded per run) live in store_signals in
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

/** A signal as stored: what the curator reads, and what a blurb cites by `id`. */
export interface StoredSignal {
  id: number;
  kind: SignalDraft["kind"];
  subject: SignalDraft["subject"];
  key: string;
  summary: string;
  evidence: { url?: string; quote?: string; observedAt: string };
  trust: SignalDraft["trust"];
  /** The Storyline day this row belongs to (it may be an earlier day than the slate being curated). */
  slateDate: string;
}

/**
 * The ESPN-down fallback (ADR-024 rule 7.1): the last good signals about tonight's slate, each
 * keeping its own date. The one place this rule lives.
 *
 * - "Good" = seen by a run of `job` that finished ok. Read through signal_sightings, not
 *   signals.run_id (that column only means "first stored by"), so a later run that stored signals
 *   and then failed can't hide them, and one that only saw some players can't erase the rest.
 * - Per signal (subject + key), the newest row across the window wins, so a player a partial run
 *   missed still comes from the pull that had him, and each signal keeps its own `observed_at`.
 * - Only about tonight's players, teams and games: yesterday's game-level news says nothing about tonight.
 * - Window: the slate day itself and `maxAgeDays` Storyline days before it (the caller's slateDate
 *   comes from storyline_today(), so the 3am ET rollover is the database's, not ours).
 * - Accepted (STO-82): a failed run may have refreshed a signal's text; the signal is still dated honestly.
 */
export async function lastGoodSignals(
  db: Db,
  p: { job: string; source: string; slateDate: string; maxAgeDays: number; playerIds: string[]; teamIds: number[]; gameIds: string[] },
): Promise<StoredSignal[]> {
  const { rows } = await db.query(
    `select distinct on (s.player_id, s.team_id, s.game_id, s.key)
            s.id, s.kind, s.player_id, s.team_id, s.game_id, s.key, s.summary, s.evidence, s.observed_at, s.trust, s.slate_date::text as slate_date
       from signals s
      where s.source = $2
        and s.slate_date between $3::date - $4::int and $3::date
        and (s.player_id = any($5::uuid[]) or s.team_id = any($6::smallint[]) or s.game_id = any($7::uuid[]))
        and exists (select 1 from signal_sightings ss join pipeline_runs r on r.id = ss.run_id
                     where ss.signal_id = s.id and r.job = $1 and r.status = 'ok')
      order by s.player_id, s.team_id, s.game_id, s.key, s.observed_at desc`,
    [p.job, p.source, p.slateDate, p.maxAgeDays, p.playerIds, p.teamIds, p.gameIds]);
  return rows.map((r) => ({
    id: Number(r.id), kind: r.kind, key: r.key, summary: r.summary, trust: r.trust, slateDate: r.slate_date,
    subject: r.player_id ? { kind: "player", id: r.player_id } : r.team_id != null ? { kind: "team", id: r.team_id } : { kind: "game", id: r.game_id },
    evidence: { ...r.evidence, observedAt: (r.observed_at as Date).toISOString() },
  }));
}
