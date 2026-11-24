// qa (STO-11, PR #44): attacks on the curation rules, the retry wrapper and the #testing post. Pure, fake curators, no network.
// A test that fails here is a finding for the author; a passing one is labelled "coverage".

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSelection, type CurationInput, type CurationRules, type CurationStory } from "../src/domain/curationRules.js";
import { curateWithRules, type CurationRequest } from "../src/sources/curate.js";
import { curationPostChunks } from "../src/lib/curationText.js";
import type { Curator } from "../src/sources/types.js";

/** The starting app_config values from the migration: cards_per_day 10, band 25-75, 3 per game, 4 per stat, 3 attempts. */
const PROD: CurationRules = { n: 10, bandMin: 25, bandMax: 75, maxPerGame: 3, maxPerStat: 4, maxAttempts: 3 };
const STATS = ["pts", "reb", "ast", "3pm"];

const story = (id: string, gameId: string, stat: string, o: Partial<CurationStory> = {}): CurationStory => ({
  storyId: id, playerId: `p-${id}`, playerName: `Player ${id}`, gameId, stat, angle: "hot_streak", summary: id, signals: [],
  ladder: [{ marketId: `${id}-m`, strike: 25, yesPriceCents: 50 }], ...o,
});
/** `players` distinct players spread round-robin over `games` games and the four stats. */
const slate = (games: number, players: number): CurationInput => ({
  slateDate: "2026-11-23",
  stories: Array.from({ length: players }, (_, i) => story(`s${i}`, `g${i % games}`, STATS[i % STATS.length]!)),
});
/** The largest answer that respects every cap: greedy, one per player, under the game and stat caps. */
const bestPossible = (input: CurationInput, r: CurationRules) => {
  const perGame = new Map<string, number>(), perStat = new Map<string, number>();
  const picks = [];
  for (const s of input.stories) {
    if (picks.length === r.n) break;
    if ((perGame.get(s.gameId) ?? 0) >= r.maxPerGame || (perStat.get(s.stat) ?? 0) >= r.maxPerStat) continue;
    perGame.set(s.gameId, (perGame.get(s.gameId) ?? 0) + 1); perStat.set(s.stat, (perStat.get(s.stat) ?? 0) + 1);
    picks.push({ storyId: s.storyId, marketId: s.ladder[0]!.marketId, reason: "why a fan cares" });
  }
  return { ranking: input.stories.map((s) => s.storyId), picks };
};
const always = (answer: unknown): Curator<CurationRequest, unknown> & { calls: number } => {
  const c = { name: "fake", calls: 0, async curate() { c.calls++; return answer; } };
  return c;
};
const kinds = (input: CurationInput, out: unknown, r: CurationRules) => {
  const res = checkSelection(input, out, r);
  return res.ok ? [] : res.violations.map((v) => v.kind);
};

// ---------------------------------------------------------------- findings (expected to FAIL until fixed)

// attacks: the caps vs N. With the starting config (10 cards, 3 per game) any slate of 3 games or fewer can never pass.
test("qa: on a 3-game slate with the starting config, the best answer the caps allow is accepted", () => {
  const input = slate(3, 12);                       // 12 players, 3 games: the caps allow at most 9 cards, the rule demands 10
  const best = bestPossible(input, PROD);
  assert.equal(best.picks.length, 9);
  assert.deepEqual(kinds(input, best, PROD), [], "no possible answer passes: curation fails every attempt on every small slate");
});

// attacks: the same infeasibility end to end: a perfect curator still burns every attempt and publishes nothing.
test("qa: a curator that always gives the best possible answer on a 1-game slate is not rejected", async () => {
  const input = slate(1, 8);                        // a playoff night: one game, eight players
  const c = always(bestPossible(input, PROD));
  const sent: string[] = [];
  const r = await curateWithRules(c, input, PROD, async (m) => { sent.push(m); });
  assert.equal(r.ok, true, `rejected ${c.calls} times; alert: ${sent[0]?.split("\n")[1]}`);
});

