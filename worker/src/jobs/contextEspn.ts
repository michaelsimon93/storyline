// The ESPN context runner (STO-10 part 3b, ADR-024 rules 5-7): pull ESPN signals for the slate and
// store them, under the job name `context:espn`, which the fallback uses to find the last good pull.
//
// Failure rules:
//  - flag off: skip silently (no run row, no alert, no ESPN calls).
//  - ESPN down (the source throws): reported and skipped. The run does not stop curation: it returns the
//    signals from the last good pulls, each keeping its own date, and alerts that it is degraded.
//  - some players failed, or a response had bad rows: the pull still counts as ok (we keep what we got);
//    it alerts when failures pass a threshold in app_config.
//  - a database error is not ESPN being down: it stays a real failure (the scheduler alerts it).

import { withRun, type Db } from "../lib/db.js";
import { loadConfig, flagOn, type Config } from "../lib/config.js";
import { alertText } from "../lib/alertText.js";
import type { Alert } from "../lib/alert.js";
import type { FetchOptions } from "../lib/http.js";
import { createEspnSource, type CollectStats } from "../sources/espnContext.js";
import { loadSlate } from "../sources/slate.js";
import { storeSignals, lastGoodSignals, type StoredSignal } from "../sources/signals.js";
import type { Slate } from "../sources/types.js";
import { LEAGUE, resolveSlateDate } from "./ingest.js";

export const FLAG = "context_espn";
export const JOB = "context:espn";

export interface ContextRunOptions {
  alert: Alert;
  /** A specific slate day (YYYY-MM-DD). Default: today's, from the database. */
  date?: string;
  fetchOpts?: FetchOptions;
  now?: () => Date;
}

export type ContextRunResult =
  | { status: "off"; slateDate: string }
  | { status: "ok" | "degraded"; slateDate: string; runId: number; stored: number; stats: CollectStats }
  | {
      status: "fallback"; slateDate: string; runId: number | undefined; error: string;
      /** Which rung of ADR-024 rule 7 stood in. Only the first (the last good ESPN pull) exists so far. */
      level: "last_good_pull" | "none";
      signals: StoredSignal[];
    };

/** The source threw: ESPN is down. Kept apart from database errors, which must stay failures. */
class SourceDown extends Error {
  constructor(readonly original: unknown) { super(original instanceof Error ? original.message : String(original)); }
}

export async function runEspnContext(db: Db, opts: ContextRunOptions): Promise<ContextRunResult> {
  const slateDate = await resolveSlateDate(db, opts.date);
  if (!(await flagOn(db, FLAG))) return { status: "off", slateDate };

  const config = await loadConfig(db);
  let stats: CollectStats | undefined;
  const source = createEspnSource({
    flag: FLAG, windowGames: config.espnFormWindowGames, pauseMs: config.espnPauseMs,
    maxConsecutiveFailures: config.espnMaxConsecutiveFailures,
    fetchOpts: opts.fetchOpts, now: opts.now, onStats: (s) => { stats = s; },
  });
  let slate: Slate | undefined;

  try {
    const out = await withRun(db, JOB, slateDate, async (runId) => {
      slate = await loadSlate(db, slateDate, LEAGUE, source.name);
      let drafts;
      try { drafts = await source.collect(slate); } catch (e) { throw new SourceDown(e); }
      const stored = await storeSignals(db, runId, source.name, slateDate, drafts);
      const s = stats!;
      return {
        runId, stored, players: s.players, failedCalls: s.failures.length, skippedRows: s.skippedRows.length,
        firstFailures: s.failures.slice(0, 5), firstSkipped: s.skippedRows.slice(0, 5),
      };
    });
    const degraded = out.players.failed > config.espnDegradedFailedPlayers || out.skippedRows > 0;
    if (degraded) {
      await opts.alert(alertText({
        severity: "warning", job: JOB,
        headline: `${JOB} pull degraded: ${out.players.failed} players failed, ${out.skippedRows} bad rows skipped`,
        note: `stored ${out.stored} signals anyway (the rest of the pull is fine). ` +
          [...out.firstFailures, ...out.firstSkipped].slice(0, 6).join(" | "),
      }));
    }
    return { status: degraded ? "degraded" : "ok", slateDate, runId: out.runId, stored: out.stored, stats: stats! };
  } catch (err) {
    if (!(err instanceof SourceDown) || !slate) throw err;
    const runId = (err as { pipelineRunId?: number }).pipelineRunId;
    const signals = await lastGoodSignals(db, {
      job: JOB, source: source.name, slateDate, maxAgeDays: config.espnFallbackMaxAgeDays,
      playerIds: slate.players.map((p) => p.id), teamIds: slate.teams.map((t) => t.id), gameIds: slate.games.map((g) => g.id),
    });
    await opts.alert(fallbackAlert(err, signals, config, runId));
    return { status: "fallback", slateDate, runId, error: err.message, level: signals.length ? "last_good_pull" : "none", signals };
  }
}

function fallbackAlert(err: SourceDown, signals: StoredSignal[], config: Config, runId: number | undefined): string {
  const dates = signals.map((s) => s.evidence.observedAt).sort();
  return alertText({
    severity: "failed", job: JOB,
    headline: signals.length
      ? `${JOB} degraded: ESPN is down, using ${signals.length} signals from earlier pulls`
      : `${JOB} degraded: ESPN is down and there is no earlier pull to use`,
    error: Object.assign(new Error(err.message), { pipelineRunId: runId }),
    note: signals.length
      ? `fallback level 1 of 3 (last good ESPN pull, dated ${dates[0]} to ${dates[dates.length - 1]}); ` +
        `the X and market-only levels aren't built yet. Blurbs must treat these as dated, not tonight's news`
      : `nothing from the last ${config.espnFallbackMaxAgeDays} slate days covers tonight's players; curation would have no ESPN facts`,
  });
}
