// The Claude curator (STO-11) against a FAKE client: no network. It checks what we send (the request shape, the
// prompt) and how every kind of reply is handled. The reply shapes are hand-written from the SDK's types and the API
// reference, not recorded from a live call: the first real run in #testing is what proves them.

import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { createClaudeCurator, systemPrompt, userPrompt, SELECTION_SCHEMA } from "../src/sources/claudeCurator.js";
import type { CurationRequest } from "../src/sources/curate.js";

const REQ: CurationRequest = {
  rules: { n: 2, bandMin: 25, bandMax: 75, maxPerGame: 2, maxPerStat: 3, maxAttempts: 3 },
  feedback: [],
  input: {
    slateDate: "2026-11-23",
    stories: [{
      storyId: "7", playerId: "p1", playerName: "Jalen Brunson", gameId: "g1", stat: "pts", angle: "hot_streak", summary: "Hot streak: 31.0 PTS over his last 4",
      signals: [{ id: 41, source: "espn", kind: "stat", trust: "verified", summary: "last 5 games: 31, 28, 35, 30, 29", observedAt: "2026-11-23T14:00:00.000Z", slateDate: "2026-11-23" }],
      otherAngleSignals: [],
      ladder: [{ marketId: "m-25", strike: 25, yesPriceCents: 70 }, { marketId: "m-30", strike: 30, yesPriceCents: 48 }],
    }],
  },
};
const ANSWER = { ranking: ["7"], picks: [{ storyId: "7", marketId: "m-30", reason: "r" }] };

type Reply = { content: { type: string; text?: string }[]; stop_reason: string | null; stop_details?: unknown };
function fakeClient(reply: Reply | Error) {
  const calls: Record<string, unknown>[] = [];
  const client = { messages: { create: async (p: Record<string, unknown>) => { calls.push(p); if (reply instanceof Error) throw reply; return reply; } } };
  return { client: client as unknown as Pick<Anthropic, "messages">, calls };
}
const text = (t: string, stop = "end_turn"): Reply => ({ content: [{ type: "text", text: t }], stop_reason: stop });
const opts = { model: "claude-test-model", maxTokens: 5000, effort: "high" };

test("sends the configured model, limits and a JSON schema, and nothing newer models reject", async () => {
  const f = fakeClient(text(JSON.stringify(ANSWER)));
  const out = await createClaudeCurator({ client: f.client, ...opts }).curate(REQ);
  assert.deepEqual(out, ANSWER);
  const p = f.calls[0]!;
  assert.equal(p.model, "claude-test-model");
  assert.equal(p.max_tokens, 5000);
  assert.deepEqual(p.output_config, { effort: "high", format: { type: "json_schema", schema: SELECTION_SCHEMA } });
  for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "thinking"]) assert.ok(!(banned in p), `must not send ${banned}`);
});

test("the prompt carries the rules from config, and no scores", () => {
  const sys = systemPrompt(REQ);
  assert.match(sys, /exactly 2 stories/);
  assert.match(sys, /At most 2 picks from one game/);
  assert.match(sys, /at most 3 on one stat/);
  assert.match(sys, /one pick per player/);
  assert.doesNotMatch(userPrompt(REQ), /score/i);
});

test("the user prompt shows the stories, signals and ladder it was given, and nothing else", () => {
  const u = userPrompt(REQ);
  for (const want of ["Jalen Brunson", "hot_streak", "m-25", "m-30", "last 5 games", "\"id\":41", "\"trust\":\"verified\""]) assert.ok(u.includes(want), want);
  assert.ok(!u.includes("p1"), "our internal player id isn't shown");
  assert.ok(!u.includes("Your previous answer was rejected"));
});

test("a retry's prompt says exactly what was wrong", () => {
  const u = userPrompt({ ...REQ, feedback: ["pick m-90 is out of band", "2 picks from game g1; at most 1"] });
  assert.match(u, /Your previous answer was rejected/);
  assert.match(u, /- pick m-90 is out of band/);
  assert.match(u, /- 2 picks from game g1; at most 1/);
});

test("a refusal throws, and says why", async () => {
  const f = fakeClient({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } });
  await assert.rejects(createClaudeCurator({ client: f.client, ...opts }).curate(REQ), /refused.*cyber/);
});

test("an answer cut off at the token limit throws instead of being half-read", async () => {
  const f = fakeClient(text('{"ranking": ["7"], "pi', "max_tokens"));
  await assert.rejects(createClaudeCurator({ client: f.client, ...opts }).curate(REQ), /cut off at 5000 tokens/);
});

