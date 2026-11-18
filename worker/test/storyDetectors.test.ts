// The story detectors (STO-76 part 1b): hot streak, back from injury, backup stepping in. Pure.
// Rows are built by hand because the recorded game logs belong to teams whose schedules we haven't recorded
// (see PR). Every detector must fail closed: when we can't tie a log to the team's schedule, there is no story.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameLogRow, FinishedGame } from "../src/domain/espnParse.js";
import { parseInjuryStatus } from "../src/domain/injuryStatus.js";
import { hotStreak, backFromInjury, backupStepsIn, sortStories, ANGLES, type StoryConfig, type StoryCandidate } from "../src/domain/storyDetectors.js";

const CFG: StoryConfig = {
  storyMinMinutes: 10, storyBaselineMinGames: 5, storyHotStreakMinGames: 3, storyHotStreakMarginPct: 20,
  storyMinStatAvgTenths: 10, storyReturnMinMissedGames: 3, storyBackupMaxMin: 24, storyBackupOutMinMinutes: 28,
  storyScoreMax: 100, storyScoreReturn: 60, storyBackupOutRecentGames: 3,
};

/** The team's finished games, oldest first, ids g1..gN a day apart. */
const teamGames = (n: number): FinishedGame[] => Array.from({ length: n }, (_, i) => ({
  eventId: `g${i + 1}`, date: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(), homeId: "1", awayId: "2",
  homeAbbr: "AAA", awayAbbr: "BBB", homeScore: 100, awayScore: 90,
}));
type Line = { pts?: number; reb?: number; ast?: number; fg3m?: number; min?: number };
const row = (id: string, l: Line = {}): GameLogRow => ({
  eventId: id, date: "2026-11-01T00:00Z", home: true, opponentId: "2",
  min: l.min ?? 30, pts: l.pts ?? 0, reb: l.reb ?? 0, ast: l.ast ?? 0, fg3m: l.fg3m ?? 0, fg3a: 0,
});
/** A log from lines given NEWEST FIRST, matched to the team's newest games, skipping `gaps` (0 = newest). */
const logOf = (lines: Line[], gaps: number[] = [], n = 12): GameLogRow[] => {
  const ids = teamGames(n).map((g) => g.eventId).reverse(); // newest first
  const out: GameLogRow[] = [];
  let li = 0;
  ids.forEach((id, i) => { if (!gaps.includes(i) && li < lines.length) out.push(row(id, lines[li++])); });
  return out;
};
const pts = (...v: number[]): Line[] => v.map((p) => ({ pts: p }));
const P = "player-1", TEAM = 28;

// ---------------------------------------------------------------- hot streak

test("hot streak: three straight games above his average, enough above it, is a story about that stat", () => {
  const s = hotStreak({ playerId: P, log: logOf(pts(20, 20, 20, 10, 10, 10, 10, 10)), teamGames: teamGames(12) }, CFG);
  assert.equal(s.length, 1);
  assert.deepEqual([s[0]!.angle, s[0]!.stat, s[0]!.playerId], [ANGLES.hotStreak, "pts", P]);
  assert.deepEqual(s[0]!.basis, [{ subject: { kind: "player", id: P }, key: "form:pts" }]);
  assert.match(s[0]!.summary, /20\.0 PTS.*last 3 games.*13\.8/s);
  assert.equal(s[0]!.score, 45, "the lift over his average, in percent: 20 vs 13.75");
});

test("hot streak: the score is capped at storyScoreMax", () => {
  const s = hotStreak({ playerId: P, log: logOf(pts(40, 40, 40, 5, 5, 5, 5, 5)), teamGames: teamGames(12) }, { ...CFG, storyScoreMax: 80 });
  assert.equal(s[0]!.score, 80);
});

test("hot streak: a DNP last night ends the streak, even if the games before it were hot", () => {
  // newest team game (index 0) has no row: he didn't play
  const log = logOf(pts(30, 30, 30, 10, 10, 10, 10, 10), [0]);
  assert.deepEqual(hotStreak({ playerId: P, log, teamGames: teamGames(12) }, CFG), []);
});

test("hot streak: a DNP inside the run cuts it short instead of being skipped over", () => {
  // two hot games, then a missed game, then more hot games: still only a run of 2
  const log = logOf(pts(30, 30, 30, 30, 10, 10, 10, 10, 10), [2]);
  assert.deepEqual(hotStreak({ playerId: P, log, teamGames: teamGames(12) }, CFG), []);
});

