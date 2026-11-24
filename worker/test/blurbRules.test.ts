// The blurb rules (STO-77, spec §3 "Blurb rules", ADR-014/024): pure checks on what Claude writes for each chosen card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBlurbs, buildBlurbInput, BANNED_WORDS, type BlurbInput, type BlurbRules, type BlurbStory, type TeamsOf } from "../src/domain/blurbRules.js";
import type { CurationInput, CurationSignal, CurationStory, OtherAngleSignal, Selection } from "../src/domain/curationRules.js";

const RULES: BlurbRules = { maxChars: 200, maxAttempts: 3 };
const DAY = "2026-11-24";
const sig = (id: number, o: Partial<CurationSignal> = {}): CurationSignal => ({
  id, source: "espn", kind: "stat", trust: "verified", summary: `fact ${id}`, observedAt: `${DAY}T14:00:00.000Z`, slateDate: DAY, ...o,
});
const other = (id: number, angle: string, o: Partial<CurationSignal> = {}): OtherAngleSignal => ({ ...sig(id, o), angle });
const market = { player: "Buddy Hield", team: "Bulls", opponent: "Raptors", home: true, stat: "threes", strike: 4, yesPriceCents: 48 };
const story = (storyId: string, o: Partial<BlurbStory> = {}): BlurbStory => ({
  storyId, playerName: "Buddy Hield", angle: "hot_streak", summary: "Hot streak", market,
  signals: [sig(1, { summary: "last 5: 4.0 threes a game" })], otherAngleSignals: [], level: "full", ...o,
});
const input = (...stories: BlurbStory[]): BlurbInput => ({ slateDate: DAY, stories });
const answer = (...b: { storyId: string; blurb: string; signalIds: number[] }[]) => ({ blurbs: b });
const ok = (inp: BlurbInput, out: unknown) => { const r = checkBlurbs(inp, out, RULES); assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.violations)); return r.ok ? r.blurbs : []; };
const kinds = (inp: BlurbInput, out: unknown) => { const r = checkBlurbs(inp, out, RULES); assert.equal(r.ok, false); return r.ok ? [] : r.violations.map((v) => v.kind); };

test("a good blurb is accepted, trimmed, and its cited signals are stored as facts", () => {
  const [b] = ok(input(story("1")), answer({ storyId: "1", blurb: "  Hield is hitting four threes a night over his last five.  ", signalIds: [1] }));
  assert.equal(b!.blurb, "Hield is hitting four threes a night over his last five.");
  assert.deepEqual(b!.facts.signals.map((s) => [s.id, s.via, s.summary]), [[1, "own", "last 5: 4.0 threes a game"]]);
  assert.equal(b!.facts.level, "full");
  assert.deepEqual(b!.facts.market, market);
});

test("length: 200 characters is fine, 201 is not, and the limit comes from the rules", () => {
  const long = (n: number) => "x".repeat(n);
  ok(input(story("1")), answer({ storyId: "1", blurb: long(200), signalIds: [1] }));
  assert.deepEqual(kinds(input(story("1")), answer({ storyId: "1", blurb: long(201), signalIds: [1] })), ["length"]);
  assert.equal(checkBlurbs(input(story("1")), answer({ storyId: "1", blurb: long(81), signalIds: [1] }), { ...RULES, maxChars: 80 }).ok, false);
});

test("length counts characters the way the database does (code points), not UTF-16 units", () => {
  ok(input(story("1")), answer({ storyId: "1", blurb: "🔥".repeat(200), signalIds: [1] }));   // 200 code points, 400 UTF-16 units
  assert.deepEqual(kinds(input(story("1")), answer({ storyId: "1", blurb: "🔥".repeat(201), signalIds: [1] })), ["length"]);
});

test("one line of plain text: empty, blank and multi-line blurbs are rejected", () => {
  for (const blurb of ["", "   ", "two\nlines", "tab\there", "nul\u0000x"]) assert.deepEqual(kinds(input(story("1")), answer({ storyId: "1", blurb, signalIds: [1] })), ["format"], JSON.stringify(blurb));
});

test("betting language is rejected whatever the case or ending, but ordinary words that contain it are not", () => {
  for (const w of ["lock", "Hammer", "SMASH", "smashes", "locked", "bet", "betting", "wager", "parlay", "guaranteed", "free money", "sure thing"]) {
    assert.deepEqual(kinds(input(story("1")), answer({ storyId: "1", blurb: `Take the ${w} here`, signalIds: [1] })), ["banned_word"], w);
  }
  ok(input(story("1")), answer({ storyId: "1", blurb: "Better shooting out of the locker room, and a brilliant role to match.", signalIds: [1] }));
});

test("every claim cites: no signal ids is rejected on a full-level story", () => {
  assert.deepEqual(kinds(input(story("1")), answer({ storyId: "1", blurb: "Hot from deep.", signalIds: [] })), ["no_citation"]);
});

