// What Grok's answer becomes (STO-75): the rules that decide whether a claim may reach curation at all. Tier 2 (external data,
// against the recorded response) and tier 3 (invariants). Pure: no database, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/mockFetch.js";
import { story } from "./helpers/xai.js";
import { parsePost, parseStories, resolveSubject, buildX, storiesPrompt, type XSlateRef } from "../src/domain/xStories.js";
import { askGrok } from "../src/sources/grok.js";

// Tonight's slate as the recorded answer needs it: Pistons-Celtics, Mavericks-Nuggets. Ids are made up.
const ref: XSlateRef = {
  teams: [{ id: 1, name: "Detroit Pistons" }, { id: 2, name: "Boston Celtics" }, { id: 3, name: "Dallas Mavericks" }, { id: 4, name: "Denver Nuggets" }, { id: 5, name: "Portland Trail Blazers" }, { id: 6, name: "Los Angeles Lakers" }, { id: 7, name: "Los Angeles Clippers" }],
  games: [{ id: "g-dal-den", homeTeamId: 4, awayTeamId: 3 }, { id: "g-bos-det", homeTeamId: 2, awayTeamId: 1 }],
  players: [{ id: "p-cade", name: "Cade Cunningham", teamId: 1 }, { id: "p-jokic", name: "Nikola Jokić", teamId: 4 }, { id: "p-jj-1", name: "Jaren Jackson Jr.", teamId: 2 }, { id: "p-jj-2", name: "Jaren Jackson", teamId: 3 }],
};
const base = { ref, approved: new Set<string>(), observedAt: "2026-11-25T23:00:00.000Z", maxStories: 10, maxPosts: 50 };

/** The recorded answer: the message text of test/fixtures/xai-x-search-stories-2026-11-25.json. */
const recorded = () => {
  const r = fixture("xai-x-search-stories-2026-11-25.json") as { output: { type: string; content?: { text: string }[] }[] };
  return JSON.parse(r.output.find((o) => o.type === "message")!.content![0]!.text) as unknown;
};

// ---------------------------------------------------------------- the recorded answer

test("recorded answer: stories we can name are kept; two-player stories and players off the slate are dropped, and listed", () => {
  const b = buildX({ ...base, answer: recorded() });
  assert.deepEqual(b.stories.map((s) => s.subject), ["Detroit Pistons", "Boston Celtics", "Dallas Mavericks vs Denver Nuggets"]);
  assert.deepEqual(b.dropped.map((d) => [d.story, d.reason]), [
    ["Giannis Antetokounmpo and Joel Embiid", "player not on tonight's slate"],
    ["Victor Wembanyama and De'Aaron Fox", "player not on tonight's slate"],
  ]);
  assert.deepEqual(b.stories.map((s) => s.kind), ["team", "team", "game"]);
  for (const st of b.stories) assert.ok(st.handles.length > 0 && st.handles.every((h) => b.accounts.some((a) => a.handle === h)), "each story names accounts the review lists");
});

test("recorded answer: every signal has the post URL and the account handle, and none is trusted yet", () => {
  const b = buildX({ ...base, answer: recorded() });
  assert.ok(b.signals.length >= 4);
  for (const s of b.signals) {
    assert.match(s.evidence.url!, /^https:\/\/x\.com\/[a-z0-9_]+\/status\/\d+$/iu);
    assert.equal(s.evidence.url!.split("/")[3]!.toLowerCase(), s.evidence.handle, "the handle is the one in the URL");
    assert.equal(s.trust, "unreviewed", "no account is approved, so nothing may be quoted");
    assert.equal(s.evidence.observedAt, "2026-11-25T23:00:00.000Z");
    assert.ok(s.evidence.quote && s.summary.includes(s.evidence.quote));
  }
});

