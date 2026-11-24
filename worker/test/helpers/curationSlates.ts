// Builders for curation tests: a slate of N players over G games, the best answer the caps allow, a fake curator.
import { checkSelection, type CurationInput, type CurationRules, type CurationStory } from "../../src/domain/curationRules.js";
import type { CurationRequest } from "../../src/sources/curate.js";
import type { Curator } from "../../src/sources/types.js";

/** The starting app_config values from the migration: cards_per_day 10, band 25-75, 3 per game, 4 per stat, 3 attempts. */
export const PROD: CurationRules = { n: 10, bandMin: 25, bandMax: 75, maxPerGame: 3, maxPerStat: 4, maxAttempts: 3 };
export const STATS = ["pts", "reb", "ast", "3pm"];

export const story = (id: string, gameId: string, stat: string, o: Partial<CurationStory> = {}): CurationStory => ({
  storyId: id, playerId: `p-${id}`, playerName: `Player ${id}`, gameId, stat, angle: "hot_streak", summary: id, signals: [],
  ladder: [{ marketId: `${id}-m`, strike: 25, yesPriceCents: 50 }], ...o,
});
/** `players` distinct players spread round-robin over `games` games and the four stats. */
export const slate = (games: number, players: number): CurationInput => ({
  slateDate: "2026-11-23",
  stories: Array.from({ length: players }, (_, i) => story(`s${i}`, `g${i % games}`, STATS[i % STATS.length]!)),
});
/** The largest answer that respects every cap: greedy, one per player, under the game and stat caps. */
export const bestPossible = (input: CurationInput, r: CurationRules) => {
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
export const always = (answer: unknown): Curator<CurationRequest, unknown> & { calls: number } => {
  const c = { name: "fake", calls: 0, async curate() { c.calls++; return answer; } };
  return c;
};
export const kinds = (input: CurationInput, out: unknown, r: CurationRules) => {
  const res = checkSelection(input, out, r);
  return res.ok ? [] : res.violations.map((v) => v.kind);
};