test("a cited id must be one the writer was shown for this story: invented, another story's and another player's are all rejected", () => {
  const inp = input(story("1"), story("2", { playerName: "Other Guy", signals: [sig(2)] }));
  assert.deepEqual(kinds(inp, answer({ storyId: "1", blurb: "x", signalIds: [999] }, { storyId: "2", blurb: "y", signalIds: [2] })), ["unknown_signal"]);
  assert.deepEqual(kinds(inp, answer({ storyId: "1", blurb: "x", signalIds: [2] }, { storyId: "2", blurb: "y", signalIds: [2] })), ["unknown_signal"], "story 1 can't cite player 2's signal");
  assert.deepEqual(kinds(inp, answer({ storyId: "1", blurb: "x", signalIds: [1.5] }, { storyId: "2", blurb: "y", signalIds: [2] })), ["malformed"]);
});

test("blurb rules: Hield, picked on hot_streak, he may cite Powell's absence only through his backup_steps_in story's signal id", () => {
  const hield = story("3", {
    signals: [sig(101, { summary: "last 5: 4.0 threes a game" })],
    otherAngleSignals: [other(202, "backup_steps_in", { kind: "injury", summary: "Norman Powell is out tonight" })],
  });
  const [b] = ok(input(hield), answer({ storyId: "3", blurb: "Hield is on a heater and Norman Powell is out, so more shots come his way.", signalIds: [101, 202] }));
  assert.deepEqual(b!.facts.signals.map((s) => [s.id, s.via]), [[101, "own"], [202, "other_angle:backup_steps_in"]]);
  // the same claim with no id for it, or an id that isn't his, is rejected
  assert.deepEqual(kinds(input(hield), answer({ storyId: "3", blurb: "Powell is out.", signalIds: [101, 303] })), ["unknown_signal"]);
});

test("trust: a story whose only signals are unreviewed was built as market-only, so citing an unreviewed id is rejected", () => {
  // buildBlurbInput drops unreviewed signals; the check itself only ever allows what is in the input
  const inp = input(story("1", { signals: [sig(1)], otherAngleSignals: [] }));
  assert.deepEqual(kinds(inp, answer({ storyId: "1", blurb: "From a rumour.", signalIds: [77] })), ["unknown_signal"]);
});

test("blurb rules: a news or injury signal from an earlier day can't be cited at all", () => {
  const inp = input(story("1", { signals: [sig(1), sig(5, { kind: "injury", slateDate: "2026-11-22", observedAt: "2026-11-22T14:00:00.000Z" })] }));
  assert.deepEqual(kinds(inp, answer({ storyId: "1", blurb: "Out tonight.", signalIds: [5] })), ["dated_news"]);
});

test("blurb rules: a dated stat may be cited, but not dressed up as fresh news", () => {
  const inp = input(story("1", { signals: [sig(1, { slateDate: "2026-11-21", observedAt: "2026-11-21T14:00:00.000Z" })] }));
  ok(inp, answer({ storyId: "1", blurb: "Four threes a night over his last five games.", signalIds: [1] }));
  for (const blurb of ["Breaking: four threes a night.", "Just announced: he's on fire.", "Per this morning's report he is hot."]) {
    assert.deepEqual(kinds(inp, answer({ storyId: "1", blurb, signalIds: [1] })), ["dated_phrasing"], blurb);
  }
  // the same words are fine when every cited signal is from today
  ok(input(story("1")), answer({ storyId: "1", blurb: "Breaking: four threes a night.", signalIds: [1] }));
});

test("market-only level (ADR-024 rule 7.3): no signals to cite, and only the market's own numbers may appear", () => {
  const m = story("1", { level: "market_only", signals: [], otherAngleSignals: [] });
  const [b] = ok(input(m), answer({ storyId: "1", blurb: "Hield and the Bulls host the Raptors; the line is 4 threes.", signalIds: [] }));
  assert.deepEqual(b!.facts, { level: "market_only", market, signals: [] });
  assert.deepEqual(kinds(input(m), answer({ storyId: "1", blurb: "He has hit 6 in a row.", signalIds: [] })), ["market_only_number"], "an invented stat can't slip in");
  ok(input(m), answer({ storyId: "1", blurb: "Hield to hit 4+ threes at 48 cents.", signalIds: [] }));
  assert.deepEqual(kinds(input(m), answer({ storyId: "1", blurb: "Hield at the Raptors.", signalIds: [1] })), ["unknown_signal"], "nothing to cite on a market-only story");
});

test("the answer must cover exactly the chosen stories, once each", () => {
  const inp = input(story("1"), story("2", { signals: [sig(2)] }));
  const b = (id: string, s: number) => ({ storyId: id, blurb: "x", signalIds: [s] });
  assert.deepEqual(kinds(inp, answer(b("1", 1))), ["story_set"], "missing story 2");
  assert.deepEqual(kinds(inp, answer(b("1", 1), b("2", 2), b("3", 1))), ["story_set"], "an extra story");
  assert.deepEqual(kinds(inp, answer(b("1", 1), b("1", 1), b("2", 2))), ["story_set"], "a story twice");
  ok(inp, answer(b("2", 2), b("1", 1)));   // any order
});

