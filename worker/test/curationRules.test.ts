// Curation rules (STO-11): what a curator's answer must satisfy before anything is published.
// Pure, and the input type here is a stand-in until STO-76 defines the real shortlist (see curationRules.ts).
// Every rule is checked against OUR input, never against what the model says about itself: the player, game and
// stat of a pick come from the story it names, so the model can't dodge a rule by mislabelling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSelection, narrowToBand, type CurationInput, type CurationRules, type CurationStory } from "../src/domain/curationRules.js";

const RULES: CurationRules = { n: 3, bandMin: 25, bandMax: 75, maxPerGame: 2, maxPerStat: 2, maxAttempts: 3 };

/** A story with a three-rung ladder: 20+ at 80c (out of band), 25+ at 55c, 30+ at 30c, 35+ at 10c (out of band). */
const story = (id: string, o: Partial<CurationStory> = {}): CurationStory => ({
  storyId: id, playerId: `p-${id}`, playerName: `Player ${id}`, gameId: "g1", stat: "pts", angle: "hot_streak", summary: `story ${id}`,
  signals: [{ id: 1, source: "espn", kind: "stat", trust: "verified", summary: "fact" }],
  ladder: [
    { marketId: `${id}-20`, strike: 20, yesPriceCents: 80 },
    { marketId: `${id}-25`, strike: 25, yesPriceCents: 55 },
    { marketId: `${id}-30`, strike: 30, yesPriceCents: 30 },
    { marketId: `${id}-35`, strike: 35, yesPriceCents: 10 },
  ],
  ...o,
});

const INPUT: CurationInput = {
  slateDate: "2026-11-23",
  stories: [
    story("a", { gameId: "g1", stat: "pts" }),
    story("b", { gameId: "g2", stat: "reb" }),
    story("c", { gameId: "g3", stat: "ast" }),
    story("d", { gameId: "g1", stat: "pts" }),
    story("e", { gameId: "g1", stat: "pts" }),
  ],
};
const ids = INPUT.stories.map((s) => s.storyId);
const pick = (storyId: string, suffix = "25", reason = "He is on a tear") => ({ storyId, marketId: `${storyId}-${suffix}`, reason });
const good = () => ({ ranking: ids, picks: [pick("a"), pick("b"), pick("c")] });
const kinds = (out: unknown, input = INPUT, rules = RULES) => {
  const r = checkSelection(input, out, rules);
  return r.ok ? [] : r.violations.map((v) => v.kind);
};

test("a valid answer passes and comes back typed", () => {
  const r = checkSelection(INPUT, good(), RULES);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.selection.picks.map((p) => p.storyId), ["a", "b", "c"]);
});

test("malformed output is a violation, never a crash", () => {
  for (const bad of [null, undefined, "text", 7, [], {}, { ranking: "x", picks: [] }, { ranking: ids, picks: [null] }, { ranking: ids, picks: [{ storyId: 1 }] }]) {
    assert.deepEqual(kinds(bad), ["malformed"], JSON.stringify(bad));
  }
});

test("the ranking must list every shortlisted story exactly once", () => {
  assert.deepEqual(kinds({ ...good(), ranking: ids.slice(1) }), ["ranking"]);                  // one missing
  assert.deepEqual(kinds({ ...good(), ranking: [...ids, "a"] }), ["ranking"]);                 // a duplicate
  assert.deepEqual(kinds({ ...good(), ranking: [...ids.slice(1), "zzz"] }), ["ranking"]);      // an invented story
});

test("picks must be exactly N (or every distinct player if fewer)", () => {
  assert.deepEqual(kinds({ ...good(), picks: [pick("a"), pick("b")] }), ["pick_count"]);
  assert.deepEqual(kinds({ ...good(), picks: [pick("a"), pick("b"), pick("c"), pick("d")] }), ["pick_count"]);   // too many (a and d share a game: still under the cap of 2)
  // fewer players than N: all of them is the right answer
  const small: CurationInput = { slateDate: "x", stories: INPUT.stories.slice(0, 2) };
  assert.deepEqual(kinds({ ranking: ["a", "b"], picks: [pick("a"), pick("b")] }, small), []);
});

test("a pick for a story that isn't on the shortlist is rejected", () => {
  assert.ok(kinds({ ...good(), picks: [pick("a"), pick("b"), pick("zzz")] }).includes("unknown_story"));
});

test("at most one card per player, judged from our data, not the model's", () => {
  // two different stories about the same player (same playerId), e.g. his points and his rebounds
  const two: CurationInput = {
    slateDate: "x",
    stories: [story("a", { playerId: "P", gameId: "g1", stat: "pts" }), story("b", { playerId: "P", gameId: "g1", stat: "reb" }), story("c", { gameId: "g2" }), story("d", { gameId: "g3" })],
  };
  const out = { ranking: ["a", "b", "c", "d"], picks: [pick("a"), pick("b"), pick("c")] };
  assert.ok(kinds(out, two).includes("player_repeat"));
  // the same story picked twice is also a repeat
  assert.ok(kinds({ ...good(), picks: [pick("a"), pick("a"), pick("c")] }).includes("player_repeat"));
});

