// The retry wrapper around a Curator (STO-11): reject an answer that breaks the rules, retry up to a cap,
// and if every attempt fails send one detailed alert and return nothing to publish. Fake curators only; no network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { curateWithRules, type CurationRequest } from "../src/sources/curate.js";
import type { CurationInput, CurationRules, CurationStory } from "../src/domain/curationRules.js";
import type { Curator } from "../src/sources/types.js";
import * as H from "./helpers/curationSlates.js";

const RULES: CurationRules = { n: 2, bandMin: 25, bandMax: 75, maxPerGame: 2, maxPerStat: 2, maxAttempts: 3 };
const story = (id: string, gameId: string, stat: string): CurationStory => ({
  storyId: id, playerId: `p-${id}`, playerName: `Player ${id}`, gameId, stat, angle: "hot_streak", summary: id, signals: [],
  ladder: [{ marketId: `${id}-hi`, strike: 30, yesPriceCents: 90 }, { marketId: `${id}-mid`, strike: 25, yesPriceCents: 50 }],
});
const INPUT: CurationInput = { slateDate: "2026-11-23", stories: [story("a", "g1", "pts"), story("b", "g2", "reb"), story("c", "g3", "ast")] };
const GOOD = { ranking: ["a", "b", "c"], picks: [{ storyId: "a", marketId: "a-mid", reason: "r1" }, { storyId: "b", marketId: "b-mid", reason: "r2" }] };
const BAD_BAND = { ranking: ["a", "b", "c"], picks: [{ storyId: "a", marketId: "a-hi", reason: "r1" }, { storyId: "b", marketId: "b-mid", reason: "r2" }] };

/** A curator that returns (or throws) each scripted answer in turn and records what it was asked. */
function scripted(answers: unknown[]): Curator<CurationRequest, unknown> & { calls: CurationRequest[] } {
  const calls: CurationRequest[] = [];
  return {
    name: "fake", calls,
    async curate(req) {
      calls.push(req);
      const a = answers[calls.length - 1];
      if (a instanceof Error) throw a;
      return a;
    },
  };
}
const alerts = () => { const sent: string[] = []; return { sent, alert: async (m: string) => { sent.push(m); } }; };

test("a good first answer is returned with no retry and no alert", async () => {
  const c = scripted([GOOD]); const a = alerts();
  const r = await curateWithRules(c, INPUT, RULES, a.alert);
  assert.equal(r.ok, true);
  assert.equal(c.calls.length, 1);
  assert.equal(r.attempts.length, 1);
  assert.deepEqual(a.sent, []);
});

test("the curator is shown only in-band strikes, and a story with none is left out", async () => {
  const dead: CurationStory = { ...story("z", "g9", "pts"), ladder: [{ marketId: "z-hi", strike: 40, yesPriceCents: 95 }] };
  const c = scripted([GOOD]);
  await curateWithRules(c, { ...INPUT, stories: [...INPUT.stories, dead] }, RULES, async () => {});
  const shown = c.calls[0]!.input.stories;
  assert.deepEqual(shown.map((s) => s.storyId), ["a", "b", "c"]);
  for (const s of shown) assert.deepEqual(s.ladder.map((l) => l.marketId), [`${s.storyId}-mid`]);   // the 90c rung is hidden
});

test("a strike the curator was never shown is still rejected, not trusted", async () => {
  const c = scripted([BAD_BAND, BAD_BAND, BAD_BAND]);
  const r = await curateWithRules(c, INPUT, RULES, async () => {});
  assert.equal(r.ok, false);
  assert.ok(r.attempts[0]!.violations.some((v) => v.kind === "out_of_band"));
});

test("the accepted attempt is marked, and only that one", async () => {
  const c = scripted([BAD_BAND, GOOD]);
  const r = await curateWithRules(c, INPUT, RULES, async () => {});
  assert.deepEqual(r.attempts.map((a) => a.accepted), [false, true]);
});

test("a rule-breaking answer is rejected and the retry is told exactly what was wrong", async () => {
  const c = scripted([BAD_BAND, GOOD]); const a = alerts();
  const r = await curateWithRules(c, INPUT, RULES, a.alert);
  assert.equal(r.ok, true);
  assert.equal(c.calls.length, 2);
  assert.deepEqual(c.calls[0]!.feedback, []);
  assert.ok(c.calls[1]!.feedback.some((f) => f.includes("a-hi") && f.includes("band")), c.calls[1]!.feedback.join("|"));
  assert.equal(r.attempts[0]!.violations.length, 1);   // the rejected attempt is kept: it is what prompt tuning needs
  assert.deepEqual(a.sent, []);
});

test("a curator that throws counts as a failed attempt and is retried", async () => {
  const c = scripted([new Error("overloaded"), GOOD]); const a = alerts();
  const r = await curateWithRules(c, INPUT, RULES, a.alert);
  assert.equal(r.ok, true);
  assert.equal(r.attempts[0]!.error, "overloaded");
});