test("malformed answers are reported, never thrown on", () => {
  for (const out of [null, "Sure!", 7, [], {}, { blurbs: "x" }, { blurbs: [null] }, { blurbs: [{ storyId: "1", blurb: 5, signalIds: [1] }] },
    { blurbs: [{ storyId: "1", blurb: "x", signalIds: "1" }] }, { blurbs: [{ storyId: "1", blurb: "x" }] }]) {
    assert.deepEqual(kinds(input(story("1")), out), ["malformed"], JSON.stringify(out));
  }
});

test("every problem is reported at once so one retry can fix them all", () => {
  const inp = input(story("1"), story("2", { signals: [sig(2)] }));
  const r = checkBlurbs(inp, answer({ storyId: "1", blurb: "Smash it", signalIds: [] }, { storyId: "2", blurb: "x".repeat(300), signalIds: [2] }), RULES);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.violations.map((v) => v.kind).sort(), ["banned_word", "length", "no_citation"]);
});

test("duplicate cited ids are collapsed so blurb_facts lists each fact once", () => {
  const [b] = ok(input(story("1")), answer({ storyId: "1", blurb: "Hot.", signalIds: [1, 1] }));
  assert.equal(b!.facts.signals.length, 1);
});

// ---------------------------------------------------------------- building the blurb input

const pickStory = (id: string, playerId: string, o: Partial<CurationStory> = {}): CurationStory => ({
  storyId: id, playerId, playerName: `P ${playerId}`, gameId: "g1", stat: "pts", angle: "hot_streak", summary: "s",
  signals: [sig(Number(id))], otherAngleSignals: [], ladder: [{ marketId: `m${id}`, strike: 25, yesPriceCents: 55 }, { marketId: `m${id}b`, strike: 30, yesPriceCents: 30 }], ...o,
});
const teams: TeamsOf = (s) => ({ team: "Bulls", opponent: "Raptors", home: s.gameId === "g1" });

test("buildBlurbInput: only the chosen stories, each with the strike that was picked", () => {
  const shown: CurationInput = { slateDate: DAY, stories: [pickStory("1", "a"), pickStory("2", "b")] };
  const sel: Selection = { ranking: ["1", "2"], picks: [{ storyId: "2", marketId: "m2b", reason: "r" }] };
  const out = buildBlurbInput(shown, sel, teams);
  assert.deepEqual(out.stories.map((s) => s.storyId), ["2"]);
  assert.deepEqual([out.stories[0]!.market.strike, out.stories[0]!.market.yesPriceCents, out.stories[0]!.market.stat], [30, 30, "points"]);
  assert.equal(out.stories[0]!.level, "full");
});

test("buildBlurbInput: unreviewed signals never reach the writer, and an attributed one needs a link", () => {
  const s = pickStory("1", "a", {
    signals: [sig(1), sig(2, { trust: "unreviewed", source: "x" }), sig(3, { trust: "attributed", source: "x" }), sig(4, { trust: "attributed", source: "x", url: "https://x.test/p/1" })],
    otherAngleSignals: [other(5, "backup_steps_in", { trust: "unreviewed" }), other(6, "backup_steps_in")],
  });
  const [b] = buildBlurbInput({ slateDate: DAY, stories: [s] }, { ranking: ["1"], picks: [{ storyId: "1", marketId: "m1", reason: "r" }] }, teams).stories;
  assert.deepEqual(b!.signals.map((x) => x.id), [1, 4]);
  assert.deepEqual(b!.otherAngleSignals.map((x) => x.id), [6]);
  assert.equal(b!.level, "full");
});

test("buildBlurbInput: a story left with no usable signal is market-only (ESPN down, or only unreviewed posts)", () => {
  const s = pickStory("1", "a", { signals: [sig(2, { trust: "unreviewed" })], otherAngleSignals: [] });
  const [b] = buildBlurbInput({ slateDate: DAY, stories: [s] }, { ranking: ["1"], picks: [{ storyId: "1", marketId: "m1", reason: "r" }] }, teams).stories;
  assert.equal(b!.level, "market_only");
  assert.deepEqual(b!.signals, []);
});

test("buildBlurbInput: a pick that isn't on the shown stories is a bug, not something to paper over", () => {
  assert.throws(() => buildBlurbInput({ slateDate: DAY, stories: [pickStory("1", "a")] }, { ranking: [], picks: [{ storyId: "9", marketId: "m", reason: "r" }] }, teams), /story 9/);
  assert.throws(() => buildBlurbInput({ slateDate: DAY, stories: [pickStory("1", "a")] }, { ranking: [], picks: [{ storyId: "1", marketId: "nope", reason: "r" }] }, teams), /market nope/);
});

test("the banned list is the one the style guide shows (see blurbStyleGuide.test.ts); it has the three from the ticket", () => {
  for (const w of ["lock", "hammer", "smash"]) assert.ok((BANNED_WORDS as readonly string[]).includes(w));
});
