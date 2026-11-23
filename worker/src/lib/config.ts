// Typed access to app_config and feature flags (ADR-018).
// The database is the single source of truth and validates every write, so there
// are deliberately NO default values here: a missing or mistyped setting is a bug
// to surface loudly, not paper over with a second copy of the value.

import type { Db } from "./db.js";

const SPEC = {
  cardsPerDay:             { key: "cards_per_day",             type: "int" },
  forYouCards:             { key: "for_you_cards",             type: "int" },
  priceBandMin:            { key: "price_band_min",            type: "int" },
  priceBandMax:            { key: "price_band_max",            type: "int" },
  maxSpreadCents:          { key: "max_spread_cents",          type: "int" },
  pickStakeCents:          { key: "pick_stake_cents",          type: "int" },
  signupGrantCents:        { key: "signup_grant_cents",        type: "int" },
  dailyGrantCents:         { key: "daily_grant_cents",         type: "int" },
  snapshotIntervalMinutes: { key: "snapshot_interval_minutes", type: "int" },
  maxPriceAgeSeconds:      { key: "max_price_age_seconds",     type: "int" },
  curationTimeEt:          { key: "curation_time_et",          type: "string" },
  ingestScheduleEt:        { key: "ingest_schedule_et",        type: "string" },
  pollerIntervalSeconds:   { key: "poller_interval_seconds",   type: "int" },
  espnFormWindowGames:     { key: "espn_form_window_games",     type: "int" },
  espnPauseMs:             { key: "espn_pause_ms",              type: "int" },
  espnMaxConsecutiveFailures: { key: "espn_max_consecutive_failures", type: "int" },
  espnDegradedFailedPlayers:  { key: "espn_degraded_failed_players",  type: "int" },
  espnFallbackMaxAgeDays:  { key: "espn_fallback_max_age_days", type: "int" },
  contextEspnScheduleEt:   { key: "context_espn_schedule_et",   type: "string" },
} as const;

// The story detectors' settings (STO-76). Deliberately NOT in SPEC: SPEC is read at startup by every job, so one missing
// key there stops the whole worker (it did, on Nov 18: the worker deployed before the migration). These load through
// loadStoryConfig, called only by the story step, so a missing one stops only that step, and loudly. New jobs' settings
// belong in their own loader like this one, not in SPEC (STO-106).
const STORY_SPEC = {
  storyMinMinutes:           { key: "story_min_minutes",              type: "int" },
  storyBaselineMinGames:     { key: "story_baseline_min_games",       type: "int" },
  storyHotStreakMinGames:    { key: "story_hot_streak_min_games",     type: "int" },
  storyHotStreakMarginPct:   { key: "story_hot_streak_margin_pct",    type: "int" },
  storyMinStatAvgTenths:     { key: "story_min_stat_avg_tenths",      type: "int" },
  storyReturnMinMissedGames: { key: "story_return_min_missed_games",  type: "int" },
  storyBackupMaxMin:         { key: "story_backup_max_min",           type: "int" },
  storyBackupOutMinMinutes:  { key: "story_backup_out_min_minutes",   type: "int" },
  storyBackupOutRecentGames: { key: "story_backup_out_recent_games",  type: "int" },
  storyScoreMax:             { key: "story_score_max",                type: "int" },
  storyScoreReturn:          { key: "story_score_return",             type: "int" },
  // The shortlist (STO-76/STO-103): its size, and each angle's weight in the split. A new angle adds a row in its own migration.
  shortlistSize:                  { key: "shortlist_size",                    type: "int" },
  shortlistSplitHotStreak:        { key: "shortlist_split_hot_streak",        type: "int" },
  shortlistSplitBackFromInjury:   { key: "shortlist_split_back_from_injury",  type: "int" },
  shortlistSplitBackupStepsIn:    { key: "shortlist_split_backup_steps_in",   type: "int" },
} as const;

type SpecShape = Record<string, { key: string; type: "int" | "string" }>;
type Typed<S extends SpecShape> = { [K in keyof S]: S[K]["type"] extends "int" ? number : string };

export type Config = Typed<typeof SPEC>;
export type StoryConfig = Typed<typeof STORY_SPEC>;

export class ConfigError extends Error {
  /** One entry per bad setting, e.g. `missing story_score_max`, so an alert can name each key without parsing the message. */
  constructor(message: string, readonly problems: string[] = []) { super(message); this.name = "ConfigError"; }
}

/** Pure: turn app_config rows into a typed config for one spec, collecting every problem at once. */
function parseSpec<S extends SpecShape>(spec: S, rows: { key: string; value: unknown }[]): Typed<S> {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const problems: string[] = [];
  const out: Record<string, unknown> = {};

  for (const [name, { key, type }] of Object.entries(spec)) {
    if (!byKey.has(key)) { problems.push(`missing ${key}`); continue; }
    const v = byKey.get(key);
    const ok = type === "int" ? Number.isInteger(v) : typeof v === "string";
    if (!ok) { problems.push(`${key} should be ${type}, got ${JSON.stringify(v)}`); continue; }
    out[name] = v;
  }

  // Range and cross-setting rules (e.g. price band min < max) are enforced by the
  // database on write, so they are not re-implemented here (single source, ADR-018).

  if (problems.length) throw new ConfigError(`Invalid app_config: ${problems.join("; ")}`, problems);
  return out as Typed<S>;
}

/** The startup config every job reads. */
export const parseConfig = (rows: { key: string; value: unknown }[]): Config => parseSpec(SPEC, rows);
/** The story detectors' settings, read only by the story step. */
export const parseStoryConfig = (rows: { key: string; value: unknown }[]): StoryConfig => parseSpec(STORY_SPEC, rows);

export async function loadConfig(db: Db): Promise<Config> {
  const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from app_config`);
  return parseConfig(rows);
}

export async function loadStoryConfig(db: Db): Promise<StoryConfig> {
  const keys = Object.values(STORY_SPEC).map((s) => s.key);
  const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from app_config where key = any($1::text[])`, [keys]);
  return parseStoryConfig(rows);
}

/** Server-side flag check for a specific user (the app uses my_flags() instead). */
export async function flagEnabled(db: Db, key: string, userId: string | null): Promise<boolean> {
  const { rows } = await db.query<{ on: boolean }>(`select flag_enabled($1, $2) as on`, [key, userId]);
  return rows[0]?.on ?? false;
}

/**
 * Is a feature flag's master switch on? For worker jobs, which have no user: flag_enabled() needs
 * a user (allowlist or rollout bucket), so it is always false for null. A missing flag is off.
 */
export async function flagOn(db: Db, key: string): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>(`select enabled from feature_flags where key = $1`, [key]);
  return rows[0]?.enabled ?? false;
}
