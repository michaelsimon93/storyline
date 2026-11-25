// The #testing account-review post (STO-75): one line per account, within Discord's limit, and an approve statement that can't be
// bent into anything else. Tier 4 glue with real branches (chunking, SQL building), so it is tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import { approveStatement, accountLine, xSummaryMessages } from "../src/lib/xText.js";
import type { XSummary, ReviewLine } from "../src/jobs/contextX.js";

const line = (o: Partial<ReviewLine> & { handle: string }): ReviewLine => ({ status: "unreviewed", isNew: true, storiesCiting: 1, sampleUrl: `https://x.com/${o.handle}/status/1`, sampleExcerpt: "Cade is out tonight", ...o });
const summary = (accounts: ReviewLine[], o: Partial<XSummary> = {}): XSummary => ({
  slateDate: "2026-11-25", runId: 1, mode: "report_only", storiesKept: 3, dropped: [], postsKept: 4, postsOverCap: 0, signalsStored: 0, stories: [],
  spend: { costTicks: 1361488000, usdEstimate: 0.136, postsFetched: 24, searchCalls: 3 }, accounts, ...o,
});

test("approveStatement builds an update for valid handles only", () => {
  assert.equal(approveStatement(["shams", "a_b9"]), "update x_accounts set status = 'approved' where handle in ('shams', 'a_b9');");
  assert.match(approveStatement(["spam"], "rejected"), /status = 'rejected'/);
});

test("approveStatement refuses anything that isn't a handle, so a hostile post can't reach the SQL", () => {
  for (const bad of ["x'); drop table x_accounts; --", "Shams", "@shams", "a b", "", "a".repeat(16)]) assert.throws(() => approveStatement(["ok", bad]), /not an X handle/, bad);
  assert.throws(() => approveStatement([]), /no handles/);
});

test("an account line has the handle, profile link, how many stories cited it and one sample post; no follower count", () => {
  const t = accountLine(line({ handle: "shams", storiesCiting: 2 }));
  assert.match(t, /@shams/); assert.match(t, /<https:\/\/x\.com\/shams>/); assert.match(t, /cited by 2 stories/); assert.match(t, /Cade is out tonight/);
  assert.doesNotMatch(t, /follower/i);
  assert.match(accountLine(line({ handle: "a", storiesCiting: 1 })), /cited by 1 story/);
});

test("a sample post can't break the message: backticks and newlines are flattened, long text is clipped", () => {
  const t = accountLine(line({ handle: "a", sampleExcerpt: "line one\n`code` @everyone " + "x".repeat(400) }));
  assert.equal(t.split("\n").length, 2);
  assert.doesNotMatch(t.split("\n")[1]!, /`/);
  assert.ok(t.length < 400);
});

test("unreviewed accounts come first, then approved, then rejected; the approve statement lists only the unreviewed", () => {
  const [m] = xSummaryMessages(summary([line({ handle: "zed", status: "approved", isNew: false }), line({ handle: "bot", status: "rejected", isNew: false }), line({ handle: "new1" })]));
  assert.ok(m!.indexOf("@new1") < m!.indexOf("@zed") && m!.indexOf("@zed") < m!.indexOf("@bot"));
  assert.match(m!, /handle in \('new1'\)/);
  assert.doesNotMatch(m!, /handle in \([^)]*zed/);
});

test("the header says report-only, the spend as an estimate, and what was dropped", () => {
  const [m] = xSummaryMessages(summary([line({ handle: "a" })], { dropped: [{ story: "Giannis and Embiid", reason: "player not on tonight's slate" }] }));
  assert.match(m!, /report only/); assert.match(m!, /about \$0\.14 \(estimate\)/); assert.match(m!, /Giannis and Embiid \(player not on tonight's slate\)/);
});

test("many accounts continue in more messages, each under Discord's 2000 characters, none cut mid-line", () => {
  const many = Array.from({ length: 60 }, (_, i) => line({ handle: `acct_${i}`, sampleExcerpt: "y".repeat(300) }));
  const ms = xSummaryMessages(summary(many));
  assert.ok(ms.length > 1);
  for (const m of ms) assert.ok(m.length <= 2000, `${m.length}`);
  assert.equal(ms.join("\n").match(/@acct_\d+/g)!.length, 60, "every account appears once");
});

test("no accounts: the post says so instead of an empty list", () => {
  assert.match(xSummaryMessages(summary([]))[0]!, /No accounts this run/);
});

// Attacks: the header isn't chunked and a dropped story's subject is Grok's text, unbounded. Five long subjects push the first
// message over Discord's 2000-character limit, so the whole account review post is rejected.
test("long dropped-story subjects still keep every message under Discord's 2000 characters", () => {
  const dropped = Array.from({ length: 5 }, (_, i) => ({ story: `Story ${i} ` + "about a player and another player ".repeat(15), reason: "player not on tonight's slate" }));
  for (const m of xSummaryMessages(summary([line({ handle: "a" })], { dropped }))) assert.ok(m.length <= 2000, `${m.length}`);
});
