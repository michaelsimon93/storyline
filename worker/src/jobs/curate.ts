// The curation step (STO-11, ADR-024 step 5, ranking and picking only; blurbs are STO-77): read the day's shortlist, have Claude
// rank it and pick the cards, store every attempt, and hand the picks to #testing. Nothing is published here (STO-12).
//
//  - Settings load inside the run (STO-106/107 pattern): a missing one fails this run on the record, alerts naming each key, and
//    returns normally so the scheduler doesn't alert twice. Other jobs are untouched.
//  - No shortlist for the day (the story step hasn't run) is reported and does nothing: it never curates yesterday's list.
//  - If every attempt breaks the rules or fails, curateWithRules has already sent the detailed alert. The run is recorded as
//    failed, the attempts are kept, and nothing is posted or published. Never a partial deck.
//  - A re-run is a new run with its own attempts. The shortlist it reads is whatever the story step last stored for the day.

import Anthropic from "@anthropic-ai/sdk";
import { withRun, type Db } from "../lib/db.js";
import { loadCurationConfig, ConfigError } from "../lib/config.js";
import { alertText } from "../lib/alertText.js";
import type { Alert } from "../lib/alert.js";
import { LEAGUE, resolveSlateDate } from "./ingest.js";
import { narrowToBand, type CurationInput, type CurationRules, type Selection } from "../domain/curationRules.js";
import type { ShortlistEntry, SlotKind } from "../domain/shortlist.js";
import type { StatKey } from "../domain/storyDetectors.js";
import { curateWithRules, type CurationRequest } from "../sources/curate.js";
import { createClaudeCurator } from "../sources/claudeCurator.js";
import { loadCurationInput } from "../sources/curationInput.js";
import { storeAttempts } from "../sources/curationStore.js";
import type { Curator } from "../sources/types.js";

export const JOB = "curate";

export interface CurateRunOptions {
  alert: Alert;
  /** A specific slate day (YYYY-MM-DD). Default: today's, from the database. */
  date?: string;
  /** Tests pass a fake. Default: Claude, through the official SDK (reads ANTHROPIC_API_KEY). */
  curator?: Curator<CurationRequest, unknown>;
}

/** What a finished run hands to the #testing post. */
export interface CurationPosted { shown: CurationInput; selection: Selection; attemptsUsed: number; asked: number }

export type CurateRunResult =
  | { status: "ok"; slateDate: string; runId: number; picks: number; attempts: number; posted: CurationPosted }
  | { status: "no_shortlist"; slateDate: string; runId: number | undefined }
  | { status: "failed"; slateDate: string; runId: number | undefined; attempts: number }
  | { status: "config_error"; slateDate: string; runId: number | undefined; problems: string[] };

/** Thrown inside the run so withRun records it as failed. Caught below: the alert has already gone out. */
class CurationFailed extends Error {
  constructor(readonly attempts: number) { super(attempts === 0 ? "no story had a strike inside the price band, so Claude was not called" : `every one of ${attempts} curation attempts failed or broke the rules`); }
}
class NoShortlist extends Error { constructor(day: string) { super(`no story shortlist for ${day}`); } }

/** The day's shortlist, in the story step's display order, with each story's signal IDs. */
export async function loadShortlist(db: Db, slateDate: string): Promise<ShortlistEntry[]> {
  const { rows } = await db.query(
    `select s.id, s.run_id, s.slate_date::text as slate_date, s.position, s.league::text as league, s.player_id, s.team_id, s.game_id,
            s.angle, s.stat, s.score, s.summary, s.market_id, s.slot_kind,
            coalesce(array_agg(g.signal_id order by g.signal_id) filter (where g.signal_id is not null), '{}') as signal_ids
     from story_shortlist s left join story_shortlist_signals g on g.shortlist_id = s.id
     where s.slate_date = $1 group by s.id order by s.position`, [slateDate]);
  return rows.map((r) => ({
    id: Number(r.id), runId: Number(r.run_id), slateDate: r.slate_date as string, position: r.position as number, league: r.league as string,
    playerId: r.player_id as string, teamId: r.team_id as number, gameId: r.game_id as string, angle: r.angle as string, stat: r.stat as StatKey,
    score: r.score as number, summary: r.summary as string, marketId: r.market_id as string, slotKind: r.slot_kind as SlotKind,
    signalIds: (r.signal_ids as string[]).map(Number),
  }));
}

export async function runCuration(db: Db, opts: CurateRunOptions): Promise<CurateRunResult> {
  const slateDate = await resolveSlateDate(db, opts.date);
  let posted: CurationPosted | undefined;
  let doneRunId = 0;
  try {
    const out = await withRun(db, JOB, slateDate, async (runId) => {
      doneRunId = runId;
      const cfg = await loadCurationConfig(db);
      const entries = await loadShortlist(db, slateDate);
      if (entries.length === 0) throw new NoShortlist(slateDate);
      const input = await loadCurationInput(db, slateDate, entries, cfg.maxSpreadCents);
      const rules: CurationRules = {
        n: cfg.cardsPerDay, bandMin: cfg.priceBandMin, bandMax: cfg.priceBandMax,
        maxPerGame: cfg.curationMaxPerGame, maxPerStat: cfg.curationMaxPerStat, maxAttempts: cfg.curationMaxAttempts,
      };
      const curator = opts.curator ?? createClaudeCurator({ client: new Anthropic(), model: cfg.curationModel, maxTokens: cfg.curationMaxTokens, effort: cfg.curationEffort });

      const r = await curateWithRules(curator, input, rules, opts.alert);
      await storeAttempts(db, runId, r.attempts);   // kept whether or not it passed: rejected answers are what tuning needs
      if (!r.ok) throw new CurationFailed(r.attempts.length);

      posted = { shown: narrowToBand(input, rules), selection: r.selection, attemptsUsed: r.attempts.length, asked: rules.n };
      return {
        league: LEAGUE, stories: input.stories.length, shown: posted.shown.stories.length, attempts: r.attempts.length,
        picks: r.selection.picks.map((p) => ({ storyId: p.storyId, marketId: p.marketId, reason: p.reason })),
      };
    });
    return { status: "ok", slateDate, runId: doneRunId, picks: out.picks.length, attempts: out.attempts, posted: posted! };
  } catch (err) {
    const runId = (err as { pipelineRunId?: number }).pipelineRunId;
    if (err instanceof CurationFailed) return { status: "failed", slateDate, runId, attempts: err.attempts };   // curateWithRules already alerted
    if (err instanceof NoShortlist) {
      await opts.alert(alertText({
        severity: "warning", job: JOB, headline: `${JOB}: no story shortlist for ${slateDate}, so nothing was curated`,
        note: "The story step hasn't stored a list for this day. Run it first: npm run job -- story",
      }));
      return { status: "no_shortlist", slateDate, runId };
    }
    if (err instanceof ConfigError) {
      await opts.alert(alertText({
        severity: "failed", job: JOB, headline: `${JOB} can't run: ${err.problems.length} curation setting(s) missing or wrong in app_config`, error: err,
        note: `${err.problems.join("; ")}. Only the curation step is stopped; every other job keeps running. Add the missing rows (a migration), then re-run: npm run job -- curate`,
      }));
      return { status: "config_error", slateDate, runId, problems: err.problems };
    }
    throw err;
  }
}