test("recorded answer: the same post under two stories is one signal per subject, not one per mention", () => {
  const b = buildX({ ...base, answer: recorded() });
  const keys = b.signals.map((s) => `${s.subject.kind}:${(s.subject as { id: string | number }).id}|${s.key}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(b.signals.some((s) => s.key === "x:2125447623779705198"), "Pulssix's post is cited under three subjects");
  assert.equal(b.signals.filter((s) => s.key === "x:2125447623779705198").length, 3);
});

// ---------------------------------------------------------------- trust (ADR-024 rule 2)

test("a post from an approved account is attributed; every other is unreviewed", () => {
  const b = buildX({ ...base, approved: new Set(["inquirersports"]), answer: recorded() });
  const by = (h: string) => new Set(b.signals.filter((s) => s.evidence.handle === h).map((s) => s.trust));
  assert.deepEqual([...by("inquirersports")], ["attributed"]);
  assert.deepEqual([...by("pulssix")], ["unreviewed"]);
});

test("the handle comes from the URL: Grok naming a different account doesn't change who is credited", () => {
  const a = { stories: [{ ...story("Detroit Pistons", "team", [["realreporter", "111", "Cade is out"]]), posts: [{ url: "https://x.com/realreporter/status/111", handle: "@shams", excerpt: "Cade is out" }] }] };
  const b = buildX({ ...base, approved: new Set(["shams"]), answer: a });
  assert.deepEqual([b.signals[0]!.evidence.handle, b.signals[0]!.trust], ["realreporter", "unreviewed"], "approving @shams doesn't approve a post that isn't from @shams");
});

// ---------------------------------------------------------------- a claim needs a post

test("a post must be a real X status URL; twitter.com is accepted and normalised", () => {
  assert.equal(parsePost({ url: "https://twitter.com/Shams/status/123?s=20", excerpt: "x" })!.url, "https://x.com/Shams/status/123");
  assert.equal(parsePost({ url: "https://x.com/Shams/status/123", excerpt: "x" })!.handle, "shams");
  for (const url of ["https://x.com/Shams", "https://x.com/Shams/status/", "https://example.com/Shams/status/1", "https://x.com.evil.test/a/status/1", "x.com/a/status/1", "", "https://x.com/a_very_long_handle_name/status/1"]) {
    assert.equal(parsePost({ url, excerpt: "x" }), null, url);
  }
  assert.equal(parsePost({ url: "https://x.com/a/status/1", excerpt: "   " }), null, "a post with no words is no evidence");
  assert.equal(parsePost({ url: 5, excerpt: "x" }), null);
});

test("a story with no valid post is dropped and reported, even though its subject resolves", () => {
  const a = { stories: [{ ...story("Detroit Pistons", "team", []) }, { ...story("Boston Celtics", "team", []), posts: [{ url: "https://x.com/a", handle: "a", excerpt: "x" }] }] };
  const b = buildX({ ...base, answer: a });
  assert.deepEqual(b.signals, []);
  assert.deepEqual(b.dropped.map((d) => d.reason), ["no post behind it", "no post behind it"]);
});

test("a malformed answer is an error to report, not an empty success", () => {
  for (const bad of [null, "sorry, I can't", {}, { stories: "none" }]) assert.throws(() => parseStories(bad, 5), /no stories list/);
});

// ---------------------------------------------------------------- resolving to our ids

test("players resolve by full name, ignoring accents and suffixes; ambiguity and strangers don't resolve", () => {
  const r = (subject: string) => resolveSubject({ subject, kind: "player" }, ref);
  assert.deepEqual(r("Nikola Jokic"), { subject: { kind: "player", id: "p-jokic" } });
  assert.deepEqual(r("Cade Cunningham"), { subject: { kind: "player", id: "p-cade" } });
  assert.deepEqual(r("Jaren Jackson"), { unresolved: "ambiguous player name" }, "Jr. is stripped, so two players share the name: never guess");
  assert.deepEqual(r("LeBron James"), { unresolved: "player not on tonight's slate" });
  assert.deepEqual(r("Cade"), { unresolved: "player not on tonight's slate" });
});

test("teams resolve by full name or nickname; a city alone, or a city with two teams, doesn't", () => {
  const r = (subject: string) => resolveSubject({ subject, kind: "team" }, ref);
  assert.deepEqual(r("Pistons"), { subject: { kind: "team", id: 1 } });
  assert.deepEqual(r("Trail Blazers"), { subject: { kind: "team", id: 5 } });
  assert.deepEqual(r("Los Angeles"), { unresolved: "team not on tonight's slate" });
  assert.deepEqual(r("Warriors"), { unresolved: "team not on tonight's slate" });
});

test("a game resolves only when both teams play each other tonight, in either order", () => {
  const r = (subject: string) => resolveSubject({ subject, kind: "game" }, ref);
  assert.deepEqual(r("Denver Nuggets vs Dallas Mavericks"), { subject: { kind: "game", id: "g-dal-den" } });
  assert.deepEqual(r("Mavericks at Nuggets"), { subject: { kind: "game", id: "g-dal-den" } });
  assert.deepEqual(r("Pistons vs Nuggets"), { unresolved: "those teams aren't playing each other tonight" });
  assert.deepEqual(r("Pistons vs Pistons"), { unresolved: "game's teams not found" });
  assert.deepEqual(r("The Mavs game"), { unresolved: "game not written as two teams" });
});

// ---------------------------------------------------------------- caps and size

test("the post cap holds: posts past it are dropped and counted, never stored", () => {
  const a = { stories: [story("Detroit Pistons", "team", [["a", "1", "one"], ["b", "2", "two"]]), story("Boston Celtics", "team", [["c", "3", "three"], ["d", "4", "four"]]), story("Nikola Jokić", "player", [["e", "5", "five"]])] };
  const b = buildX({ ...base, maxPosts: 3, answer: a });
  assert.equal(b.signals.length, 3);
  assert.equal(b.postsOverCap, 2, "one of Boston's posts, and Jokic's");
  assert.deepEqual(b.dropped.map((d) => [d.story, d.reason]), [["Nikola Jokić", "post cap reached"]]);
  assert.deepEqual(b.accounts.map((x) => x.handle).sort(), ["a", "b", "c"], "an account is listed only if a kept post came from it");
});

test("the story cap holds, and the account list counts the stories that cited each account", () => {
  const a = { stories: [story("Detroit Pistons", "team", [["a", "1", "one"]]), story("Boston Celtics", "team", [["a", "2", "two"]]), story("Nikola Jokić", "player", [["a", "3", "three"]])] };
  assert.equal(buildX({ ...base, maxStories: 2, answer: a }).stories.length, 2);
  const acct = buildX({ ...base, answer: a }).accounts;
  assert.deepEqual(acct.map((x) => [x.handle, x.storiesCiting, x.sampleUrl]), [["a", 3, "https://x.com/a/status/1"]]);
});

test("the prompt names tonight's games so Grok isn't left to guess the slate", () => {
  const p = storiesPrompt(ref, 6);
  assert.match(p, /Dallas Mavericks at Denver Nuggets/);
  assert.match(p, /up to 6 stories/);
});

// ---------------------------------------------------------------- the client (never the network)

const stub = (res: Response) => { const calls: { url: string; init: RequestInit }[] = []; const orig = globalThis.fetch; globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return res.clone(); }) as typeof fetch; return { calls, restore: () => { globalThis.fetch = orig; } }; };
const opts = { apiKey: "test-key", model: "grok-test", timeoutMs: 1000 };
const call = { input: "q", schema: { type: "object" }, schemaName: "stories" };

test("the client sends the x_search tool and a strict schema, and reads the answer and spend from the recorded response", async () => {
  const n = stub(new Response(JSON.stringify(fixture("xai-x-search-stories-2026-11-25.json"))));
  try {
    const r = await askGrok(opts, call);
    assert.equal(n.calls.length, 1);
    assert.equal(n.calls[0]!.url, "https://api.x.ai/v1/responses");
    const body = JSON.parse(String(n.calls[0]!.init.body));
    assert.deepEqual([body.model, body.tools, body.text.format.type, body.text.format.strict], ["grok-test", [{ type: "x_search" }], "json_schema", true]);
    assert.equal((n.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer test-key");
    assert.equal((r.answer as { stories: unknown[] }).stories.length, 5);
    assert.deepEqual(r.usage, { costTicks: 1361488000, postsFetched: 24, searchCalls: 3 });
  } finally { n.restore(); }
});

test("the client fails loudly and never retries a paid call: 429, 5xx, an error body, an incomplete answer, no text, junk", async () => {
  const cases: [Response, RegExp][] = [
    [new Response("slow down", { status: 429 }), /HTTP 429/],
    [new Response("down", { status: 503 }), /HTTP 503/],
    [new Response(JSON.stringify({ error: { message: "bad key" } })), /xAI error/],
    [new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] })), /status incomplete/],
    [new Response(JSON.stringify({ status: "completed", output: [{ type: "reasoning" }] })), /no text/],
    [new Response("<html>"), /isn't JSON/],
  ];
  for (const [res, pat] of cases) {
    const n = stub(res);
    try { await assert.rejects(askGrok(opts, call), pat); assert.equal(n.calls.length, 1, "one attempt only"); } finally { n.restore(); }
  }
});

// ---------------------------------------------------------------- trust: who a post is credited to (QA, STO-75)

// Attacks: X ignores the handle segment of a status URL, so the URL's handle is only Grok's word. When one answer credits the same
// post to two accounts, Grok has mixed up authors, and neither may be quoted as an approved account's reporting.
test("the same post credited to two accounts in one answer is never attributed", () => {
  const a = { stories: [
    story("Detroit Pistons", "team", [["randomfan", "555", "Cade is out tonight"]]),
    story("Boston Celtics", "team", [["shams", "555", "Cade is out tonight"]]),
  ] };
  const b = buildX({ ...base, approved: new Set(["shams"]), answer: a });
  assert.deepEqual(b.signals.filter((s) => s.key === "x:555" && s.trust === "attributed").map((s) => s.evidence.handle), [],
    "post 555 is credited to @randomfan and @shams in the same answer, so it can't be @shams's reporting");
});

// Attacks: Grok's two fields for the author disagree (URL says @shams, handle says @realreporter). The URL is no more verified than
// the handle field, so a disagreement means Grok doesn't know who wrote it: don't credit an approved account.
test("a post whose URL and handle name different accounts is never attributed", () => {
  const a = { stories: [{ ...story("Detroit Pistons", "team", []), posts: [{ url: "https://x.com/shams/status/111", handle: "@realreporter", excerpt: "Cade is out" }] }] };
  const b = buildX({ ...base, approved: new Set(["shams"]), answer: a });
  assert.equal(b.signals[0]?.trust, "unreviewed");
});

// Attacks: x.com/i/status/<id> is X's author-less post link (the recorded citations all use it). It must not become an account "@i"
// that is listed for review and could be approved (publishRules already refuses "i" as an account; the parser should too).
test("an author-less x.com/i/status link is not credited to an account named i", () => {
  const p = parsePost({ url: "https://x.com/i/status/2125447623779705198", excerpt: "x" });
  assert.ok(p === null || p.handle !== "i", JSON.stringify(p));
});
