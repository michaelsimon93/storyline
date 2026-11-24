// buildSummary, the pure core of the story step: stories in, summary and picks out. The integration test covers the whole
// job; this covers a guard the job's earlier checks make hard to reach end to end (STO-109): a story whose player's team
// isn't in the matched market's game is skipped, not written (the table would refuse the row and fail the whole run).

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

/** Hot Hand's streak, a market for it in `marketGameId` (default GAME, TOR at NY), and Hot Hand's team set to `team` on the slate. */
function build(team: number, marketGameId: string = GAME) {
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

test("control: a story whose player's team is playing in the market's game is matched", () => {
  const { summary, picks } = build(NY);
  assert.equal(summary.matched, 1);
  assert.deepEqual(picks.map((k) => [k.playerId, k.teamId, k.gameId, k.marketId, k.signalIds]), [[P.HOT.id, NY, GAME, "m1", [7]]]);
});

test("STO-109: a story whose player's team is not in the market's game is skipped and counted as no market", () => {
  const { summary, picks } = build(99);
  assert.equal(summary.found, 1, "the streak was found");
  assert.equal(summary.matched, 0);
  assert.equal(summary.noMarket, 1);
  assert.deepEqual(picks, []);
});

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
