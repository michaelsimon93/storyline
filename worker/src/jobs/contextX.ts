// The X context runner (STO-75 part 1, ADR-024): one slate-wide Grok search per run proposes stories; each resolves to our
// player, team or game, and each post under it becomes a signal. Discover only: per-player enrich and the trending angle come later.
//
// Switches (ADR-018): `context_x` off = nothing runs, nothing is spent. `context_x_report_only` on = still search and still record
// and list the accounts, but store NO signals, so X changes nothing downstream while the approved list is being built.
//
// Failure rules (ticket): a failed Grok call is reported and the run ends; curation never waits on X. A missing key or a
// missing setting is reported and skipped the same way. A database error is a real failure and propagates.

import { withRun, type Db } from "../lib/db.js";
import { loadXConfig, flagOn, ConfigError } from "../lib/config.js";
import { alertText } from "../lib/alertText.js";
import type { Alert } from "../lib/alert.js";
import { askGrok, ticksToUsd } from "../sources/grok.js";
import { loadSlate } from "../sources/slate.js";
import { storeSignals } from "../sources/signals.js";
import { STORIES_SCHEMA, storiesPrompt, buildX, type XSlateRef, type Dropped } from "../domain/xStories.js";
import { LEAGUE, resolveSlateDate } from "./ingest.js";

export const FLAG = "context_x";
export const REPORT_ONLY_FLAG = "context_x_report_only";
export const JOB = "context:x";
export const SOURCE = "x";
export const KEY_ENV = "XAI_API_KEY";

export interface XRunOptions {
  alert: Alert;
  /** The xAI key. Passed in (from the environment by the caller), so tests don't touch process.env. */
  apiKey: string | undefined;
  date?: string;
  now?: () => Date;
}

export interface ReviewLine {
  handle: string; status: "unreviewed" | "approved" | "rejected"; isNew: boolean;
  storiesCiting: number; sampleUrl: string; sampleExcerpt: string;
}

export interface XSummary {
  slateDate: string; runId: number; mode: "report_only" | "live";
  storiesKept: number; dropped: Dropped[]; postsKept: number; postsOverCap: number; signalsStored: number;
  /** What each kept story says (a lead for tuning the trending angle later). Not stored as signals. */
  stories: { subject: string; kind: string; whyCare: string; chatter: string; chatterBasis: string; posts: number; handles: string[] }[];
  /** Spend: xAI's own counter. The dollar figure assumes 1 tick = 1e-10 USD (unverified), so it is an estimate. */
  spend: { costTicks: number; usdEstimate: number; postsFetched: number; searchCalls: number };
  accounts: ReviewLine[];
}

export type XRunResult =
  | { status: "off"; slateDate: string }
  | { status: "no_games"; slateDate: string }
  | { status: "no_key" | "config_error" | "source_down"; slateDate: string; runId?: number; error: string }
  | { status: "ok"; summary: XSummary };

class SourceDown extends Error {}

