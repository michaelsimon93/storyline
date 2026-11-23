// QA (PR #43 delta, STO-109 job side): edges of buildSummary's "player's team must be in the market's game" guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary } from "../src/jobs/stories.js";
import { parseGameLog, parseSchedule } from "../src/domain/espnParse.js";
import type { StoryInputs } from "../src/sources/espnStories.js";
import type { Slate } from "../src/sources/types.js";
import type { StoryConfig } from "../src/lib/config.js";
import { LOGS, P, schedule, NY, TOR, DAY, GAME } from "./helpers/storyWorld.js";

const CFG: StoryConfig = {
  storyMinMinutes: 10, storyBaselineMinGames: 5, storyHotStreakMinGames: 3, storyHotStreakMarginPct: 20,
  storyMinStatAvgTenths: 10, storyReturnMinMissedGames: 3, storyBackupMaxMin: 24, storyBackupOutMinMinutes: 28,
  storyScoreMax: 100, storyScoreReturn: 60, storyBackupOutRecentGames: 3,
  shortlistSize: 50, shortlistSplitHotStreak: 1, shortlistSplitBackFromInjury: 1, shortlistSplitBackupStepsIn: 1,
};

function build(team: number, marketGameId: string) {
  const slate: Slate = {
    slateDate: DAY, league: "nba",
    games: [{ id: GAME, homeTeamId: TOR, awayTeamId: NY, externalId: "1" }],
    teams: [{ id: NY, externalId: String(NY) }, { id: TOR, externalId: String(TOR) }],
    players: [{ id: P.HOT.id, name: P.HOT.name, teamId: team, externalId: P.HOT.espn, injuryStatus: null }],
  };
  const inputs: StoryInputs = {
    feedOk: true, feedDegraded: false, statusByAthlete: new Map(), injuriesByTeam: new Map(),
    teamGames: new Map([[team, parseSchedule(schedule(NY)).rows]]), logs: new Map([[P.HOT.espn, parseGameLog(LOGS[P.HOT.espn]).rows]]),
    calls: 0, failures: [], skippedRows: [], unknownStatuses: [],
  };
  return buildSummary({
    runId: 1, slate, slateDate: DAY, inputs, cfg: CFG,
    stored: new Map([[`player:${P.HOT.id}|form:pts`, { id: 7, date: DAY }]]),
    markets: [{ id: "m1", playerId: P.HOT.id, gameId: marketGameId, stat: "points", strike: 15, yesBidCents: 50, yesAskCents: 52 }],
    rules: { bandMin: 25, bandMax: 75, maxSpreadCents: 5 },
  });
}

// coverage (home side): the existing test covers the away team; the home team must match too.
test("STO-109 qa: a story whose player is on the HOME team of the market's game is matched", () => {
  const { summary, picks } = build(TOR, GAME);
  assert.equal(summary.matched, 1);
  assert.deepEqual(picks.map((k) => [k.teamId, k.gameId, k.marketId]), [[TOR, GAME, "m1"]]);
});

// attack (outside data): a market whose game isn't on the slate (the `!game` branch) is skipped, not thrown on or written.
test("STO-109 qa: a market whose game is not on the slate is skipped and counted as no market", () => {
  const { summary, picks } = build(NY, "00000000-0000-0000-0000-0000000000ff");
  assert.equal(summary.found, 1);
  assert.equal(summary.matched, 0);
  assert.equal(summary.noMarket, 1);
  assert.deepEqual(picks, []);
});