test("when every attempt fails: exactly maxAttempts calls, one detailed alert, nothing to publish", async () => {
  const c = scripted([BAD_BAND, new Error("HTTP 529"), { nope: true }, GOOD]);   // the good one must never be reached
  const a = alerts();
  const r = await curateWithRules(c, INPUT, RULES, a.alert);
  assert.equal(r.ok, false);
  assert.equal(c.calls.length, 3);
  assert.equal(r.attempts.length, 3);
  assert.equal(a.sent.length, 1);
  const msg = a.sent[0]!;
  assert.match(msg, /curation failed/i);
  assert.match(msg, /2026-11-23/);
  assert.match(msg, /3 attempts/);
  assert.match(msg, /out_of_band/);
  assert.match(msg, /HTTP 529/);
  assert.match(msg, /malformed/);
  assert.ok(!("selection" in r), "a failed run must not carry a partial selection");
});

test("an alert that itself fails must not hide the failed result", async () => {
  const c = scripted([BAD_BAND, BAD_BAND, BAD_BAND]);
  const r = await curateWithRules(c, INPUT, RULES, async () => { throw new Error("discord down"); });
  assert.equal(r.ok, false);
});

test("maxAttempts of 1 means one call and no retry", async () => {
  const c = scripted([BAD_BAND, GOOD]);
  const r = await curateWithRules(c, INPUT, { ...RULES, maxAttempts: 1 }, async () => {});
  assert.equal(r.ok, false);
  assert.equal(c.calls.length, 1);
});

test("an invalid cap is a configuration error, not a silent no-op", async () => {
  await assert.rejects(curateWithRules(scripted([GOOD]), INPUT, { ...RULES, maxAttempts: 0 }, async () => {}), /maxAttempts/);
});

test("storable: NUL and lone surrogates are replaced in every string and key, and nothing else changes", async () => {
  const { storable } = await import("../src/sources/curationStore.js");
  const out = storable({ "k\u0000ey": ["a\u0000b", { x: "ok \u{1F600} ünï", y: "lone \uD83D here", z: "low \uDE00 here" }], n: 3, b: true, nil: null }) as Record<string, unknown>;
  assert.deepEqual(out, { "k�ey": ["a�b", { x: "ok \u{1F600} ünï", y: "lone � here", z: "low � here" }], n: 3, b: true, nil: null });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
});

describe("hostile and boundary inputs", () => {
const { PROD, story, slate, bestPossible, always } = H;

// attacks: the same infeasibility end to end: a perfect curator still burns every attempt and publishes nothing.
test("qa: a curator that always gives the best possible answer on a 1-game slate is not rejected", async () => {
  const input = slate(1, 8);                        // a playoff night: one game, eight players
  const c = always(bestPossible(input, PROD));
  const sent: string[] = [];
  const r = await curateWithRules(c, input, PROD, async (m) => { sent.push(m); });
  assert.equal(r.ok, true, `rejected ${c.calls} times; alert: ${sent[0]?.split("\n")[1]}`);
});

// attacks: zero eligible stories (every ladder out of band, or a misconfigured band). It must not be reported as a good deck.
test("qa: no story with an in-band strike: the curator isn't called and an empty deck isn't 'ok'", async () => {
  const input: CurationInput = { slateDate: "2026-11-23", stories: [story("a", "g1", "pts", { ladder: [{ marketId: "a-m", strike: 40, yesPriceCents: 90 }] })] };
  const c = always({ ranking: [], picks: [] });
  const sent: string[] = [];
  const r = await curateWithRules(c, input, PROD, async (m) => { sent.push(m); });
  assert.equal(c.calls, 0, "Claude is paid to curate an empty list");
  assert.equal(r.ok, false, "a 0-card deck comes back ok, the job records ok and posts '0 cards'");
  assert.equal(sent.length, 1, "no alert for a day with nothing to publish");
});

// attacks: hostile huge output. 20k invented story ids are echoed verbatim into the retry prompt (and token bill).
test("qa: a huge invented ranking doesn't balloon the retry feedback", async () => {
  const input = slate(4, 4);
  const huge = { ranking: Array.from({ length: 20000 }, (_, i) => `fake-story-${i}`), picks: [] };
  const seen: CurationRequest[] = [];
  const c: Curator<CurationRequest, unknown> = { name: "fake", async curate(req) { seen.push(req); return huge; } };
  await curateWithRules(c, input, { ...PROD, maxAttempts: 2 }, async () => {});
  const size = seen[1]!.feedback.join("\n").length;
  assert.ok(size < 5000, `retry feedback is ${size} chars`);
});

// ---------------------------------------------------------------- coverage (expected to PASS)

// coverage: maxAttempts edge values that config bounds already forbid are still refused by code.
test("qa coverage: maxAttempts 0, -1, 1.5, NaN, Infinity throw before any call", async () => {
  for (const m of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const c = always({});
    await assert.rejects(curateWithRules(c, slate(4, 4), { ...PROD, maxAttempts: m }, async () => {}));
    assert.equal(c.calls, 0);
  }
});
});
