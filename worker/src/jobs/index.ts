// The job registry: every scheduled job and the config key holding its schedule.
// New jobs (poller, curation, settlement, out-status) are added here in their own PRs.

import type { Config } from "../lib/config.js";
import type { TestFeed } from "../lib/testFeed.js";
import { ingestSummaryText, storySummaryMessages } from "../lib/feedText.js";
import type { Job, Scheduled } from "../scheduler.js";
import type { Db } from "../lib/db.js";
import { loadOptionalSchedules } from "../lib/jobSchedules.js";
import { alertText } from "../lib/alertText.js";
import { ingest, resolveSlateDate } from "./ingest.js";
import { pollPrices } from "./poller.js";
import { runEspnContext, JOB as CONTEXT_ESPN_JOB, type ContextRunResult } from "./contextEspn.js";
import type { Alert } from "../lib/alert.js";
import { runXContext, JOB as CONTEXT_X_JOB, KEY_ENV as XAI_KEY_ENV } from "./contextX.js";
import { xSummaryMessages } from "../lib/xText.js";
import { runStories, JOB as STORY_JOB } from "./stories.js";
import { runCuration, JOB as CURATE_JOB } from "./curate.js";
import { postCuration } from "../lib/curationText.js";
import { runPublish, JOB as PUBLISH_JOB } from "./publish.js";
import { postPublish } from "../lib/publishText.js";
import type { CurationRequest } from "../sources/curate.js";
import type { BlurbRequest } from "../sources/claudeBlurbs.js";
import type { Curator } from "../sources/types.js";

/** Ingest, then post its summary to the test feed. No date = today's slate (storyline_today()). */
export function ingestJob(feed: TestFeed, date?: string): Job {
  return {
    name: "ingest",
    run: async (db) => {
      const summary = await ingest(db, date);
      // The run is already recorded ok: nothing about the test feed may fail it (STO-40).
      try {
        await feed.post(ingestSummaryText(summary));
      } catch (err) {
        console.error(`test feed: could not post ingest summary: ${err instanceof Error ? err.message : err}`);
      }
      return summary;
    },
  };
}

/** The ESPN context pull. Scheduled runs use today's slate; the result is trimmed (no signal bodies) for the log. */
export function contextEspnJob(alert: Alert, date?: string): Job {
  return {
    name: CONTEXT_ESPN_JOB,
    run: async (db) => {
      const r: ContextRunResult = await runEspnContext(db, { alert, date });
      if (r.status !== "fallback") return r;
      const dates = r.signals.map((s) => s.evidence.observedAt).sort();   // how stale the stand-in is, for whoever reads the log
      return { ...r, signals: r.signals.length, oldestObservedAt: dates[0] ?? null, newestObservedAt: dates[dates.length - 1] ?? null };
    },
  };
}

/**
 * The X search (STO-75): Grok proposes stories; the stories and the accounts it pulled from go to #testing for review.
 * Scheduled daily through its own tolerant loader (STO-145), before the story step; also runnable by hand: `npm run job -- context:x`.
 * The `context_x` flag is checked on every run, so switching it off stops the spend without touching the schedule.
 */
export function contextXJob(alert: Alert, feed: TestFeed, date?: string, env: NodeJS.ProcessEnv = process.env): Job {
  return {
    name: CONTEXT_X_JOB,
    run: async (db) => {
      const r = await runXContext(db, { alert, date, apiKey: env[XAI_KEY_ENV]?.trim() || undefined });
      if (r.status !== "ok") return r;
      try {
        for (const m of xSummaryMessages(r.summary)) await feed.post(m);
      } catch (err) {
        console.error(`test feed: could not post X summary: ${err instanceof Error ? err.message : err}`);
      }
      const { accounts, stories: _stories, ...counts } = r.summary;   // the log keeps the counts; the accounts live in x_accounts
      return { ...counts, accounts: accounts.length, newAccounts: accounts.filter((a) => a.isNew).length };
    },
  };
}

/**
 * The story step (STO-76): find the day's stories, match each to a market, store the shortlist, post it to #testing.
 * Scheduled through its own tolerant loader (STO-112); also runnable by hand: `npm run job -- story`.
 */
export function storyJob(alert: Alert, feed: TestFeed, date?: string): Job {
  return {
    name: STORY_JOB,
    run: async (db) => {
      const r = await runStories(db, { alert, date });
      if (r.status !== "ok") return r;   // the alert has gone out; the run is recorded as failed
      // The run is already recorded ok: nothing about the test feed may fail it (STO-40).
      try {
        for (const m of storySummaryMessages(r.summary)) await feed.post(m);
      } catch (err) {
        console.error(`test feed: could not post story summary: ${err instanceof Error ? err.message : err}`);
      }
      return r;
    },
  };
}

