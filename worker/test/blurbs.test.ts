// The blurb writer (STO-77): its prompt, its Claude call, and the retry loop around it. Fake client and fake writer: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { createClaudeBlurbWriter, blurbSystemPrompt, blurbUserPrompt, BLURB_SCHEMA, type BlurbRequest } from "../src/sources/claudeBlurbs.js";
import { writeBlurbsWithRules } from "../src/sources/blurbs.js";
import type { BlurbInput, BlurbRules, BlurbStory } from "../src/domain/blurbRules.js";
import type { Curator } from "../src/sources/types.js";

const RULES: BlurbRules = { maxChars: 180, maxAttempts: 3 };
const DAY = "2026-11-24";
const market = { player: "Buddy Hield", team: "Bulls", opponent: "Raptors", home: true, stat: "threes", strike: 4, yesPriceCents: 48 };
const hield: BlurbStory = {
  storyId: "3", playerName: "Buddy Hield", angle: "hot_streak", summary: "Hot streak", market, level: "full",
  signals: [{ id: 101, source: "espn", kind: "stat", trust: "verified", summary: "last 5: 4.0 threes a game", observedAt: "2026-11-21T14:00:00.000Z", slateDate: "2026-11-21" }],
  otherAngleSignals: [{ id: 202, source: "espn", kind: "injury", trust: "verified", summary: "Norman Powell is out tonight", observedAt: `${DAY}T14:00:00.000Z`, slateDate: DAY, angle: "backup_steps_in" }],
};
const INPUT: BlurbInput = { slateDate: DAY, stories: [hield] };
const GUIDE = "# Blurb style guide\nVoice: punchy.";
const REQ: BlurbRequest = { input: INPUT, rules: RULES, styleGuide: GUIDE, feedback: [] };
const GOOD = { blurbs: [{ storyId: "3", blurb: "Hield is hitting four threes a night, and with Powell out he should get shots.", signalIds: [101, 202] }] };

// ---------------------------------------------------------------- the prompt
test("the system prompt carries the length from config, the banned words, the citation and trust rules, and the whole style guide", () => {
  const sys = blurbSystemPrompt(REQ);
  assert.match(sys, /at most 180 characters/);
  for (const w of ["lock", "hammer", "smash"]) assert.ok(sys.includes(w), w);
  assert.match(sys, /signalIds/);
  assert.match(sys, /never another player's/i);
  assert.match(sys, /Per <source>/);
  assert.match(sys, /never as breaking news or tonight's news/i);
  assert.match(sys, /market_only/);
  assert.ok(sys.includes("Voice: punchy."), "the style guide is in the prompt, in full");
  assert.doesNotMatch(sys, /\b200\b/, "the limit is the configured one, not a number in the prompt");
});

test("the user prompt shows each signal's id and both dates (STO-91), and labels the other angle's signals with where they came from (STO-120)", () => {
  const stories = JSON.parse(blurbUserPrompt(REQ).split("\n")[1]!) as { signals: Record<string, unknown>[]; samePlayerOtherAngle: Record<string, unknown>[]; market: unknown; level: string }[];
  assert.deepEqual(stories[0]!.signals[0], { id: 101, source: "espn", kind: "stat", trust: "verified", summary: "last 5: 4.0 threes a game", observedAt: "2026-11-21T14:00:00.000Z", slateDate: "2026-11-21" });
  assert.deepEqual(stories[0]!.samePlayerOtherAngle.map((s) => [s.id, s.angle, s.slateDate]), [[202, "backup_steps_in", DAY]]);
  assert.deepEqual(stories[0]!.market, market);
  assert.equal(stories[0]!.level, "full");
});

test("the user prompt never shows internal player ids, the curator's reason, or scores", () => {
  const u = blurbUserPrompt(REQ);
  assert.doesNotMatch(u, /playerId|reason|score/i);
});

test("a retry's prompt says exactly what was wrong", () => {
  const u = blurbUserPrompt({ ...REQ, feedback: ["story 3: the blurb is 230 characters; at most 180"] });
  assert.match(u, /Your previous answer was rejected/);
  assert.match(u, /- story 3: the blurb is 230 characters/);
});

// ---------------------------------------------------------------- the Claude call
type Reply = { content: { type: string; text?: string }[]; stop_reason: string | null };
const fakeClient = (reply: Reply | Error) => {
  const calls: Record<string, unknown>[] = [];
  return { calls, client: { messages: { create: async (p: Record<string, unknown>) => { calls.push(p); if (reply instanceof Error) throw reply; return reply; } } } as unknown as Pick<Anthropic, "messages"> };
};
const opts = { model: "claude-test-model", maxTokens: 4000, effort: "medium" };

test("sends the configured model, a JSON schema for the blurbs, and none of the parameters newer models reject", async () => {
  const f = fakeClient({ content: [{ type: "text", text: JSON.stringify(GOOD) }], stop_reason: "end_turn" });
  assert.deepEqual(await createClaudeBlurbWriter({ client: f.client, ...opts }).curate(REQ), GOOD);
  const p = f.calls[0]!;
  assert.equal(p.model, "claude-test-model");
  assert.equal(p.max_tokens, 4000);
  assert.deepEqual(p.output_config, { effort: "medium", format: { type: "json_schema", schema: BLURB_SCHEMA } });
  for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "thinking"]) assert.ok(!(banned in p), banned);
  assert.equal(p.system, blurbSystemPrompt(REQ));
});

