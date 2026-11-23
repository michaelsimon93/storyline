// The pure rules of the story step (STO-76, STO-102, STO-103): who is dropped for not playing tonight, which market a
// story matches, and how the shortlist is split across angles. No database, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dropNotPlaying, pickMarket, quotas, buildShortlist, MARKET_STAT, type MarketRow, type Matched } from "../src/domain/storyShortlist.js";
import { parseInjuryStatus } from "../src/domain/injuryStatus.js";
import type { StoryCandidate } from "../src/domain/storyDetectors.js";

const story = (playerId: string, angle: string, score: number, stat: StoryCandidate["stat"] = "pts"): StoryCandidate =>
  ({ playerId, angle, stat, score, summary: `${angle} ${playerId}`, basis: [] });
const matched = (playerId: string, angle: string, score: number, stat: StoryCandidate["stat"] = "pts"): Matched =>
  ({ ...story(playerId, angle, score, stat), teamId: 1, gameId: "g1", marketId: `m-${playerId}-${stat}`, signalIds: [1] });

// ---------------------------------------------------------------- STO-102: plays tonight

test("an Out player's hot streak is dropped before matching (STO-102)", () => {
  const stories = [story("healthy", "hot_streak", 50), story("out", "hot_streak", 90)];
  const tonight = new Map([["healthy", null], ["out", parseInjuryStatus("Out")]]);
  const { kept, dropped } = dropNotPlaying(stories, tonight);
  assert.deepEqual(kept.map((s) => s.playerId), ["healthy"]);
  assert.deepEqual(dropped.map((s) => s.playerId), ["out"]);
});

test("Doubtful and a status we don't recognise are dropped too; Questionable and Day-To-Day stay", () => {
  const tonight = new Map([
    ["doubtful", parseInjuryStatus("Doubtful")], ["weird", parseInjuryStatus("Suspended")],
    ["questionable", parseInjuryStatus("Questionable")], ["dtd", parseInjuryStatus("Day-To-Day")],
  ]);
  const { kept } = dropNotPlaying(["doubtful", "weird", "questionable", "dtd"].map((p) => story(p, "hot_streak", 50)), tonight);
  assert.deepEqual(kept.map((s) => s.playerId), ["questionable", "dtd"]);
});