// attacks: the stat cap vs N. A shortlist that is all points stories (the story step does not guarantee stat spread) can't pass either.
test("qa: a points-only shortlist across many games still yields a deck", () => {
  const input: CurationInput = { slateDate: "2026-11-23", stories: Array.from({ length: 12 }, (_, i) => story(`s${i}`, `g${i}`, "pts")) };
  const best = bestPossible(input, PROD);
  assert.deepEqual(kinds(input, best, PROD), [], "only 4 points cards are allowed but 10 are demanded");
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

// attacks: "one-line reason" with Unicode line breaks. JS trim() and /[\r\n]/ don't catch U+2028/U+2029/NEL/VT/FF.
test("qa: a reason with a Unicode line or paragraph separator is not one line", () => {
  const input = slate(4, 4);
  const r: CurationRules = { ...PROD, n: 1 };
  for (const sep of [" ", " ", "\u0085", "\v", "\f"]) {
    const out = { ranking: input.stories.map((s) => s.storyId), picks: [{ storyId: "s0", marketId: "s0-m", reason: `line one${sep}line two` }] };
    assert.deepEqual(kinds(input, out, r), ["reason"], `U+${sep.charCodeAt(0).toString(16).padStart(4, "0")} passed as one line`);
  }
});

// attacks: a leading newline. The check trims before testing, but the untrimmed reason is what is stored and posted.
test("qa: a reason that starts with a newline is rejected (or stored trimmed), not posted as two lines", () => {
  const input = slate(4, 4);
  const r: CurationRules = { ...PROD, n: 1 };
  const out = { ranking: input.stories.map((s) => s.storyId), picks: [{ storyId: "s0", marketId: "s0-m", reason: "\nWhy a fan cares\n" }] };
  const res = checkSelection(input, out, r);
  if (res.ok) assert.ok(!/[\r\n]/.test(res.selection.picks[0]!.reason), `accepted reason keeps its newlines: ${JSON.stringify(res.selection.picks[0]!.reason)}`);
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

// coverage: prototype-ish keys as ids are plain data (Map lookups), never a crash or a false match.
test("qa coverage: __proto__ / constructor / toString as story or market ids are just unknown ids", () => {
  const input = slate(4, 4);
  const r: CurationRules = { ...PROD, n: 1 };
  for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.deepEqual(kinds(input, { ranking: input.stories.map((s) => s.storyId), picks: [{ storyId: id, marketId: "s0-m", reason: "x" }] }, r).sort(), ["unknown_story"]);
    assert.deepEqual(kinds(input, { ranking: input.stories.map((s) => s.storyId), picks: [{ storyId: "s0", marketId: id, reason: "x" }] }, r), ["unknown_strike"]);
    assert.deepEqual(kinds(input, JSON.parse(`{"ranking": [], "picks": [], "${id}": {"x": 1}}`), r).includes("ranking"), true);
  }
  // and a real story whose id is "__proto__" works
  const odd: CurationInput = { slateDate: "x", stories: [story("__proto__", "g1", "pts")] };
  assert.deepEqual(kinds(odd, { ranking: ["__proto__"], picks: [{ storyId: "__proto__", marketId: "__proto__-m", reason: "x" }] }, { ...PROD, n: 1 }), []);
});

// coverage: numeric ids (what a model may emit for our numeric shortlist ids) are malformed, not coerced.
test("qa coverage: numeric storyId/marketId and a non-string reason are malformed", () => {
  const input = slate(4, 4);
  for (const p of [{ storyId: 0, marketId: "s0-m", reason: "x" }, { storyId: "s0", marketId: 1, reason: "x" }, { storyId: "s0", marketId: "s0-m", reason: null }]) {
    assert.deepEqual(kinds(input, { ranking: ["s0", "s1", "s2", "s3"], picks: [p] }, { ...PROD, n: 1 }), ["malformed"]);
  }
  assert.deepEqual(kinds(input, { ranking: [0, 1], picks: [] }, PROD), ["malformed"]);
});

// coverage: the same story picked twice, and one player with two stories.
test("qa coverage: the same story twice, or two stories of one player, is a player_repeat", () => {
  const input: CurationInput = { slateDate: "x", stories: [story("a", "g1", "pts"), story("b", "g2", "reb", { playerId: "p-a" }), story("c", "g3", "ast")] };
  const r: CurationRules = { ...PROD, n: 2 };
  const rank = ["a", "b", "c"];
  assert.ok(kinds(input, { ranking: rank, picks: [{ storyId: "c", marketId: "c-m", reason: "x" }, { storyId: "c", marketId: "c-m", reason: "x" }] }, r).includes("player_repeat"));
  assert.ok(kinds(input, { ranking: rank, picks: [{ storyId: "a", marketId: "a-m", reason: "x" }, { storyId: "b", marketId: "b-m", reason: "x" }] }, r).includes("player_repeat"));
  // two players → want is 2 even though there are 3 stories
  assert.deepEqual(kinds(input, { ranking: rank, picks: [{ storyId: "b", marketId: "b-m", reason: "x" }, { storyId: "c", marketId: "c-m", reason: "x" }] }, r), []);
  // the model can't borrow another story's strike, even the same player's
  assert.ok(kinds(input, { ranking: rank, picks: [{ storyId: "a", marketId: "b-m", reason: "x" }, { storyId: "c", marketId: "c-m", reason: "x" }] }, r).includes("unknown_strike"));
});

// coverage: a ladder that lists one marketId twice with different prices can't sneak an out-of-band rung through.
test("qa coverage: duplicate marketIds on a ladder never accept an out-of-band price", () => {
  const dup = story("a", "g1", "pts", { ladder: [{ marketId: "m", strike: 20, yesPriceCents: 90 }, { marketId: "m", strike: 25, yesPriceCents: 50 }] });
  const r = checkSelection({ slateDate: "x", stories: [dup] }, { ranking: ["a"], picks: [{ storyId: "a", marketId: "m", reason: "x" }] }, { ...PROD, n: 1 });
  assert.equal(r.ok, false);
});

// coverage: caps are inclusive at the edge and the band edges are inclusive.
test("qa coverage: exactly maxPerGame / maxPerStat picks pass; one more fails", () => {
  const r: CurationRules = { ...PROD, n: 3, maxPerGame: 3, maxPerStat: 3 };
  const input: CurationInput = { slateDate: "x", stories: ["a", "b", "c", "d"].map((id) => story(id, "g1", "pts", { ladder: [{ marketId: `${id}-m`, strike: 25, yesPriceCents: id === "a" ? 25 : 75 }] })) };
  const ok = { ranking: ["a", "b", "c", "d"], picks: ["a", "b", "c"].map((id) => ({ storyId: id, marketId: `${id}-m`, reason: "x" })) };
  assert.deepEqual(kinds(input, ok, r), []);
  const four = { ...ok, picks: ["a", "b", "c", "d"].map((id) => ({ storyId: id, marketId: `${id}-m`, reason: "x" })) };
  // four picks is over the caps AND over the most the caps allow (3), so pick_count is reported too (changed with the cap-aware count)
  assert.deepEqual(kinds(input, four, { ...r, n: 4 }).sort(), ["game_cap", "pick_count", "stat_cap"]);
});

// coverage: maxAttempts edge values that config bounds already forbid are still refused by code.
test("qa coverage: maxAttempts 0, -1, 1.5, NaN, Infinity throw before any call", async () => {
  for (const m of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const c = always({});
    await assert.rejects(curateWithRules(c, slate(4, 4), { ...PROD, maxAttempts: m }, async () => {}));
    assert.equal(c.calls, 0);
  }
});

// coverage: markdown and mentions in player names / reasons can't break the post's structure or its size limit.
test("qa coverage: a 10k-char reason and markdown in names keep every chunk under Discord's limit", () => {
  const input: CurationInput = { slateDate: "x", stories: Array.from({ length: 30 }, (_, i) => story(`s${i}`, `g${i}`, "pts", { playerName: `@everyone **${"x".repeat(60)}` })) };
  const sel = { ranking: [], picks: input.stories.map((s) => ({ storyId: s.storyId, marketId: `${s.storyId}-m`, reason: "y".repeat(10000) })) };
  const chunks = curationPostChunks(input, sel, 1);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk of ${c.length}`);
  assert.equal(chunks.join("\n").match(/^\d+\. /gm)!.length, 30);
});