test("hot streak: a game he barely played (under the minimum minutes) ends the streak", () => {
  const lines: Line[] = [{ pts: 30 }, { pts: 30 }, { pts: 30, min: 6 }, { pts: 30 }, ...pts(10, 10, 10, 10, 10)];
  assert.deepEqual(hotStreak({ playerId: P, log: logOf(lines), teamGames: teamGames(12) }, CFG), []);
});

test("hot streak: one game under his average ends it", () => {
  assert.deepEqual(hotStreak({ playerId: P, log: logOf(pts(30, 30, 8, 30, 10, 10, 10, 10, 10)), teamGames: teamGames(12) }, CFG), []);
});

test("hot streak: games with a former team (not on this team's schedule) count for nothing: a traded player gets no streak from them", () => {
  const log = [...logOf(pts(20, 20)), ...Array.from({ length: 6 }, (_, i) => row(`old${i}`, { pts: 40 }))];
  assert.deepEqual(hotStreak({ playerId: P, log, teamGames: teamGames(12) }, CFG), [], "two games for the new team is no streak and no baseline");
});

test("hot streak: a former team's big games don't inflate or hide the baseline", () => {
  const mine = logOf(pts(20, 20, 20, 10, 10, 10, 10, 10));
  const log = [...mine, ...Array.from({ length: 6 }, (_, i) => row(`old${i}`, { pts: 40 }))];
  const s = hotStreak({ playerId: P, log, teamGames: teamGames(12) }, CFG);
  assert.equal(s.length, 1, "with the old games counted his average would be 24 and 20 would not be hot");
  assert.match(s[0]!.summary, /13\.8/);
});

test("hot streak: exactly at the margin passes; one point under fails", () => {
  const cfg = { ...CFG, storyBaselineMinGames: 6 };
  const exact = hotStreak({ playerId: P, log: logOf(pts(12, 12, 12, 8, 8, 8)), teamGames: teamGames(12) }, cfg);
  assert.equal(exact.length, 1);
  assert.equal(exact[0]!.score, 20, "exactly +20% scores 20, not 19 (float rounding)");
  assert.match(exact[0]!.summary, /\(\+20%\)/);
  assert.equal(hotStreak({ playerId: P, log: logOf(pts(12, 12, 12, 9, 8, 8)), teamGames: teamGames(12) }, cfg).length, 0);
});

test("hot streak: a game exactly at his average stays in the run (at or above, not strictly above)", () => {
  // 14, 14, 10, then 8, 7, 7: his average is exactly 10, and the third game equals it
  const s = hotStreak({ playerId: P, log: logOf(pts(14, 14, 10, 8, 7, 7)), teamGames: teamGames(12) }, { ...CFG, storyBaselineMinGames: 6 });
  assert.equal(s.length, 1);
  assert.match(s[0]!.summary, /last 3 games/);
});

test("hot streak: not enough games to know his average means no story", () => {
  assert.deepEqual(hotStreak({ playerId: P, log: logOf(pts(30, 30, 30, 5)), teamGames: teamGames(12) }, CFG), []);
});

test("hot streak: a tiny average is not a streak (1 three-pointer after 0.2 a game)", () => {
  const lines: Line[] = [{ fg3m: 1 }, { fg3m: 1 }, { fg3m: 1 }, { fg3m: 0 }, { fg3m: 0 }, { fg3m: 0 }, { fg3m: 0 }, { fg3m: 0 }, { fg3m: 0 }];
  assert.deepEqual(hotStreak({ playerId: P, log: logOf(lines), teamGames: teamGames(12) }, CFG), []);
});

test("hot streak: when none of his games are on the team's schedule (ids don't line up), there is no story", () => {
  const log = Array.from({ length: 8 }, (_, i) => row(`x${i}`, { pts: i < 3 ? 30 : 10 }));
  assert.deepEqual(hotStreak({ playerId: P, log, teamGames: teamGames(12) }, CFG), []);
});

test("hot streak: each hot stat is its own story", () => {
  const lines: Line[] = [{ pts: 30, reb: 12 }, { pts: 30, reb: 12 }, { pts: 30, reb: 12 }, ...Array.from({ length: 5 }, () => ({ pts: 10, reb: 4 }))];
  const s = hotStreak({ playerId: P, log: logOf(lines), teamGames: teamGames(12) }, CFG);
  assert.deepEqual(s.map((x) => x.stat).sort(), ["pts", "reb"]);
});

test("hot streak: a longer run is reported at its full length", () => {
  const s = hotStreak({ playerId: P, log: logOf(pts(20, 20, 20, 20, 20, 8, 8, 8, 8, 8)), teamGames: teamGames(12) }, CFG);
  assert.match(s[0]!.summary, /last 5 games/);
});

