// The retry wrapper around a Curator (STO-11): reject an answer that breaks the rules, retry up to a cap,
// and if every attempt fails send one detailed alert and return nothing to publish. Fake curators only; no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { curateWithRules, type CurationRequest } from "../src/sources/curate.js";
import type { CurationInput, CurationRules, CurationStory } from "../src/domain/curationRules.js";
import type { Curator } from "../src/sources/types.js";

const RULES: CurationRules = { n: 2, bandMin: 25, bandMax: 75, maxPerGame: 2, maxPerStat: 2, maxAttempts: 3 };
const story = (id: string, gameId: string, stat: string): CurationStory => ({
  storyId: id, playerId: `p-${id}`, gameId, stat, angle: "hot_streak", summary: id, signals: [],
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
