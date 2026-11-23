// QA attacks on the story step's pure rules and its #testing text (PR #43). Each test says what it attacks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShortlist, pickMarket, quotas, type Matched, type MarketRow } from "../src/domain/storyShortlist.js";
import { storySummaryMessages } from "../src/lib/feedText.js";
import type { StorySummary } from "../src/jobs/stories.js";
import type { StoryCandidate } from "../src/domain/storyDetectors.js";

const W = { hot_streak: 1, back_from_injury: 1, backup_steps_in: 1 };
const m = (playerId: string, angle: string, score: number, stat: StoryCandidate["stat"] = "pts"): Matched =>
  ({ playerId, angle, stat, score, summary: "s", basis: [], teamId: 1, gameId: "g", marketId: `m-${playerId}-${stat}`, signalIds: [1] });

// Boundary: a list smaller than the number of angles — every quota rounds to 0, so the one slot goes by score.
test("QA quota: size 1 over three angles gives one fill slot to the top score, never more than size", () => {
  assert.deepEqual(quotas(1, W), { hot_streak: 0, back_from_injury: 0, backup_steps_in: 0 });
  const got = buildShortlist([m("a", "hot_streak", 10), m("b", "back_from_injury", 70), m("c", "backup_steps_in", 30)], 1, W);
  assert.deepEqual(got.map((x) => [x.playerId, x.slotKind, x.position]), [["b", "fill", 1]]);
});

// Boundary: quotas never add up to more than size, for any size 1..500 and any weights in range.
test("QA quota: the quotas never exceed the list size (size 1..500, weights 0..100)", () => {
  for (const size of [1, 2, 3, 49, 50, 51, 499, 500]) for (const w of [[0, 0, 1], [1, 1, 1], [100, 1, 0], [100, 100, 100], [7, 3, 1]]) {
    const q = quotas(size, { a: w[0]!, b: w[1]!, c: w[2]! });
    assert.ok(Object.values(q).reduce((x, y) => x + y, 0) <= size, `size ${size} weights ${w}`);
  }
});

// Hostile data: a detector emits the same story twice (same player, angle, stat). Must not reach the DB twice
// (story_shortlist_one_story would fail the whole run).
test("QA dupes: the same story twice in the input is on the list once", () => {
  const got = buildShortlist([m("a", "hot_streak", 40), m("a", "hot_streak", 40), m("b", "hot_streak", 30)], 50, W);
  assert.deepEqual(got.map((x) => x.playerId), ["a", "b"]);
});

// Market with fractional strikes and equal distance from 50: the pick is stable (lower strike).
test("QA market: two strikes equally far from a coin flip (48 vs 52) pick the lower strike, whatever the input order", () => {
  const mk = (id: string, strike: number, bid: number, ask: number): MarketRow => ({ id, playerId: "p", gameId: "g", stat: "points", strike, yesBidCents: bid, yesAskCents: ask });
  const R = { bandMin: 25, bandMax: 75, maxSpreadCents: 5 };
  const a = mk("z", 19.5, 50, 52), b = mk("a", 24.5, 46, 48);
  assert.equal(pickMarket({ playerId: "p", stat: "pts" }, [a, b], R)?.id, "z");
  assert.equal(pickMarket({ playerId: "p", stat: "pts" }, [b, a], R)?.id, "z");
});

// Boundary for the Discord summary: the maximum list (500) with very long names — every message fits, every story is shown once.
test("QA feed: a 500-story list with long names posts every story once, each message under 2000 chars", () => {
  const long = "X".repeat(300);
  const shortlist = Array.from({ length: 500 }, (_, i) => ({ position: i + 1, angle: "backup_steps_in", stat: "pts" as const, score: 1000, player: `${long}${i}`, slotKind: "quota" as const, summary: long }));
  const s: StorySummary = {
    slateDate: "2026-11-20", runId: 1, found: 900, foundByAngle: { hot_streak: 300, back_from_injury: 300, backup_steps_in: 300 },
    notPlaying: 1, noSignals: 1, noMarket: 400, noMarketSamples: Array.from({ length: 8 }, () => long), matched: 500, shortlisted: 500,
    byAngle: { hot_streak: { matched: 200, quota: 166, fill: 0 }, back_from_injury: { matched: 150, quota: 150, fill: 0 }, backup_steps_in: { matched: 150, quota: 150, fill: 34 } },
    shortlist, inputs: { calls: 1, failedCalls: 0, skippedRows: 0, playersWithoutInputs: 3, unknownStatuses: [] },
  };
  const msgs = storySummaryMessages(s);
  for (const x of msgs) assert.ok(x.length <= 2000, `message of ${x.length} chars`);
  const shown = msgs.slice(1).flatMap((x) => x.split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => Number(l.split(".")[0])));
  assert.deepEqual(shown, shortlist.map((k) => k.position));
  assert.ok(msgs.slice(1).every((x) => x.split("\n").filter((l) => /^\d+\. /.test(l)).every((l) => /^\d+\. \w+ · \d+ · /.test(l))), "angle next to score on every line");
});