// ---------------------------------------------------------------- back from injury

const EVIDENCE = [{ subject: { kind: "team", id: TEAM } as const, key: "injury:555" }];
const back = (over: Partial<Parameters<typeof backFromInjury>[0]> = {}) => backFromInjury({
  playerId: P, teamId: TEAM, log: logOf(pts(...Array(8).fill(20)), [0, 1, 2, 3]), teamGames: teamGames(12),
  tonight: null, injuryEvidence: EVIDENCE, ...over,
}, CFG);

test("back from injury: missed his team's last four games, was listed hurt, and isn't out tonight", () => {
  const s = back();
  assert.deepEqual([...new Set(s.map((x) => x.stat))], ["pts"], "only the stats that clear the floor");
  assert.equal(s[0]!.angle, ANGLES.backFromInjury);
  assert.equal(s[0]!.score, 64, "base 60 + 4 missed games");
  assert.deepEqual(s[0]!.basis.slice(0, 1), EVIDENCE, "cites the injury fact first");
  assert.ok(s[0]!.basis.some((b) => b.key === "form:pts"));
  assert.match(s[0]!.summary, /missed .*4/);
});

test("back from injury: missing fewer games than the minimum is not a return", () => {
  assert.deepEqual(back({ log: logOf(pts(...Array(8).fill(20)), [0, 1]) }), []);
});

test("back from injury: still Out, Doubtful or unrecognised tonight is not a return", () => {
  for (const st of ["Out", "Doubtful", "Suspension"]) assert.deepEqual(back({ tonight: parseInjuryStatus(st) }), [], st);
});

test("back from injury: listed Day-To-Day or Questionable tonight is still a return", () => {
  for (const st of ["Day-To-Day", "Questionable", "Probable"]) assert.ok(back({ tonight: parseInjuryStatus(st) }).length > 0, st);
});

test("back from injury: no injury fact behind the absence means no story (a coach's DNP is not an injury)", () => {
  assert.deepEqual(back({ injuryEvidence: [] }), []);
});

test("back from injury: a player whose games are all with a former team can't be called back from anything", () => {
  const log = Array.from({ length: 8 }, (_, i) => row(`old${i}`, { pts: 20 }));
  assert.deepEqual(back({ log }), [], "just traded: we can't tell absence from arrival");
});

test("back from injury: a 0-minute row counts as missing the game", () => {
  const lines: Line[] = [...Array(4).fill({ pts: 0, min: 0 }), ...pts(...Array(8).fill(20))];
  assert.ok(back({ log: logOf(lines) }).length > 0);
});

test("back from injury: a three-minute cameo counts as playing, so it ends the absence", () => {
  const lines: Line[] = [{ pts: 2, min: 3 }, ...pts(...Array(8).fill(20))];
  const log = logOf(lines, [0, 1, 2]);   // cameo in the 4th newest game; three missed after it
  assert.equal(back({ log })[0]!.score, 63, "three games missed (60 + 3), not four: the cameo is where the absence ended");
});

test("back from injury: no stat clears the floor means no story to attach a market to", () => {
  assert.deepEqual(back({ log: logOf(pts(...Array(8).fill(0)), [0, 1, 2, 3]) }), []);
});

// ---------------------------------------------------------------- backup stepping in

const star = (over: Record<string, unknown> = {}) => ({
  espnId: "999", name: "Star Man", teamId: TEAM, tonight: parseInjuryStatus("Out"),
  log: logOf(Array.from({ length: 10 }, () => ({ pts: 25, min: 34 }))), teamGames: teamGames(12), ...over,
});
const bench = (lines: Line[] = Array.from({ length: 8 }, () => ({ pts: 8, min: 14 }))) => ({ playerId: P, teamId: TEAM, log: logOf(lines), teamGames: teamGames(12), tonight: null });

test("backup stepping in: a 34-minute teammate is out and a 14-minute player is not", () => {
  const s = backupStepsIn(bench(), [star()], CFG);
  assert.equal(s.length, 1);
  assert.deepEqual([s[0]!.angle, s[0]!.stat, s[0]!.score], [ANGLES.backupStepsIn, "pts", 34]);
  assert.deepEqual(s[0]!.basis[0], { subject: { kind: "team", id: TEAM }, key: "injury:999" });
  assert.ok(s[0]!.basis.some((b) => b.key === "form:pts"));
  assert.match(s[0]!.summary, /Star Man.*Out/);
});

