import { test } from "node:test";
import assert from "node:assert/strict";
import { whyNotPublishable, storylineTypeOf, type LiveMarket } from "../src/domain/publishRules.js";
import { publishPostChunks } from "../src/lib/publishText.js";
import type { CardBlurb, CitedSignal } from "../src/domain/blurbRules.js";

const rules = { bandMin: 25, bandMax: 75, maxChars: 200 };
const story = { gameId: "g1", playerId: "p1" };
const market: LiveMarket = { status: "open", yesAskCents: 50, gameId: "g1", playerId: "p1" };
const sig = (o: Partial<CitedSignal> = {}): CitedSignal => ({ id: 1, source: "espn", kind: "stat", trust: "verified", summary: "s", observedAt: "2026-11-24T12:00:00Z", slateDate: "2026-11-24", via: "own", ...o });
const blurb = (text: string, signals: CitedSignal[] = [sig()]): CardBlurb => ({
  storyId: "1", blurb: text, facts: { level: "full", market: { player: "P", team: "T", opponent: "O", home: true, stat: "points", strike: 25, yesPriceCents: 50 }, signals },
});
const why = (b: CardBlurb, m: LiveMarket | null = market, started = false) => whyNotPublishable(b, story, m ?? undefined, started, rules)?.reason;

test("a clean card passes; the band is inclusive at both edges", () => {
  assert.equal(why(blurb("Hot.")), undefined);
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: 25 }), undefined);
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: 75 }), undefined);
});

test("a line that drifted out of the band, a closed market, a started game or a wrong market is kept off", () => {
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: 24 }), "out_of_band");
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: 76 }), "out_of_band");
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: null }), "out_of_band");
  assert.equal(why(blurb("Hot."), { ...market, status: "paused" }), "market_closed");
  assert.equal(why(blurb("Hot."), market, true), "game_started");
  assert.equal(why(blurb("Hot."), null), "wrong_market");
  assert.equal(why(blurb("Hot."), { ...market, playerId: "p2" }), "wrong_market");
});

test("a blurb over the limit or empty is kept off", () => {
  assert.equal(why(blurb("x".repeat(201))), "blurb_invalid");
  assert.equal(why(blurb("  ")), "blurb_invalid");
});

test("trust (ADR-024): an unreviewed signal never publishes; an approved post needs its link and its name in the blurb", () => {
  const post = sig({ id: 7, source: "x", kind: "story", trust: "attributed", url: "https://x.com/ShamsCharania/status/1" });
  assert.equal(why(blurb("Per @ShamsCharania, he's back tonight.", [post])), undefined);
  assert.equal(why(blurb("He's back tonight.", [post])), "blurb_invalid");                       // stated as fact, source not named
  assert.equal(why(blurb("Per @ShamsCharania, back.", [{ ...post, url: undefined }])), "blurb_invalid");   // no link to show
  assert.equal(why(blurb("Per @ShamsCharania, back.", [{ ...post, trust: "unreviewed" }])), "blurb_invalid");
});

test("storyline type: known angles map, a new one is 'other' (so a new detector needs no migration)", () => {
  assert.equal(storylineTypeOf("hot_streak"), "hot_streak");
  assert.equal(storylineTypeOf("backup_steps_in"), "injury_opportunity");
  assert.equal(storylineTypeOf("something_new"), "other");
});

test("#testing post: a short set is flagged 'Short: 3 of 5', a full one is not; an approved post's link is shown", () => {
  const post = sig({ trust: "attributed", url: "https://x.com/ShamsCharania/status/1" });
  const card = (i: number) => ({ cardId: `c${i}`, storyId: `${i}`, playerName: `P${i}`, blurb: `Per @ShamsCharania, P${i} is back.`, facts: blurb("", [post]).facts, strike: 25, yesPriceCents: 50 });
  const base = { slateDate: "2026-11-24", curationRunId: 1, skipped: [] };
  const short = publishPostChunks({ ...base, asked: 5, published: [card(1), card(2), card(3)] }).join("\n");
  assert.match(short, /Short: 3 of 5/);
  assert.match(short, /> Per @ShamsCharania, P1 is back\./);
  assert.match(short, /source: <https:\/\/x\.com\/ShamsCharania\/status\/1>/);
  assert.doesNotMatch(publishPostChunks({ ...base, asked: 2, published: [card(1), card(2)] }).join("\n"), /Short/);
});