test("a player we have no status for is dropped, not assumed healthy (fail closed)", () => {
  const { kept, dropped } = dropNotPlaying([story("unknown", "hot_streak", 50)], new Map());
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test("it applies to every angle, not just hot streak", () => {
  const tonight = new Map([["a", parseInjuryStatus("Out")]]);
  const { kept } = dropNotPlaying(["hot_streak", "back_from_injury", "backup_steps_in", "revenge"].map((g) => story("a", g, 50)), tonight);
  assert.equal(kept.length, 0);
});

// ---------------------------------------------------------------- matching to a market

const mk = (id: string, strike: number, bid: number | null, ask: number | null, over: Partial<MarketRow> = {}): MarketRow =>
  ({ id, playerId: "p1", gameId: "g1", teamId: 1, stat: "points", strike, yesBidCents: bid, yesAskCents: ask, ...over });
const RULES = { bandMin: 25, bandMax: 75, maxSpreadCents: 5 };

test("a story matches a market on its player and stat, in the band, within the spread", () => {
  const got = pickMarket({ playerId: "p1", stat: "pts" }, [mk("a", 20, 48, 52)], RULES);
  assert.equal(got?.id, "a");
});

test("the stat names map to the market's stat (pts→points, 3pm→threes)", () => {
  assert.deepEqual(MARKET_STAT, { pts: "points", reb: "rebounds", ast: "assists", "3pm": "threes" });
  assert.equal(pickMarket({ playerId: "p1", stat: "3pm" }, [mk("a", 3, 48, 52)], RULES), undefined, "a points market is not a threes market");
  assert.equal(pickMarket({ playerId: "p1", stat: "3pm" }, [mk("t", 3, 48, 52, { stat: "threes" })], RULES)?.id, "t");
});

test("another player's market never matches", () => {
  assert.equal(pickMarket({ playerId: "p1", stat: "pts" }, [mk("a", 20, 48, 52, { playerId: "p2" })], RULES), undefined);
});

test("the price band is inclusive at both ends and the Yes price is the ask", () => {
  const at = (ask: number) => pickMarket({ playerId: "p1", stat: "pts" }, [mk("a", 20, ask - 2, ask)], RULES);
  assert.ok(at(25) && at(75));
  assert.equal(at(24), undefined);
  assert.equal(at(76), undefined);
});

test("the spread limit is inclusive: 5 cents passes, 6 does not", () => {
  const s = (spread: number) => pickMarket({ playerId: "p1", stat: "pts" }, [mk("a", 20, 50, 50 + spread)], RULES);
  assert.ok(s(5));
  assert.equal(s(6), undefined);
});

test("a market with no bid or no ask, or a crossed book, never matches", () => {
  const p = { playerId: "p1", stat: "pts" } as const;
  assert.equal(pickMarket(p, [mk("a", 20, null, 50)], RULES), undefined);
  assert.equal(pickMarket(p, [mk("a", 20, 50, null)], RULES), undefined);
  assert.equal(pickMarket(p, [mk("a", 20, 55, 50)], RULES), undefined, "bid above ask is bad data, not a zero spread");
});

test("with several qualifying strikes it takes the one closest to a coin flip, then the lower strike, then the lower id", () => {
  const p = { playerId: "p1", stat: "pts" } as const;
  assert.equal(pickMarket(p, [mk("a", 15, 68, 70), mk("b", 20, 53, 55), mk("c", 25, 33, 35)], RULES)?.id, "b");
  assert.equal(pickMarket(p, [mk("hi", 25, 43, 45), mk("lo", 20, 53, 55)], RULES)?.id, "lo", "45 and 55 are both 5 from 50: lower strike");
  assert.equal(pickMarket(p, [mk("z", 20, 48, 50), mk("y", 20, 48, 50)], RULES)?.id, "y", "identical: lower id, so a re-run picks the same one");
});

// ---------------------------------------------------------------- STO-103: the quota

test("an even split of 50 over three angles is 16 each, and the 2 left over are filled by score", () => {
  assert.deepEqual(quotas(50, { hot_streak: 1, back_from_injury: 1, backup_steps_in: 1 }), { hot_streak: 16, back_from_injury: 16, backup_steps_in: 16 });
});

test("weights shift the split; the quota rounds down", () => {
  assert.deepEqual(quotas(10, { a: 2, b: 1, c: 1 }), { a: 5, b: 2, c: 2 });
  assert.deepEqual(quotas(10, { a: 1, b: 0 }), { a: 10, b: 0 });
});

test("all weights zero means no quota at all: everything is filled by score", () => {
  assert.deepEqual(quotas(10, { a: 0, b: 0 }), { a: 0, b: 0 });
});

test("each angle is represented even when its scores are far lower (the point of STO-103)", () => {
  // hot streak scores 20-60ish, backups 28-70, returns 60+: on a pure score sort the 40 hot streaks would all lose.
  const stories = [
    ...Array.from({ length: 40 }, (_, i) => matched(`r${i}`, "back_from_injury", 90 - i)),
    ...Array.from({ length: 40 }, (_, i) => matched(`b${i}`, "backup_steps_in", 70 - i)),
    ...Array.from({ length: 40 }, (_, i) => matched(`h${i}`, "hot_streak", 40 - i / 2)),
  ];
  const list = buildShortlist(stories, 50, { hot_streak: 1, back_from_injury: 1, backup_steps_in: 1 });
  const by = (a: string) => list.filter((e) => e.angle === a);
  assert.equal(list.length, 50);
  assert.equal(by("hot_streak").filter((e) => e.slotKind === "quota").length, 16, "hot streaks hold their 16 despite the lowest scores");
  assert.equal(by("back_from_injury").filter((e) => e.slotKind === "quota").length, 16);
  assert.equal(by("backup_steps_in").filter((e) => e.slotKind === "quota").length, 16);
  // the 2 spare slots go to the best remaining scores, whatever the angle: the returns (90-16, 90-17)
  const fill = list.filter((e) => e.slotKind === "fill");
  assert.deepEqual(fill.map((e) => [e.angle, e.score]), [["back_from_injury", 74], ["back_from_injury", 73]]);
});

test("within an angle the order is that angle's own score", () => {
  const list = buildShortlist([matched("a", "hot_streak", 30), matched("b", "hot_streak", 80), matched("c", "hot_streak", 50)], 3, { hot_streak: 1 });
  assert.deepEqual(list.map((e) => e.playerId), ["b", "c", "a"]);
});

test("an angle with too few stories gives its unused slots to the best of the rest", () => {
  const stories = [matched("r1", "back_from_injury", 61), ...Array.from({ length: 10 }, (_, i) => matched(`h${i}`, "hot_streak", 50 - i))];
  const list = buildShortlist(stories, 6, { hot_streak: 1, back_from_injury: 1 });   // quota 3 each, but only 1 return
  assert.equal(list.length, 6);
  assert.deepEqual(list.filter((e) => e.angle === "back_from_injury").map((e) => e.slotKind), ["quota"]);
  assert.equal(list.filter((e) => e.angle === "hot_streak").length, 5, "3 by quota and 2 more filled by score");
  assert.deepEqual(list.filter((e) => e.slotKind === "fill").map((e) => e.angle), ["hot_streak", "hot_streak"]);
});

test("an angle with no configured weight gets no quota but can win a fill slot", () => {
  const list = buildShortlist([matched("a", "hot_streak", 10), matched("t", "trending", 99)], 2, { hot_streak: 1 });
  assert.deepEqual(list.map((e) => [e.angle, e.slotKind]), [["hot_streak", "quota"], ["trending", "fill"]]);
});

test("fewer stories than slots: all of them, no padding", () => {
  assert.equal(buildShortlist([matched("a", "hot_streak", 10)], 50, { hot_streak: 1 }).length, 1);
  assert.deepEqual(buildShortlist([], 50, { hot_streak: 1 }), []);
});

test("one player appears once per angle, with his best stat, so one hot player can't fill an angle's quota", () => {
  const stories = [matched("a", "hot_streak", 40, "pts"), matched("a", "hot_streak", 70, "reb"), matched("a", "hot_streak", 55, "ast"), matched("b", "hot_streak", 30, "pts")];
  const list = buildShortlist(stories, 10, { hot_streak: 1 });
  assert.deepEqual(list.map((e) => [e.playerId, e.stat, e.score]), [["a", "reb", 70], ["b", "pts", 30]]);
});

test("positions are 1..n and unique; the same input always gives the same list", () => {
  const stories = [matched("a", "hot_streak", 50), matched("b", "back_from_injury", 50), matched("c", "hot_streak", 50)];
  const one = buildShortlist(stories, 10, { hot_streak: 1, back_from_injury: 1 });
  const two = buildShortlist([...stories].reverse(), 10, { hot_streak: 1, back_from_injury: 1 });
  assert.deepEqual(one.map((e) => e.position), [1, 2, 3]);
  assert.deepEqual(one, two, "input order doesn't matter: ties break on a fixed key");
});