test("backup stepping in: a starter is not a backup", () => {
  assert.deepEqual(backupStepsIn(bench(Array.from({ length: 8 }, () => ({ pts: 15, min: 30 }))), [star()], CFG), []);
});

test("backup stepping in: a teammate who barely plays being out frees nothing", () => {
  assert.deepEqual(backupStepsIn(bench(), [star({ log: logOf(Array.from({ length: 10 }, () => ({ pts: 4, min: 15 }))) })], CFG), []);
});

test("backup stepping in: only a status ESPN named in words we know can make a teammate 'out'", () => {
  for (const st of ["Suspension", "Questionable", "Day-To-Day", "Probable"]) {
    assert.deepEqual(backupStepsIn(bench(), [star({ tonight: parseInjuryStatus(st) })], CFG), [], st);
  }
  assert.equal(backupStepsIn(bench(), [star({ tonight: parseInjuryStatus("Doubtful") })], CFG).length, 1);
  assert.match(backupStepsIn(bench(), [star({ tonight: parseInjuryStatus("Doubtful") })], CFG)[0]!.summary, /Doubtful/);
});

test("backup stepping in: no story if the backup is out himself", () => {
  assert.deepEqual(backupStepsIn({ ...bench(), tonight: parseInjuryStatus("Out") }, [star()], CFG), []);
  assert.deepEqual(backupStepsIn({ ...bench(), tonight: parseInjuryStatus("Suspension") }, [star()], CFG), []);
});

test("backup stepping in: a teammate with too few games has no average minutes, so no story", () => {
  assert.deepEqual(backupStepsIn(bench(), [star({ log: logOf(Array.from({ length: 3 }, () => ({ pts: 25, min: 34 }))) })], CFG), []);
});

test("backup stepping in: two stars out add up, up to the cap", () => {
  const s = backupStepsIn(bench(), [star(), star({ espnId: "888", name: "Other Star", log: logOf(Array.from({ length: 10 }, () => ({ pts: 20, min: 36 }))) })], CFG);
  assert.equal(s[0]!.score, 70);
  assert.equal(s[0]!.basis.filter((b) => b.key.startsWith("injury:")).length, 2);
  assert.equal(backupStepsIn(bench(), [star(), star({ espnId: "888", name: "Other" })], { ...CFG, storyScoreMax: 50 })[0]!.score, 50);
});

test("backup stepping in: a teammate listed on another team can't be this player's teammate", () => {
  assert.deepEqual(backupStepsIn(bench(), [star({ teamId: 99 })], CFG), []);
});

test("backup stepping in: a star who has been out for weeks is not news tonight", () => {
  const long = star({ log: logOf(Array.from({ length: 10 }, () => ({ pts: 25, min: 34 })), [0, 1, 2]) });   // missed the last 3 team games
  assert.deepEqual(backupStepsIn(bench(), [long], CFG), [], "last played 4 team games ago, outside the recent window of 3");
  const fresh = star({ log: logOf(Array.from({ length: 10 }, () => ({ pts: 25, min: 34 })), [0, 1]) });    // missed 2, so he played 3 games ago
  assert.equal(backupStepsIn(bench(), [fresh], CFG).length, 1, "out only the last 2 games: still news");
  assert.equal(backupStepsIn(bench(), [long], { ...CFG, storyBackupOutRecentGames: 4 }).length, 1, "the window is a setting");
});

test("backup stepping in: a log that doesn't line up with the schedule gives no story", () => {
  const off = Array.from({ length: 8 }, (_, i) => row(`x${i}`, { pts: 8, min: 14 }));
  assert.deepEqual(backupStepsIn({ ...bench(), log: off }, [star()], CFG), []);
});

// ---------------------------------------------------------------- ordering

test("stories sort by score, then a fixed tie-break, so the same day always gives the same order", () => {
  const c = (playerId: string, angle: string, stat: StoryCandidate["stat"], score: number): StoryCandidate => ({ playerId, angle, stat, score, summary: "", basis: [] });
  const input = [c("b", "hot_streak", "pts", 50), c("a", "hot_streak", "reb", 50), c("a", "hot_streak", "pts", 50), c("z", "back_from_injury", "pts", 90)];
  const out = sortStories(input).map((x: StoryCandidate) => `${x.score}/${x.playerId}/${x.stat}`);
  assert.deepEqual(out, ["90/z/pts", "50/a/pts", "50/a/reb", "50/b/pts"]);
  assert.deepEqual(sortStories([...input].reverse()).map((x) => `${x.score}/${x.playerId}/${x.stat}`), out);
  assert.equal(input[0]!.playerId, "b", "doesn't reorder the caller's array");
});
