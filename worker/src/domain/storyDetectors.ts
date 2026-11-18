// The ESPN story detectors (ADR-024 rule 4, steps 1-2): turn a player's game log, his team's schedule and tonight's
// injuries into story candidates, each with a rough score. Pure: no network, no database, no clock. Every threshold
// comes in as `StoryConfig` (app_config, ADR-018); there are no defaults here.
//
// How a log is tied to a team (the part that stops mislabelled stories): ESPN's game log has no team per game and
// lists only games a player appeared in. So we walk the TEAM's finished games, newest first, and look each one up
// in the log by event id.
//   - a team game with no row (or 0 minutes) is a game he missed: a DNP ends a streak, and counts toward an absence;
//   - a log row that isn't on the team's schedule is a game for a former team: it counts for nothing, so a trade
//     can't make a streak or hide one;
//   - if NONE of a player's rows are on the schedule (traded and not yet played, or the ids don't line up) there is
//     no story at all. Detectors fail closed.
// Unverified (see the PR): that a game has the same event id in the game-log and schedule endpoints. The recorded
// fixtures are for different teams, so we couldn't check it. If it's wrong, the fail-closed rule means no stories, not wrong ones.
//
// Angles are text, not an enum, so adding one (revenge game STO-93, trending STO-75) needs no migration of this code.

import type { GameLogRow, FinishedGame } from "./espnParse.js";
import { isKnownWontPlay, isWontPlay, type InjuryStatus } from "./injuryStatus.js";
import type { StoryConfig } from "../lib/config.js";
import type { SignalSubject } from "../sources/types.js";

export type StatKey = "pts" | "reb" | "ast" | "3pm";
/** The keys match the `form:<stat>` signals espnSignals writes. */
export const STATS: { key: StatKey; label: string; pick: (r: GameLogRow) => number }[] = [
  { key: "pts", label: "PTS", pick: (r) => r.pts },
  { key: "reb", label: "REB", pick: (r) => r.reb },
  { key: "ast", label: "AST", pick: (r) => r.ast },
  { key: "3pm", label: "3PM", pick: (r) => r.fg3m },
];

export const ANGLES = { hotStreak: "hot_streak", backFromInjury: "back_from_injury", backupStepsIn: "backup_steps_in" } as const;

/** A signal a story rests on, by what identifies it (subject + key). Resolved to a stored signal's ID when stories are saved. */
export interface SignalRef { subject: SignalSubject; key: string }

export interface StoryCandidate {
  playerId: string;
  angle: string;
  stat: StatKey;
  /** Integer, 0..storyScoreMax. Rough: it only orders stories. */
  score: number;
  /** One line for the test feed and for debugging; not a blurb. */
  summary: string;
  basis: SignalRef[];
}

// ---------------------------------------------------------------- the timeline

interface Slot { game: FinishedGame; row: GameLogRow | null }

/**
 * The team's finished games, newest first, each with the player's row if he appeared. Undefined if no row of his is on this team's schedule.
 * Known limit: a game that finished last night and isn't in ESPN's game log yet looks like a DNP. For a streak that fails
 * closed (no story); for an absence it can add one to the missed count.
 */
function timeline(log: GameLogRow[], teamGames: FinishedGame[]): Slot[] | undefined {
  const byEvent = new Map(log.map((r) => [r.eventId, r]));
  const games = [...teamGames].sort((a, b) => (a.date === b.date ? (a.eventId < b.eventId ? 1 : -1) : a.date < b.date ? 1 : -1));
  const slots = games.map((game) => ({ game, row: byEvent.get(game.eventId) ?? null }));
  return slots.some((s) => s.row) ? slots : undefined;
}

const appeared = (s: Slot) => s.row !== null && s.row.min > 0;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg1 = (n: number) => n.toFixed(1);

/** Games he played real minutes in, for his average. */
const validGames = (slots: Slot[], cfg: StoryConfig) => slots.filter((s) => s.row && s.row.min >= cfg.storyMinMinutes).map((s) => s.row!);

const formRef = (playerId: string, stat: StatKey): SignalRef => ({ subject: { kind: "player", id: playerId }, key: `form:${stat}` });

/** Stats he averages enough in for a story about them to mean anything. */
function usableStats(valid: GameLogRow[], cfg: StoryConfig) {
  if (valid.length < cfg.storyBaselineMinGames) return [];
  return STATS.filter((s) => sum(valid.map(s.pick)) * 10 >= cfg.storyMinStatAvgTenths * valid.length);
}

// ---------------------------------------------------------------- hot streak

/** A run of at least `storyHotStreakMinGames` straight team games, each at or above his average, whose average beats it by `storyHotStreakMarginPct`. */
export function hotStreak(p: { playerId: string; log: GameLogRow[]; teamGames: FinishedGame[] }, cfg: StoryConfig): StoryCandidate[] {
  const slots = timeline(p.log, p.teamGames);
  if (!slots) return [];
  const valid = validGames(slots, cfg);
  const out: StoryCandidate[] = [];
  for (const stat of usableStats(valid, cfg)) {
    const vals = valid.map(stat.pick);
    const n = vals.length, total = sum(vals);
    // The run: newest games back until one he missed, barely played, or didn't beat his average.
    const run: number[] = [];
    for (const s of slots) {
      if (!s.row || s.row.min < cfg.storyMinMinutes) break;
      const v = stat.pick(s.row);
      if (v * n < total) break;               // v < his average, in integers
      run.push(v);
    }
    const k = run.length;
    if (k < cfg.storyHotStreakMinGames) continue;
    const runSum = sum(run);
    // runSum/k >= (total/n) * (100+margin)/100, cross-multiplied so the boundary is exact.
    if (runSum * n * 100 < total * k * (100 + cfg.storyHotStreakMarginPct)) continue;
    // Integers all the way: (1.2 - 1) * 100 is 19.999... in floating point, so a streak exactly at the margin would read +19%.
    const liftPct = Math.floor((runSum * n * 100 - total * k * 100) / (total * k));
    out.push({
      playerId: p.playerId, angle: ANGLES.hotStreak, stat: stat.key,
      score: Math.min(cfg.storyScoreMax, liftPct),
      summary: `Hot streak: ${avg1(runSum / k)} ${stat.label} over his last ${k} games, against ${avg1(total / n)} for the season (+${liftPct}%)`,
      basis: [formRef(p.playerId, stat.key)],
    });
  }
  return out;
}

