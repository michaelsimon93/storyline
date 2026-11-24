// The #testing post for a curation run (STO-11): picks, reasons and the story-type mix. Pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { curationPostChunks, postCuration } from "../src/lib/curationText.js";
import type { CurationInput, CurationStory, Selection } from "../src/domain/curationRules.js";
import { parseCurationConfig } from "../src/lib/config.js";

const story = (id: number, angle: string): CurationStory => ({
  storyId: String(id), playerId: `p${id}`, playerName: `Player ${id}`, gameId: `g${id % 3}`, stat: "pts", angle, summary: "s", signals: [],
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
