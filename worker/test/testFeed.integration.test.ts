// The ingest job posts its summary to the Discord test feed (STO-40), and a broken Discord never
// fails or retries the ingest. Recorded fixtures in, real Postgres out.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { ingestJob } from "../src/jobs/index.js";
import { testFeed } from "../src/lib/testFeed.js";
import { runJob } from "../src/scheduler.js";
import { freshDb } from "./helpers/testDb.js";
import { installFetch, json, slateRoutes, type Route } from "./helpers/mockFetch.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const TEST_URL = "https://discord.test/api/webhooks/test";
let db: Db | null = null;

before(async () => { db = await freshDb("storyline_test_feed_test"); });
after(async () => { await db?.end(); });

/** Discord replies with `reply`; every request body sent to it is kept. */
function withDiscord(reply: () => Response) {
  const posts: any[] = [];
  const discord: Route = (url) => (url.hostname === "discord.test" ? reply() : undefined);
  const m = installFetch(slateRoutes, discord);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    if (String(input).startsWith(TEST_URL)) posts.push(JSON.parse(init.body));
    return original(input, init);
  }) as typeof fetch;
  return { posts, calls: m.calls, restore: () => { globalThis.fetch = original; m.restore(); } };
}

const runIngest = () => runJob(db!, ingestJob(testFeed({ DISCORD_TEST_WEBHOOK_URL: TEST_URL }, () => {}), "2026-11-13"),
  async () => { throw new Error("no alert expected"); });

test("a Discord outage doesn't fail or retry the ingest", { skip }, async () => {
  const quiet = console.error;
  console.error = () => {};
  const d = withDiscord(() => json({ message: "Internal Server Error" }, 500));
  try {
    const outcome = await runIngest();
    assert.equal(outcome.status, "ok");
    assert.equal(d.calls.filter((c) => c.startsWith(TEST_URL)).length, 1, "one attempt, no retry");
  } finally {
    d.restore();
    console.error = quiet;
  }
  const { rows } = await db!.query(`select status from pipeline_runs where job = 'ingest' order by id`);
  assert.deepEqual(rows.map((r) => r.status), ["ok"]);
});

test("each ingest posts one summary of what it loaded, including on a re-run", { skip }, async () => {
  const d = withDiscord(() => new Response(null, { status: 204 }));
  try {
    assert.equal((await runIngest()).status, "ok");
  } finally {
    d.restore();
  }
  assert.equal(d.posts.length, 1);
  const text: string = d.posts[0].content;
  assert.match(text, /slate 2026-11-13/);
  assert.match(text, /Games: 1 · Markets: 211 \(PTS 37 · REB 46 · AST 41 · 3PT 54 · PRA 31 · GAME 2\)/);
  assert.match(text, /0 unmatched/);
  assert.match(text, /Jalen Suggs \(ORL\): Out/);
  assert.ok(text.length < 2000);
});

test("nothing the test feed does can fail an ingest that succeeded", { skip }, async () => {
  const quiet = console.error;
  console.error = () => {};
  const restore = installFetch(slateRoutes).restore;
  try {
    const broken = { post: async () => { throw new Error("feed bug"); } };
    const outcome = await runJob(db!, ingestJob(broken, "2026-11-13"), async () => { throw new Error("no alert expected"); });
    assert.equal(outcome.status, "ok");
  } finally {
    restore();
    console.error = quiet;
  }
});