// ---------------------------------------------------------------- back from injury

/**
 * He missed the team's last `storyReturnMinMissedGames`+ games, he was listed hurt (the caller supplies those injury
 * signals; without one there is no story, because a coach's decision is not an injury), and he isn't out tonight.
 * A player whose every game was for another team is not "back" from anything: we can't tell absence from arrival.
 */
export function backFromInjury(
  p: { playerId: string; teamId: number; log: GameLogRow[]; teamGames: FinishedGame[]; tonight: InjuryStatus | null; injuryEvidence: SignalRef[] },
  cfg: StoryConfig,
): StoryCandidate[] {
  if (isWontPlay(p.tonight) || p.injuryEvidence.length === 0) return [];
  const slots = timeline(p.log, p.teamGames);
  if (!slots) return [];
  const lastPlayed = slots.findIndex(appeared);   // newest game he appeared in = how many newer team games he missed
  if (lastPlayed < cfg.storyReturnMinMissedGames) return [];
  return usableStats(validGames(slots, cfg), cfg).map((stat) => ({
    playerId: p.playerId, angle: ANGLES.backFromInjury, stat: stat.key,
    score: Math.min(cfg.storyScoreMax, cfg.storyScoreReturn + lastPlayed),
    summary: `Back from injury: missed his team's last ${lastPlayed} games and isn't listed out tonight`,
    basis: [...p.injuryEvidence, formRef(p.playerId, stat.key)],
  }));
}

// ---------------------------------------------------------------- backup stepping in

export interface OutTeammate {
  espnId: string; name: string; teamId: number;
  tonight: InjuryStatus | null;
  log: GameLogRow[]; teamGames: FinishedGame[];
}

const avgMinutes = (slots: Slot[]) => {
  const played = slots.filter(appeared).map((s) => s.row!.min);
  return { n: played.length, avg: played.length ? sum(played) / played.length : 0 };
};

/**
 * A bench player (average minutes under `storyBackupMaxMin`) whose teammate(s) averaging `storyBackupOutMinMinutes`+
 * are out tonight, having played in the team's last `storyBackupOutRecentGames` games (so it's new). The score is the minutes those teammates leave open. A teammate counts as out only on a status
 * ESPN gave in words we know (Out, Doubtful): an unrecognised one is never turned into a claim.
 */
export function backupStepsIn(
  p: { playerId: string; teamId: number; log: GameLogRow[]; teamGames: FinishedGame[]; tonight: InjuryStatus | null },
  teammates: OutTeammate[],
  cfg: StoryConfig,
): StoryCandidate[] {
  if (isWontPlay(p.tonight)) return [];
  const slots = timeline(p.log, p.teamGames);
  if (!slots) return [];
  const mine = avgMinutes(slots);
  if (mine.n < cfg.storyBaselineMinGames || mine.avg >= cfg.storyBackupMaxMin) return [];

  const outs = teammates.flatMap((t) => {
    if (t.teamId !== p.teamId || !isKnownWontPlay(t.tonight)) return [];   // only a teammate, and only on a status we can name
    const ts = timeline(t.log, t.teamGames);
    // He must have played in one of the team's last few games: a star out for weeks is already in the backup's own numbers, so it isn't news tonight.
    if (!ts || !ts.slice(0, cfg.storyBackupOutRecentGames).some(appeared)) return [];
    const m = avgMinutes(ts);
    return m.n >= cfg.storyBaselineMinGames && m.avg >= cfg.storyBackupOutMinMinutes ? [{ t, avg: m.avg }] : [];
  });
  if (outs.length === 0) return [];

  const freed = Math.round(sum(outs.map((o) => o.avg)));
  const who = outs.map((o) => `${o.t.name} (${o.t.tonight!.raw})`).join(" and ");
  return usableStats(validGames(slots, cfg), cfg).map((stat) => ({
    playerId: p.playerId, angle: ANGLES.backupStepsIn, stat: stat.key,
    score: Math.min(cfg.storyScoreMax, freed),
    summary: `Backup stepping in: ${who} out, about ${freed} minutes open; he averages ${avg1(mine.avg)}`,
    basis: [...outs.map((o): SignalRef => ({ subject: { kind: "team", id: o.t.teamId }, key: `injury:${o.t.espnId}` })), formRef(p.playerId, stat.key)],
  }));
}

// ---------------------------------------------------------------- ordering

/** Highest score first, with a fixed tie-break, so the same day always gives the same order. Returns a new array. */
export function sortStories(stories: StoryCandidate[]): StoryCandidate[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...stories].sort((a, b) => b.score - a.score || cmp(a.angle, b.angle) || cmp(a.playerId, b.playerId) || cmp(a.stat, b.stat));
}