test("the chosen strike must be on that story's own ladder", () => {
  assert.ok(kinds({ ...good(), picks: [pick("a"), pick("b"), { storyId: "c", marketId: "b-25", reason: "r" }] }).includes("unknown_strike"));
  assert.ok(kinds({ ...good(), picks: [pick("a"), pick("b"), { storyId: "c", marketId: "made-up", reason: "r" }] }).includes("unknown_strike"));
});

test("the chosen strike must be inside the price band, edges included", () => {
  assert.ok(kinds({ ...good(), picks: [pick("a", "20"), pick("b"), pick("c")] }).includes("out_of_band"));   // 80c
  assert.ok(kinds({ ...good(), picks: [pick("a", "35"), pick("b"), pick("c")] }).includes("out_of_band"));   // 10c
  const edge = (cents: number): CurationInput => ({ slateDate: "x", stories: [story("a", { ladder: [{ marketId: "a-e", strike: 1, yesPriceCents: cents }, { marketId: "a-ok", strike: 2, yesPriceCents: 50 }] }), ...INPUT.stories.slice(1, 3)] });
  const out = { ranking: ["a", "b", "c"], picks: [{ storyId: "a", marketId: "a-e", reason: "r" }, pick("b"), pick("c")] };
  assert.deepEqual(kinds(out, edge(25)), []);
  assert.deepEqual(kinds(out, edge(75)), []);
  assert.deepEqual(kinds(out, edge(24)), ["out_of_band"]);
  assert.deepEqual(kinds(out, edge(76)), ["out_of_band"]);
});

test("picks must spread across games and stat types", () => {
  // three picks from game g1 with a cap of 2 per game (and all points: a stat cap of 2 as well)
  const out = { ranking: ids, picks: [pick("a"), pick("d"), pick("e")] };
  const k = kinds(out);
  assert.ok(k.includes("game_cap"));
  assert.ok(k.includes("stat_cap"));
  // two in one game is fine
  assert.deepEqual(kinds({ ...good(), picks: [pick("a"), pick("d"), pick("c")] }, INPUT, { ...RULES, maxPerStat: 3 }), []);
});

test("a reason must be present and a single line", () => {
  assert.ok(kinds({ ...good(), picks: [pick("a", "25", ""), pick("b"), pick("c")] }).includes("reason"));
  assert.ok(kinds({ ...good(), picks: [pick("a", "25", "   "), pick("b"), pick("c")] }).includes("reason"));
  assert.ok(kinds({ ...good(), picks: [pick("a", "25", "line one\nline two"), pick("b"), pick("c")] }).includes("reason"));
});

test("every problem is reported at once, so the retry can fix them all", () => {
  const out = { ranking: ids.slice(1), picks: [pick("a", "20", ""), pick("a"), pick("zzz")] };
  const k = new Set<string>(kinds(out));
  for (const want of ["ranking", "out_of_band", "reason", "player_repeat", "unknown_story"]) assert.ok(k.has(want), `missing ${want}`);
});

// ---------------------------------------------------------------- narrowing the ladder to the band (decision 2)

test("narrowToBand cuts each ladder to the band (edges included) and keeps everything else", () => {
  const out = narrowToBand(INPUT, RULES);
  assert.deepEqual(out.stories[0]!.ladder.map((l) => l.marketId), ["a-25", "a-30"]);   // 80c and 10c are gone
  assert.equal(out.stories[0]!.summary, "story a");
  assert.equal(out.slateDate, INPUT.slateDate);
  const edges = narrowToBand({ slateDate: "x", stories: [story("a", { ladder: [24, 25, 75, 76].map((c) => ({ marketId: `m${c}`, strike: c, yesPriceCents: c })) })] }, RULES);
  assert.deepEqual(edges.stories[0]!.ladder.map((l) => l.marketId), ["m25", "m75"]);
});

test("narrowToBand drops a story with no strike left in the band, and doesn't change its input", () => {
  const dead = story("z", { ladder: [{ marketId: "z-1", strike: 5, yesPriceCents: 95 }] });
  const input: CurationInput = { slateDate: "x", stories: [dead, story("a")] };
  const before = JSON.stringify(input);
  assert.deepEqual(narrowToBand(input, RULES).stories.map((s) => s.storyId), ["a"]);
  assert.equal(JSON.stringify(input), before);
});

test("a story with no in-band strike isn't required in the ranking, and ranking it is a violation", () => {
  const dead = story("z", { gameId: "g9", ladder: [{ marketId: "z-1", strike: 5, yesPriceCents: 95 }] });
  const input: CurationInput = { slateDate: "x", stories: [...INPUT.stories, dead] };
  assert.deepEqual(kinds(good(), input), []);                                    // ranking without z is right
  assert.deepEqual(kinds({ ...good(), ranking: [...ids, "z"] }, input), ["ranking"]);   // it was never shown
  assert.ok(kinds({ ...good(), picks: [pick("a"), pick("b"), { storyId: "z", marketId: "z-1", reason: "r" }] }, input).includes("out_of_band"));
});

test("the pick count only counts players the curator could actually pick", () => {
  // two stories shown, a third has no in-band strike: N=3 but only 2 are pickable
  const dead = story("z", { ladder: [{ marketId: "z-1", strike: 5, yesPriceCents: 95 }] });
  const input: CurationInput = { slateDate: "x", stories: [story("a", { gameId: "g1" }), story("b", { gameId: "g2" }), dead] };
  assert.deepEqual(kinds({ ranking: ["a", "b"], picks: [pick("a"), pick("b")] }, input), []);
});