test("text that isn't JSON is handed on as text, so it is stored and reported as malformed", async () => {
  const f = fakeClient(text("Sure! Here are my picks: …"));
  assert.equal(await createClaudeCurator({ client: f.client, ...opts }).curate(REQ), "Sure! Here are my picks: …");
});

test("only text blocks are read (thinking and other blocks are ignored)", async () => {
  const f = fakeClient({ content: [{ type: "thinking" }, { type: "text", text: JSON.stringify(ANSWER) }], stop_reason: "end_turn" });
  assert.deepEqual(await createClaudeCurator({ client: f.client, ...opts }).curate(REQ), ANSWER);
});

test("an API error propagates (curateWithRules counts it as a failed attempt)", async () => {
  const f = fakeClient(new Error("529 overloaded"));
  await assert.rejects(createClaudeCurator({ client: f.client, ...opts }).curate(REQ), /overloaded/);
});

test("an effort that isn't one of the five levels is rejected up front", () => {
  const f = fakeClient(text("{}"));
  assert.throws(() => createClaudeCurator({ client: f.client, ...opts, effort: "turbo" }), /curation_effort/);
  assert.throws(() => createClaudeCurator({ client: f.client, ...opts, effort: "" }), /curation_effort/);
});

// ---- STO-91: every signal carries its dates, and the rules say what a dated fact may not be called
test("STO-91: each signal is shown with observedAt and slateDate, and the prompt says a dated fact is never tonight's news", () => {
  const old = { ...REQ.input.stories[0]!.signals[0]!, id: 42, observedAt: "2026-11-20T15:00:00.000Z", slateDate: "2026-11-20" };
  const u = userPrompt({ ...REQ, input: { ...REQ.input, stories: [{ ...REQ.input.stories[0]!, signals: [REQ.input.stories[0]!.signals[0]!, old] }] } });
  assert.ok(u.includes('"observedAt":"2026-11-20T15:00:00.000Z"'));
  assert.ok(u.includes('"slateDate":"2026-11-20"'));
  assert.ok(u.includes('"slateDate":"2026-11-23"'));
  const sys = systemPrompt(REQ);
  assert.match(sys, /slateDate/);
  assert.match(sys, /earlier than the slate day|before the slate day/i);
  assert.match(sys, /never (present|state)[^.]*tonight's news/i);
});

// ---- STO-120 (option A): same player, other angle
const HIELD_REQ = (): CurationRequest => ({
  ...REQ,
  input: { ...REQ.input, stories: [{
    ...REQ.input.stories[0]!, storyId: "3", playerName: "Buddy Hield", angle: "hot_streak",
    signals: [{ ...REQ.input.stories[0]!.signals[0]!, id: 101, summary: "last 5: 4.0 threes a game" }],
    otherAngleSignals: [{ ...REQ.input.stories[0]!.signals[0]!, id: 202, kind: "injury", summary: "Norman Powell is out tonight", angle: "backup_steps_in" }],
  }] },
});

test("STO-120: other-angle signals are shown labelled \"same player, other angle\" with the angle they came from, apart from the story's own", () => {
  const stories = JSON.parse(userPrompt(HIELD_REQ()).split("\n")[1]!) as { signals: { id: number }[]; sameAngleOther?: unknown; samePlayerOtherAngle: { id: number; angle: string; summary: string }[] }[];
  assert.deepEqual(stories[0]!.signals.map((s) => s.id), [101]);
  assert.deepEqual(stories[0]!.samePlayerOtherAngle.map((s) => [s.id, s.angle]), [[202, "backup_steps_in"]]);
  assert.match(stories[0]!.samePlayerOtherAngle[0]!.summary, /Powell/);
});

test("STO-120: the rules say facts may come only from the player's own signals, never another player's, and that several stories favour a player", () => {
  const sys = systemPrompt(REQ);
  assert.match(sys, /same player, other angle/i);
  assert.match(sys, /only facts (attached|listed) (to|for) that (same )?player|only (the )?facts attached to that player/i);
  assert.match(sys, /never (another|a different) player's/i);
  assert.match(sys, /more than one story[^.]*(favou?r|count)/i);
  assert.match(sys, /most compelling angle/i);
  assert.match(sys, /one pick per player/, "one card per player is unchanged");
});
