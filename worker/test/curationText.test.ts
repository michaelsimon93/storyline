// The #testing post for a curation run (STO-11): picks, reasons and the story-type mix. Pure.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { curationPostChunks, postCuration } from "../src/lib/curationText.js";
import type { CurationInput, CurationStory, Selection } from "../src/domain/curationRules.js";
import { parseCurationConfig } from "../src/lib/config.js";
import * as H from "./helpers/curationSlates.js";

const story = (id: number, angle: string): CurationStory => ({
  storyId: String(id), playerId: `p${id}`, playerName: `Player ${id}`, gameId: `g${id % 3}`, stat: "pts", angle, summary: "s", signals: [], otherAngleSignals: [],
  ladder: [{ marketId: `m${id}`, strike: 20 + id, yesPriceCents: 40 }],
});
const shown = (n: number): CurationInput => ({ slateDate: "2026-11-23", stories: Array.from({ length: n }, (_, i) => story(i + 1, i % 2 ? "back_from_injury" : "hot_streak")) });
const sel = (n: number, reason = "He is on a tear"): Selection => ({ ranking: [], picks: Array.from({ length: n }, (_, i) => ({ storyId: String(i + 1), marketId: `m${i + 1}`, reason })) });

test("each pick shows player, stat, strike, price, story type and reason, in deck order", () => {
  const [post] = curationPostChunks(shown(4), sel(2), 1);
  assert.match(post!, /Curation 2026-11-23\*\*: 2 cards from 4 stories \(attempt 1\)/);
  assert.match(post!, /1\. \*\*Player 1\*\* pts 21\+ at 40c · `hot_streak`\n   He is on a tear/);
  assert.match(post!, /2\. \*\*Player 2\*\* pts 22\+ at 40c · `back_from_injury`/);
});

test("it shows the story-type mix of the picks next to the shortlist's, so one type dominating is visible", () => {
  const post = curationPostChunks(shown(6), sel(3), 2).join("\n");
  assert.match(post, /Story types picked: hot_streak 2, back_from_injury 1\./);
  assert.match(post, /On the shortlist: back_from_injury 3, hot_streak 3\./);
});

test("a long deck splits into messages under Discord's limit, never cutting a pick in half", () => {
  const chunks = curationPostChunks(shown(10), sel(10, "x".repeat(300)), 1);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1800, `${c.length} chars`);
  const all = chunks.join("\n");
  for (let i = 1; i <= 10; i++) assert.ok(all.includes(`${i}. **Player ${i}**`));
  assert.ok(all.includes("…"), "a very long reason is truncated");
  assert.ok(!all.includes("x".repeat(300)));
});

test("a pick the post can't find still shows, flagged, instead of throwing", () => {
  const [post] = curationPostChunks(shown(1), { ranking: [], picks: [{ storyId: "99", marketId: "zz", reason: "r" }] }, 1);
  assert.match(post!, /1\. \*\*99\*\* \? \? · `\?`/);
});

test("postCuration posts every chunk, in order", async () => {
  const posted: string[] = [];
  await postCuration({ post: async (c) => { posted.push(c); } }, shown(10), sel(10, "y".repeat(300)), 1);
  assert.deepEqual(posted, curationPostChunks(shown(10), sel(10, "y".repeat(300)), 1));
});

test("curation settings: every missing or mistyped key is named at once", () => {
  assert.throws(() => parseCurationConfig([{ key: "curation_model", value: 5 }]), (e: Error) =>
    /curation_model should be string/.test(e.message) && /missing curation_max_attempts/.test(e.message) && /missing price_band_min/.test(e.message));
});

test("a deck shorter than asked says so, with the reason; a full deck doesn't", () => {
  const short = curationPostChunks(shown(4), sel(2), 1, 10)[0]!;
  assert.match(short, /\*\*Short deck: asked for 10\*\*, the game and stat caps and the players available allow 2/);
  assert.doesNotMatch(curationPostChunks(shown(4), sel(2), 1, 2)[0]!, /Short deck/);
  assert.doesNotMatch(curationPostChunks(shown(4), sel(2), 1)[0]!, /Short deck/);
});

// blurbs in the #testing post
test("blurbs are quoted under their pick with the ids they cite, the other angle's marked, and the level mix is tallied", () => {
  const shown = { slateDate: "2026-11-24", stories: [story(1, "hot_streak"), story(2, "backup_steps_in")] } satisfies CurationInput;
  const sel = { ranking: ["1", "2"], picks: [{ storyId: "1", marketId: "m1", reason: "why" }, { storyId: "2", marketId: "m2", reason: "why" }] };
  const market = { player: "p", team: "t", opponent: "o", home: true, stat: "points", strike: 25, yesPriceCents: 55 };
  const sg = (id: number, via: string) => ({ id, source: "espn", kind: "stat" as const, trust: "verified" as const, summary: "s", observedAt: "2026-11-24T14:00:00.000Z", slateDate: "2026-11-24", via });
  const text = curationPostChunks(shown, sel, 1, 2, [
    { storyId: "1", blurb: "A fine blurb.", facts: { level: "full", market, signals: [sg(11, "own"), sg(12, "other_angle:backup_steps_in")] } },
    { storyId: "2", blurb: "Thin one.", facts: { level: "market_only", market, signals: [] } },
  ]).join("\n");
  assert.match(text, /> A fine blurb\.\n\s+cites 11, 12 \(same player, other angle\) · full/);
  assert.match(text, /> Thin one\.\n\s+cites nothing \(market only\) · market_only/);
  assert.match(text, /Blurbs: full 1, market_only 1\./);
});

describe("hostile and boundary inputs", () => {
const { story } = H;

// coverage: markdown and mentions in player names / reasons can't break the post's structure or its size limit.
test("curation text: a 10k-char reason and markdown in names keep every chunk under Discord's limit", () => {
  const input: CurationInput = { slateDate: "x", stories: Array.from({ length: 30 }, (_, i) => story(`s${i}`, `g${i}`, "pts", { playerName: `@everyone **${"x".repeat(60)}` })) };
  const sel = { ranking: [], picks: input.stories.map((s) => ({ storyId: s.storyId, marketId: `${s.storyId}-m`, reason: "y".repeat(10000) })) };
  const chunks = curationPostChunks(input, sel, 1);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk of ${c.length}`);
  assert.equal(chunks.join("\n").match(/^\d+\. /gm)!.length, 30);
});
});