/**
 * The curation step (STO-11): Claude ranks the day's shortlist and picks the cards; the picks and reasons go to #testing.
 * Scheduled through its own tolerant loader, behind `afterStory` (STO-117); by hand `npm run job -- curate` is unguarded.
 */
export function curateJob(alert: Alert, feed: TestFeed, date?: string, curator?: Curator<CurationRequest, unknown>, blurbWriter?: Curator<BlurbRequest, unknown>, styleGuide?: string): Job {
  return {
    name: CURATE_JOB,
    run: async (db) => {
      const r = await runCuration(db, { alert, date, curator, blurbWriter, styleGuide });
      if (r.status !== "ok") return r;   // the alert has gone out; the run is recorded
      // The run is already recorded ok: nothing about the test feed may fail it (STO-40).
      try {
        await postCuration(feed, r.posted.shown, r.posted.selection, r.posted.attemptsUsed, r.posted.asked, r.posted.blurbs);
      } catch (err) {
        console.error(`test feed: could not post curation: ${err instanceof Error ? err.message : err}`);
      }
      const { posted: _posted, ...summary } = r;   // the run's result is the counts, not the whole deck
      return summary;
    },
  };
}

/**
 * The publish step (STO-12): the latest curation run's cards go live, and #testing gets the deck. Run on demand:
 * `npm run job -- publish`, after curate; also scheduled (STO-117).
 */
export function publishJob(alert: Alert, feed: TestFeed, date?: string): Job {
  return {
    name: PUBLISH_JOB,
    run: async (db) => {
      const r = await runPublish(db, { alert, date });
      if (r.status !== "ok") return r;
      try {
        await postPublish(feed, r);
      } catch (err) {
        console.error(`test feed: could not post publish: ${err instanceof Error ? err.message : err}`);
      }
      return { status: r.status, slateDate: r.slateDate, runId: r.runId, published: r.published.length, asked: r.asked, skipped: r.skipped };
    },
  };
}

/**
 * The scheduled curate run refuses to start unless today's latest story run succeeded (STO-117): curating a stale or missing
 * shortlist would publish yesterday's idea of the day. It alerts and publishes nothing. A refused run writes no pipeline_runs row;
 * the alert is its only trace. Not applied to `npm run job -- curate`.
 */
export function afterStory(inner: Job, alert: Alert, date?: string): Job {
  return {
    name: inner.name,
    run: async (db) => {
      const slateDate = await resolveSlateDate(db, date);
      const { rows } = await db.query<{ status: string }>(
        `select status from pipeline_runs where job = $1 and slate_date = $2 order by id desc limit 1`, [STORY_JOB, slateDate]);
      const story = rows[0]?.status;
      if (story === "ok") return inner.run(db);
      await alert(alertText({
        severity: "failed", job: inner.name,
        headline: `${inner.name} did not run: ${story ? `today's story run is ${story}` : "no story run for today"} (${slateDate})`,
        note: `Nothing was curated or published. Fix the story step, then run by hand: npm run job -- story, then curate, then publish.`,
      }));
      return { status: "skipped_no_story", slateDate, storyRun: story ?? null };
    },
  };
}

/** Jobs that run only when asked (`npm run job -- <name>`), not on a schedule. */
export function onDemandJobs(feed: TestFeed, alert: Alert): Job[] {
  return [contextXJob(alert, feed), storyJob(alert, feed), curateJob(alert, feed), publishJob(alert, feed)];
}

export function scheduledJobs(config: Config, feed: TestFeed, alert: Alert): Scheduled[] {
  return [
    { job: ingestJob(feed), pattern: config.ingestScheduleEt },
    { job: contextEspnJob(alert), pattern: config.contextEspnScheduleEt },
    { job: { name: "price_poll", run: (db) => pollPrices(db) }, everySeconds: config.pollerIntervalSeconds },
  ];
}

/** The X search, story, curate and publish steps, each on its own `app_config` schedule; a bad or missing row skips only that job and alerts. */
export function optionalScheduledJobs(db: Db, feed: TestFeed, alert: Alert): Promise<Scheduled[]> {
  return loadOptionalSchedules(db, alert, [
    { key: "context_x_schedule_et", job: contextXJob(alert, feed) },
    { key: "story_schedule_et", job: storyJob(alert, feed) },
    { key: "curate_schedule_et", job: afterStory(curateJob(alert, feed), alert) },
    { key: "publish_schedule_et", job: publishJob(alert, feed) },
  ]);
}
