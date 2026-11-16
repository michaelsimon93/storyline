// The Discord test feed (STO-40): which channel it posts to, when it's off, and that a failed
// post never throws or retries. Plus the ingest summary message.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { testFeed } from "../src/lib/testFeed.js";
import { webhookAlert } from "../src/lib/alert.js";
import { ingestSummaryText } from "../src/lib/feedText.js";
import type { IngestSummary } from "../src/jobs/ingest.js";
import { installFetch, json } from "./helpers/mockFetch.js";

let restore = () => {};
afterEach(() => restore());

const TEST_URL = "https://discord.test/api/webhooks/test";
const ALERT_URL = "https://discord.test/api/webhooks/alerts";

/** Record every POST body by URL; reply with `status`. */
function captureFetch(status = 204) {
  const original = globalThis.fetch;
  const posts: { url: string; body: any }[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    posts.push({ url: String(input), body: JSON.parse(init.body) });
    return new Response(null, { status });
  }) as typeof fetch;
  restore = () => { globalThis.fetch = original; };
  return posts;
}

test("the feed posts only to DISCORD_TEST_WEBHOOK_URL, never the alerts webhook", async () => {
  const posts = captureFetch();
  const feed = testFeed({ DISCORD_TEST_WEBHOOK_URL: TEST_URL, ALERT_WEBHOOK_URL: ALERT_URL }, () => {});
  await feed.post("hello @everyone");
  assert.deepEqual(posts.map((p) => p.url), [TEST_URL]);
  assert.equal(posts[0]!.body.content, "hello @everyone");
  assert.deepEqual(posts[0]!.body.allowed_mentions, { parse: [] }, "text in a post must never ping the channel");
});

test("alerts never post to the test feed's webhook", async () => {
  const posts = captureFetch();
  const saved = { a: process.env.ALERT_WEBHOOK_URL, t: process.env.DISCORD_TEST_WEBHOOK_URL };
  delete process.env.ALERT_WEBHOOK_URL;
  process.env.DISCORD_TEST_WEBHOOK_URL = TEST_URL;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    await webhookAlert()("ingest failed");
  } finally {
    console.error = originalError;
    for (const [k, v] of [["ALERT_WEBHOOK_URL", saved.a], ["DISCORD_TEST_WEBHOOK_URL", saved.t]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.equal(posts.length, 0, "with ALERT_WEBHOOK_URL unset, an alert is logged, not sent anywhere");
  assert.match(errors.join("\n"), /ALERT_WEBHOOK_URL not set/);
});

test("unset URL: the feed is a no-op and says so once", async () => {
  const posts = captureFetch();
  const logs: string[] = [];
  const feed = testFeed({ ALERT_WEBHOOK_URL: ALERT_URL }, (l) => logs.push(l));
  await feed.post("a");
  await feed.post("b");
  assert.equal(posts.length, 0);
  assert.deepEqual(logs, ["discord test feed off (DISCORD_TEST_WEBHOOK_URL not set)"]);
});

test("DISCORD_TEST_FEED_ENABLED=false turns the feed off while keeping the URL", async () => {
  for (const value of ["false", "0", "off", " OFF "]) {
    const posts = captureFetch();
    const logs: string[] = [];
    const feed = testFeed({ DISCORD_TEST_WEBHOOK_URL: TEST_URL, DISCORD_TEST_FEED_ENABLED: value }, (l) => logs.push(l));
    await feed.post("a");
    assert.equal(posts.length, 0, `value ${JSON.stringify(value)}`);
    assert.match(logs[0]!, /off \(DISCORD_TEST_FEED_ENABLED=/);
    restore();
  }
  // Any other value (or none) leaves it on.
  for (const value of [undefined, "true", "1"]) {
    const posts = captureFetch();
    await testFeed({ DISCORD_TEST_WEBHOOK_URL: TEST_URL, DISCORD_TEST_FEED_ENABLED: value }, () => {}).post("a");
    assert.equal(posts.length, 1, `value ${JSON.stringify(value)}`);
    restore();
  }
});

test("a failed post never throws and is never retried", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const reply of [() => json({ message: "rate limited" }, 429, { "retry-after": "1" }),
                         () => json({}, 500),
                         () => { throw new Error("network down"); }]) {
      const m = installFetch(reply);
      restore = m.restore;
      await assert.doesNotReject(testFeed({ DISCORD_TEST_WEBHOOK_URL: TEST_URL }, () => {}).post("x"));
      assert.equal(m.calls.length, 1, "exactly one attempt");
      restore();
    }
  } finally {
    console.error = quiet;
  }
});

// ------------------------------------------------------------------ ingest summary message

function summary(over: Partial<IngestSummary> = {}): IngestSummary {
  return {
    slateDate: "2026-11-13", games: 1,
    markets: { KXNBAPTS: 37, KXNBAREB: 46, KXNBAGAME: 2 },
    players: { total: 40, exact: 38, fuzzy: 1, unmatched: ["Bob Jones (ORL)"], ambiguous: [], reissued: [] },
    outOrDoubtful: ["Jalen Suggs (ORL): Out"], skipped: [], snapshots: 85,
    ...over,
  };
}

test("the ingest summary shows slate, games, markets, matches and what was skipped", () => {
  const text = ingestSummaryText(summary({ skipped: ["KXNBAPTS-26NOV13MILORL-X-25: unknown team XXX"] }));
  assert.match(text, /slate 2026-11-13/);
  assert.match(text, /Games: 1 · Markets: 85 \(PTS 37 · REB 46 · GAME 2\)/);
  assert.match(text, /Players: 39\/40 matched \(38 exact, 1 fuzzy\) · 1 unmatched · 0 ambiguous/);
  assert.match(text, /Unmatched \(1\)\*\*\n• Bob Jones \(ORL\)/);
  assert.match(text, /Skipped markets \(1\)\*\*\n• KXNBAPTS-26NOV13MILORL-X-25: unknown team XXX/);
  assert.match(text, /Out \/ doubtful \(1\)/);
  assert.doesNotMatch(text, /Ambiguous|re-issued/, "empty lists are left out");
});

test("a slate with no games says so", () => {
  assert.equal(ingestSummaryText(summary({ games: 0, markets: {} })),
    "📥 **Ingest · slate 2026-11-13**\nNo games on this slate.");
});

test("long lists are capped and the message stays under Discord's 2000-char limit, counts intact", () => {
  const many = Array.from({ length: 300 }, (_, i) => `KXNBAPTS-26NOV13MILORL-PLAYER${i}-25: some long reason why it failed`);
  const text = ingestSummaryText(summary({
    skipped: many, players: { ...summary().players, unmatched: many, ambiguous: many, reissued: many },
  }));
  assert.ok(text.length < 2000, `got ${text.length}`);
  for (const label of ["Unmatched", "Ambiguous \\(left unmatched\\)", "Kalshi re-issued player ids", "Skipped markets"]) {
    assert.match(text, new RegExp(`${label} \\(300\\)`), `${label}: the count survives even when items are cut`);
  }
  assert.match(text, /…and \d+ more/);
  assert.doesNotMatch(text, /truncated/, "shrinking the lists was enough; nothing was cut mid-message");
});
