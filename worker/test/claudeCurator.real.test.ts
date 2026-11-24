// A REAL curation answer (STO-118): what Claude returned in the first production run, slate 2026-11-23, accepted on attempt 1.
// It was copied from curation_attempts.output (jsonb_pretty) and is not edited. The key order is Postgres's (jsonb sorts keys).
// What this proves: the curator hands a real answer on unchanged, and our rule checks accept its real shape.
// What it can't: the full reply envelope (stop reason, token counts) was never stored, only the parsed answer (STO-115), and the
// stories and ladders Claude was shown weren't kept in this fixture, so the input below is scaffolding built from the answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { createClaudeCurator } from "../src/sources/claudeCurator.js";
import { checkSelection, type CurationInput, type CurationRules } from "../src/domain/curationRules.js";
import type { CurationRequest } from "../src/sources/curate.js";

const REAL = JSON.parse(readFileSync(new URL("./fixtures/claude-curation-answer-2026-11-23.json", import.meta.url), "utf8")) as {
  ranking: string[]; picks: { storyId: string; marketId: string; reason: string }[];
};
const RULES: CurationRules = { n: 10, bandMin: 25, bandMax: 75, maxPerGame: 3, maxPerStat: 4, maxAttempts: 3 };

/** One story per ranked id; each picked story's ladder holds the market Claude chose, priced inside the band. Games and stats are made up (round-robin). */
const scaffold = (): CurationInput => ({
  slateDate: "2026-11-23",
  stories: REAL.ranking.map((id, i) => ({
    storyId: id, playerId: `player-${id}`, playerName: `Player ${id}`, gameId: `game-${i % 5}`, stat: ["pts", "reb", "ast", "3pm"][i % 4]!,
    angle: "hot_streak", summary: "s", signals: [], otherAngleSignals: [],
    ladder: [{ marketId: REAL.picks.find((p) => p.storyId === id)?.marketId ?? `m-${id}`, strike: 10, yesPriceCents: 40 }],
  })),
});

test("the real answer has exactly the shape we asked for, and nothing else", () => {
  assert.deepEqual(Object.keys(REAL).sort(), ["picks", "ranking"]);
  for (const p of REAL.picks) assert.deepEqual(Object.keys(p).sort(), ["marketId", "reason", "storyId"]);
  for (const id of REAL.ranking) assert.equal(typeof id, "string");
  assert.equal(new Set(REAL.ranking).size, REAL.ranking.length, "every story once");
  assert.equal(REAL.picks.length, RULES.n);
  for (const p of REAL.picks) {
    assert.match(p.marketId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(REAL.ranking.includes(p.storyId));
    assert.equal(p.reason, p.reason.trim());
    assert.doesNotMatch(p.reason, /[\p{Cc}\u2028\u2029]/u);
  }
  assert.deepEqual(REAL.picks.map((p) => p.storyId), REAL.ranking.slice(0, RULES.n), "the deck is the top of the ranking, in order");
});

test("our rule checks accept the real answer", () => {
  const r = checkSelection(scaffold(), REAL, RULES);
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.violations));
  if (r.ok) assert.deepEqual(r.selection.picks, REAL.picks);
});

test("the Claude curator hands the real answer on unchanged, whether or not it is pretty-printed", async () => {
  for (const text of [JSON.stringify(REAL), JSON.stringify(REAL, null, 2)]) {
    const client = { messages: { create: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) } } as unknown as Pick<Anthropic, "messages">;
    const req: CurationRequest = { input: scaffold(), rules: RULES, feedback: [] };
    assert.deepEqual(await createClaudeCurator({ client, model: "m", maxTokens: 1000, effort: "high" }).curate(req), REAL);
  }
});
