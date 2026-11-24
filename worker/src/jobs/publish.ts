// The publish step (STO-12, spec §3 step 7): the day's cards go live from the latest finished curation run. No review queue.
//
//  - Reads `pipeline_runs.outputs.picks[]` of the latest ok `curate` run for the day (blurb + the facts it cites, kept there by STO-77).
//  - Re-checks each card against the database as it is now (publishRules): blurb limits, trust, the line still open and in the price
//    band, game not started. A card that fails is left out and named; the rest still publish. A short set is published and flagged.
//  - All-or-nothing in one transaction, under one lock per day. If the day already has cards the run does nothing, so a re-run can
//    never add cards past the deck size or change a line people already have picks on (the database also refuses to move a line:
//    migration 20261124180000).
//  - No games that day: nothing is read or written. No finished curation run: an alert, nothing published.
//  - Scheduling is STO-117; this runs on demand: npm run job -- publish.

import { withRun, type Db } from "../lib/db.js";
import { loadCurationConfig, ConfigError } from "../lib/config.js";
import { alertText } from "../lib/alertText.js";
import type { Alert } from "../lib/alert.js";
import { LEAGUE, resolveSlateDate } from "./ingest.js";
import type { CardBlurb, BlurbFacts } from "../domain/blurbRules.js";
import { storylineTypeOf, whyNotPublishable, type Skip } from "../domain/publishRules.js";

export const JOB = "publish";

interface StoredPick { storyId: string; marketId: string; blurb: string; blurbFacts: BlurbFacts }

export interface PublishedCard { cardId: string; storyId: string; playerName: string; blurb: string; facts: BlurbFacts; strike: number; yesPriceCents: number }
export interface PublishSummary { slateDate: string; curationRunId: number; asked: number; published: PublishedCard[]; skipped: Skip[] }

export type PublishResult =
  | ({ status: "ok"; runId: number } & PublishSummary)
  | { status: "no_games"; slateDate: string }
  | { status: "already_published"; slateDate: string; cards: number }
  | { status: "no_curation"; slateDate: string; runId: number | undefined }
  | { status: "nothing_publishable"; slateDate: string; runId: number | undefined; skipped: Skip[] }
  | { status: "config_error"; slateDate: string; runId: number | undefined; problems: string[] };