test("a refusal, a cut-off answer and an API error all throw; non-JSON text is handed on to be reported as malformed", async () => {
  await assert.rejects(createClaudeBlurbWriter({ client: fakeClient({ content: [], stop_reason: "refusal" }).client, ...opts }).curate(REQ), /refused/);
  await assert.rejects(createClaudeBlurbWriter({ client: fakeClient({ content: [{ type: "text", text: '{"blu' }], stop_reason: "max_tokens" }).client, ...opts }).curate(REQ), /cut off at 4000/);
  await assert.rejects(createClaudeBlurbWriter({ client: fakeClient(new Error("529 overloaded")).client, ...opts }).curate(REQ), /overloaded/);
  assert.equal(await createClaudeBlurbWriter({ client: fakeClient({ content: [{ type: "text", text: "Sure!" }], stop_reason: "end_turn" }).client, ...opts }).curate(REQ), "Sure!");
  assert.throws(() => createClaudeBlurbWriter({ client: fakeClient(new Error("x")).client, ...opts, effort: "turbo" }), /curation_effort/);
});

// ---------------------------------------------------------------- the retry loop
const scripted = (answers: unknown[]): Curator<BlurbRequest, unknown> & { seen: BlurbRequest[] } => {
  const seen: BlurbRequest[] = [];
  return { name: "fake", seen, async curate(r) { seen.push(r); const a = answers[seen.length - 1]; if (a instanceof Error) throw a; return a; } };
};
const alerts = () => { const sent: string[] = []; return { sent, alert: async (m: string) => { sent.push(m); } }; };

test("a good first answer is accepted with one attempt and no alert", async () => {
  const a = alerts(), w = scripted([GOOD]);
  const r = await writeBlurbsWithRules(w, INPUT, RULES, GUIDE, a.alert);
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts.map((x) => x.accepted), [true]);
  assert.equal(r.ok && r.blurbs[0]!.facts.signals.length, 2);
  assert.deepEqual(a.sent, []);
  assert.equal(w.seen[0]!.styleGuide, GUIDE, "the guide reaches the writer on every call");
});

test("a rejected answer is retried with its reasons, and the rejected attempt is kept", async () => {
  const bad = { blurbs: [{ storyId: "3", blurb: "Smash the over.", signalIds: [101] }] };
  const w = scripted([bad, GOOD]);
  const r = await writeBlurbsWithRules(w, INPUT, RULES, GUIDE, alerts().alert);
  assert.equal(r.ok, true);
  assert.deepEqual(r.attempts.map((x) => [x.accepted, x.violations.map((v) => v.kind)]), [[false, ["banned_word"]], [true, []]]);
  assert.match(w.seen[1]!.feedback.join("\n"), /betting language/);
  assert.deepEqual(w.seen[0]!.feedback, []);
});

test("every attempt fails: one alert naming each reason, nothing returned, every attempt kept", async () => {
  const a = alerts(), w = scripted([{ nope: 1 }, new Error("HTTP 529"), "just words"]);
  const r = await writeBlurbsWithRules(w, INPUT, RULES, GUIDE, a.alert);
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 3);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0]!, /Blurbs failed for 2026-11-24: 3 attempts/);
  assert.match(a.sent[0]!, /HTTP 529/);
  assert.match(a.sent[0]!, /malformed/);
  assert.equal(r.attempts[1]!.error, "HTTP 529");
});

test("a failing alert can't turn a clean failure into a crash, and a bad attempt cap is refused up front", async () => {
  const r = await writeBlurbsWithRules(scripted([{}, {}, {}]), INPUT, RULES, GUIDE, async () => { throw new Error("discord down"); });
  assert.equal(r.ok, false);
  await assert.rejects(writeBlurbsWithRules(scripted([]), INPUT, { ...RULES, maxAttempts: 0 }, GUIDE, async () => {}), /maxAttempts/);
});