export async function runXContext(db: Db, opts: XRunOptions): Promise<XRunResult> {
  const slateDate = await resolveSlateDate(db, opts.date);
  // Before the flag check on purpose: rejecting an account must reach stored signals even if X has since been switched off.
  await withdrawUnapproved(db);
  if (!(await flagOn(db, FLAG))) return { status: "off", slateDate };
  if (!opts.apiKey) {
    const error = `${KEY_ENV} is not set`;
    await opts.alert(alertText({ severity: "warning", job: JOB, headline: `${JOB} skipped: ${error}`, note: `Curation goes on without X. Add the key to the worker's environment.` }));
    return { status: "no_key", slateDate, error };
  }
  try {
    const out = await withRun(db, JOB, slateDate, async (runId) => {
      const cfg = await loadXConfig(db);
      const slate = await loadSlate(db, slateDate, LEAGUE, "espn");
      if (slate.games.length === 0) return { runId, noGames: true as const };
      const ref = await slateRef(db, slate);
      const reportOnly = await flagOn(db, REPORT_ONLY_FLAG);

      let got;
      try {
        got = await askGrok({ apiKey: opts.apiKey!, model: cfg.xModel, timeoutMs: cfg.xTimeoutMs },
          { input: storiesPrompt(ref, cfg.xMaxStories), schema: STORIES_SCHEMA as unknown as Record<string, unknown>, schemaName: "stories" });
      } catch (e) { throw new SourceDown(e instanceof Error ? e.message : String(e)); }

      const approved = await approvedHandles(db);
      let built;
      try {
        built = buildX({ answer: got.answer, ref, approved, observedAt: (opts.now?.() ?? new Date()).toISOString(), maxStories: cfg.xMaxStories, maxPosts: cfg.xMaxPostsPerRun, citedIds: got.citedStatusIds });
      } catch (e) { throw new SourceDown(e instanceof Error ? e.message : String(e)); }   // an answer we can't read is the same as no answer

      const accounts = await recordAccounts(db, built.accounts);
      const signalsStored = reportOnly ? 0 : await storeSignals(db, runId, SOURCE, slateDate, built.signals);
      const summary: XSummary = {
        slateDate, runId, mode: reportOnly ? "report_only" : "live",
        storiesKept: built.stories.length, dropped: built.dropped, postsKept: built.signals.length, postsOverCap: built.postsOverCap, signalsStored,
        stories: built.stories,
        spend: { costTicks: got.usage.costTicks, usdEstimate: Math.round(ticksToUsd(got.usage.costTicks) * 1000) / 1000, postsFetched: got.usage.postsFetched, searchCalls: got.usage.searchCalls },
        accounts,
      };
      return summary;
    });
    if ("noGames" in out) return { status: "no_games", slateDate };
    return { status: "ok", summary: out };
  } catch (err) {
    const runId = (err as { pipelineRunId?: number }).pipelineRunId;
    if (err instanceof ConfigError) {
      await opts.alert(alertText({ severity: "failed", job: JOB, headline: `${JOB} can't run: ${err.problems.length} X setting(s) missing or wrong in app_config`, error: err,
        note: `${err.problems.join("; ")}. Curation goes on without X.` }));
      return { status: "config_error", slateDate, runId, error: err.message };
    }
    if (err instanceof SourceDown) {
      await opts.alert(alertText({ severity: "warning", job: JOB, headline: `${JOB}: the X search failed, curation goes on without X`, error: err, note: err.message }));
      return { status: "source_down", slateDate, runId, error: err.message };
    }
    throw err;
  }
}

/** Tonight's teams (with names), games and players, in the shape the resolver and the prompt need. */
async function slateRef(db: Db, slate: Awaited<ReturnType<typeof loadSlate>>): Promise<XSlateRef> {
  const { rows } = await db.query<{ id: number; name: string }>(`select id, name from teams where id = any($1::smallint[])`, [slate.teams.map((t) => t.id)]);
  return {
    teams: rows,
    games: slate.games.map((g) => ({ id: g.id, homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId })),
    players: slate.players.map((p) => ({ id: p.id, name: p.name, teamId: p.teamId })),
  };
}

async function approvedHandles(db: Db): Promise<Set<string>> {
  const { rows } = await db.query<{ handle: string }>(`select handle from x_accounts where status = 'approved'`);
  return new Set(rows.map((r) => r.handle));
}

/**
 * Trust is copied onto a signal when it is stored, so rejecting (or un-approving) an account must reach the signals already stored:
 * any attributed X signal whose account isn't approved any more goes back to unreviewed, whether or not tonight's search returns the post again.
 */
async function withdrawUnapproved(db: Db): Promise<void> {
  await db.query(
    `update signals set trust = 'unreviewed'
      where source = $1 and trust = 'attributed'
        and coalesce(evidence->>'handle', '') not in (select handle from x_accounts where status = 'approved')`, [SOURCE]);
}

/**
 * Record each account we pulled a post from. A first sighting inserts it unreviewed; a repeat only refreshes last_seen and the
 * sample post, and never touches status (approving is a person's decision). Returns each with its current status.
 */
async function recordAccounts(db: Db, pulls: { handle: string; storiesCiting: number; sampleUrl: string; sampleExcerpt: string }[]): Promise<ReviewLine[]> {
  const out: ReviewLine[] = [];
  for (const a of pulls) {
    const { rows } = await db.query<{ status: ReviewLine["status"]; is_new: boolean }>(
      `insert into x_accounts (handle, sample_url, sample_excerpt) values ($1, $2, $3)
       on conflict (handle) do update set last_seen_at = now(), sample_url = excluded.sample_url, sample_excerpt = excluded.sample_excerpt
       returning status, (xmax = 0) as is_new`, [a.handle, a.sampleUrl, a.sampleExcerpt]);
    out.push({ ...a, status: rows[0]!.status, isNew: rows[0]!.is_new });
  }
  return out;
}