class NoCuration extends Error { constructor(day: string) { super(`no finished curation run for ${day}`); } }
class NothingPublishable extends Error { constructor(readonly skipped: Skip[]) { super("no pick passed the publish checks"); } }
class AlreadyPublished extends Error { constructor(readonly cards: number) { super("already published"); } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const isPick = (p: unknown): p is StoredPick => {
  const r = p as Record<string, unknown> | null;
  return !!r && typeof r.storyId === "string" && /^\d{1,15}$/u.test(r.storyId) && typeof r.marketId === "string" && UUID.test(r.marketId)
    && typeof r.blurb === "string" && typeof r.blurbFacts === "object" && r.blurbFacts !== null;
};

export async function runPublish(db: Db, opts: { alert: Alert; date?: string }): Promise<PublishResult> {
  const slateDate = await resolveSlateDate(db, opts.date);
  const games = await db.query(`select 1 from games where slate_date = $1 and league = $2 and status not in ('canceled', 'postponed') limit 1`, [slateDate, LEAGUE]);
  if (games.rowCount === 0) return { status: "no_games", slateDate };
  const done = await db.query(`select count(*)::int as n from cards where slate_date = $1`, [slateDate]);
  if (done.rows[0].n > 0) return { status: "already_published", slateDate, cards: done.rows[0].n };   // a harmless re-run isn't a pipeline run

  let summary: PublishSummary | undefined;
  let doneRunId = 0;
  try {
    await withRun(db, JOB, slateDate, async (runId) => {
      doneRunId = runId;
      const cfg = await loadCurationConfig(db);
      const rules = { bandMin: cfg.priceBandMin, bandMax: cfg.priceBandMax, maxChars: cfg.blurbMaxChars };
      const client = await db.connect();
      try {
        await client.query("begin");
        // One publish per day at a time; the lock is released at commit/rollback.
        await client.query(`select pg_advisory_xact_lock(hashtext('publish'), (select (extract(epoch from $1::date) / 86400)::int))`, [slateDate]);
        const existing = await client.query(`select count(*)::int as n from cards where slate_date = $1`, [slateDate]);
        if (existing.rows[0].n > 0) throw new AlreadyPublished(existing.rows[0].n);

        const run = await client.query(
          `select id, outputs from pipeline_runs where job = 'curate' and slate_date = $1 and status = 'ok' order by id desc limit 1`, [slateDate]);
        if (run.rowCount === 0 || !Array.isArray(run.rows[0].outputs?.picks)) throw new NoCuration(slateDate);
        const curationRunId = Number(run.rows[0].id);
        const skipped: Skip[] = [];
        const picks: StoredPick[] = [];
        for (const raw of run.rows[0].outputs.picks as unknown[]) {
          if (isPick(raw)) picks.push(raw);
          else skipped.push({ storyId: String((raw as { storyId?: unknown } | null)?.storyId ?? "?"), reason: "malformed", detail: "stored pick is missing a valid story, market, blurb or facts" });
        }

        const stories = await client.query(
          `select id::text as id, player_id, team_id, game_id, angle from story_shortlist where slate_date = $1 and id = any($2::bigint[])`,
          [slateDate, picks.map((p) => p.storyId)]);
        const storyOf = new Map(stories.rows.map((r) => [r.id as string, r]));
        const mk = await client.query(
          `select m.id, m.status::text as status, m.yes_ask_cents, m.game_id, m.player_id, m.strike::float8 as strike, p.full_name,
                  (g.tip_off_at <= now() or g.status::text <> 'scheduled') as started
             from markets m join games g on g.id = m.game_id left join players p on p.id = m.player_id where m.id = any($1::uuid[])`,
          [picks.map((p) => p.marketId)]);
        const marketOf = new Map(mk.rows.map((r) => [r.id as string, r]));

        const published: PublishedCard[] = [], players = new Set<string>();
        for (const p of picks) {
          const story = storyOf.get(p.storyId), m = marketOf.get(p.marketId);
          const blurb: CardBlurb = { storyId: p.storyId, blurb: p.blurb, facts: p.blurbFacts };
          if (!story) { skipped.push({ storyId: p.storyId, reason: "wrong_market", detail: "the story is no longer on the day's shortlist" }); continue; }
          const why = whyNotPublishable(blurb, { gameId: story.game_id, playerId: story.player_id },
            m && { status: m.status, yesAskCents: m.yes_ask_cents, gameId: m.game_id, playerId: m.player_id, strike: m.strike }, !!m?.started, rules);
          if (why) { skipped.push(why); continue; }
          if (players.has(story.player_id)) { skipped.push({ storyId: p.storyId, reason: "player_repeat", detail: "another card already uses this player" }); continue; }
          if (published.length >= cfg.cardsPerDay) { skipped.push({ storyId: p.storyId, reason: "over_deck_size", detail: `the deck is already ${cfg.cardsPerDay} cards` }); continue; }
          // A savepoint per card: one bad row (a player traded since curation, a constraint) leaves that card out, not the whole deck.
          await client.query("savepoint card");
          try {
            players.add(story.player_id);
            const ins = await client.query(
              `insert into cards (slate_date, sort_key, game_id, subject, player_id, team_id, market_id, blurb, blurb_facts, storyline_type, curation_run_id)
               values ($1, $2, $3, 'player', $4, $5, $6, $7, $8, $9, $10) returning id`,
              [slateDate, published.length + 1, story.game_id, story.player_id, story.team_id, p.marketId, p.blurb, JSON.stringify(p.blurbFacts), storylineTypeOf(story.angle), curationRunId]);
            published.push({ cardId: ins.rows[0].id, storyId: p.storyId, playerName: m!.full_name, blurb: p.blurb, facts: p.blurbFacts, strike: Number(m!.strike), yesPriceCents: m!.yes_ask_cents });
            await client.query("release savepoint card");
          } catch (e) {
            await client.query("rollback to savepoint card");
            players.delete(story.player_id);
            skipped.push({ storyId: p.storyId, reason: "insert_failed", detail: e instanceof Error ? e.message.slice(0, 160) : String(e) });
          }
        }
        if (published.length === 0) throw new NothingPublishable(skipped);
        await client.query("commit");
        summary = { slateDate, curationRunId, asked: cfg.cardsPerDay, published, skipped };
        return { curationRunId, asked: cfg.cardsPerDay, published: published.length, skipped };
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    });
    return { status: "ok", runId: doneRunId, ...summary! };
  } catch (err) {
    const runId = (err as { pipelineRunId?: number }).pipelineRunId;
    if (err instanceof AlreadyPublished) return { status: "already_published", slateDate, cards: err.cards };
    if (err instanceof NoCuration) {
      await opts.alert(alertText({ severity: "warning", job: JOB, headline: `${JOB}: no finished curation run for ${slateDate}, so nothing was published`,
        note: "Run the story and curation steps first: npm run job -- story, then npm run job -- curate" }));
      return { status: "no_curation", slateDate, runId };
    }
    if (err instanceof NothingPublishable) {
      await opts.alert(alertText({ severity: "failed", job: JOB, headline: `${JOB}: none of the curated cards could be published for ${slateDate}`,
        note: err.skipped.map((s) => `${s.storyId}: ${s.reason} (${s.detail})`).join("; ") }));
      return { status: "nothing_publishable", slateDate, runId, skipped: err.skipped };
    }
    if (err instanceof ConfigError) {
      await opts.alert(alertText({ severity: "failed", job: JOB, headline: `${JOB} can't run: ${err.problems.length} setting(s) missing or wrong in app_config`, error: err, note: err.problems.join("; ") }));
      return { status: "config_error", slateDate, runId, problems: err.problems };
    }
    throw err;
  }
}
