// STO-112 / STO-117: the story, curate and publish schedules against real Postgres. A missing row must skip only that job
// and alert, never stop the worker or the other jobs (the Nov 18 crash-loop, STO-106). Requires TEST_DATABASE_URL.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { loadConfig } from "../src/lib/config.js";
import { optionalScheduledJobs, scheduledJobs, afterStory, contextXJob } from "../src/jobs/index.js";
import { nextRunEt } from "../src/scheduler.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
let db: Db | null = null;
before(async () => { db = await freshDb("storyline_job_schedules_test"); });
after(async () => { await db?.end(); });

const feed = { post: async () => {} };
const alerts: string[] = [];
const alert = async (m: string) => { alerts.push(m); };
const names = (s: { job: { name: string } }[]) => s.map((x) => x.job.name);

test("the real database schedules story, curate and publish once a day after the ESPN pull, in that order", { skip }, async () => {
  alerts.length = 0;
  const boot = await loadConfig(db!);
  const all = [...scheduledJobs(boot, feed, alert), ...await optionalScheduledJobs(db!, feed, alert)];
  assert.deepEqual(names(all), ["ingest", "context:espn", "price_poll", "context:x", "story", "curate", "publish"]);
  assert.deepEqual(alerts, []);
  const from = new Date("2026-11-25T05:00:00Z");   // midnight ET, so each pattern's first run is today's
  const at = (name: string) => nextRunEt(all.find((s) => s.job.name === name)!.pattern!, from)!.getTime();
  assert.ok(at("context:espn") < at("context:x") && at("context:x") < at("story") && at("story") < at("curate") && at("curate") < at("publish"));
  assert.ok(at("publish") - from.getTime() < 24 * 3600_000, "each runs once in the day");
});

test("a missing schedule row skips only that job and alerts; the worker's startup config and the other jobs are unaffected", { skip }, async () => {
  alerts.length = 0;
  await db!.query(`delete from app_config where key = 'story_schedule_et'`);   // this file's database is its own
  const boot = await loadConfig(db!);                                          // what every job reads at startup: still loads
  assert.equal(boot.cardsPerDay, 10);
  const optional = await optionalScheduledJobs(db!, feed, alert);
  assert.deepEqual(names(optional), ["context:x", "curate", "publish"]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /story is not scheduled: missing story_schedule_et/);
});

test("a missing X schedule row skips only the X search and alerts; story still runs without X", { skip }, async () => {
  alerts.length = 0;
  await db!.query(`delete from app_config where key = 'context_x_schedule_et'`);
  const optional = await optionalScheduledJobs(db!, feed, alert);
  assert.ok(!names(optional).includes("context:x"));
  assert.ok(alerts.some((a) => /context:x is not scheduled: missing context_x_schedule_et/.test(a)));
  assert.equal(alerts.length, 2, "story (deleted in the test above) and context:x");
});

test("the scheduled X job makes no Grok call while the flag is off, whatever the key says", { skip }, async () => {
  await db!.query(`update feature_flags set enabled = false where key = 'context_x'`);
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("no network in tests"); }) as typeof fetch;
  try {
    const xjob = contextXJob(alert, feed, undefined, { XAI_API_KEY: "k" });
    assert.deepEqual(await xjob.run(db!), { status: "off", slateDate: (await db!.query(`select storyline_today()::text as d`)).rows[0].d });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = real; }
});

test("a malformed schedule row is skipped the same way, for curate and publish too", { skip }, async () => {
  alerts.length = 0;
  await db!.query(`delete from app_config where key in ('curate_schedule_et', 'publish_schedule_et')`);
  assert.deepEqual(names(await optionalScheduledJobs(db!, feed, alert)), []);
  assert.equal(alerts.length, 4, "context:x and story (still deleted), curate and publish each alert once");
  // The database refuses a bad shape on write; a value that passes the shape but croner can't parse is caught by the loader.
  await db!.query(`insert into app_config (key, value, value_type, is_public, description) values ('curate_schedule_et', '"99 99 * * *"', 'string', false, 'x')`);
  alerts.length = 0;
  assert.deepEqual(names(await optionalScheduledJobs(db!, feed, alert)), []);
  assert.ok(alerts.some((a) => /curate is not scheduled: curate_schedule_et/.test(a)));
});

test("a failing alert webhook can't stop the loader", { skip }, async () => {
  const out = await optionalScheduledJobs(db!, feed, async () => { throw new Error("webhook down"); });
  assert.ok(Array.isArray(out));
});

// ---------------------------------------------------------------- curate refuses to run unless today's story run succeeded

test("scheduled curate runs only when the latest story run for today is ok; otherwise it alerts and runs nothing", { skip }, async () => {
  const today = (await db!.query(`select storyline_today()::text as d`)).rows[0].d;
  let ran = 0;
  const inner = { name: "curate", run: async () => { ran++; return { status: "ok" }; } };
  const guarded = afterStory(inner, alert);
  const story = (status: string, date = today) => db!.query(`insert into pipeline_runs (job, slate_date, status) values ('story', $1, $2)`, [date, status]);

  alerts.length = 0;
  await guarded.run(db!);
  assert.equal(ran, 0, "no story run at all");
  await story("ok", "2000-01-01");
  await guarded.run(db!);
  assert.equal(ran, 0, "a story run for another day doesn't count");
  await story("failed");
  await guarded.run(db!);
  assert.equal(ran, 0, "a failed story run");
  await story("running");
  await guarded.run(db!);
  assert.equal(ran, 0, "a story run still in progress");
  assert.equal(alerts.length, 4, "every refusal alerts");
  assert.match(alerts[2]!, /story run is failed/);

  await story("ok");
  assert.deepEqual(await guarded.run(db!), { status: "ok" });
  assert.equal(ran, 1, "an ok story run lets it through");
  await story("failed");
  await guarded.run(db!);
  assert.equal(ran, 1, "the latest story run decides (a later failed re-run blocks)");
  const curateRuns = await db!.query(`select 1 from pipeline_runs where job = 'curate'`);
  assert.equal(curateRuns.rowCount, 0, "a refused run leaves no curate run behind");
});
