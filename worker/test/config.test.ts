import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, parseConfig, parseStoryConfig } from "../src/lib/config.js";

const valid = [
  { key: "cards_per_day", value: 10 },
  { key: "for_you_cards", value: 0 },
  { key: "price_band_min", value: 25 },
  { key: "price_band_max", value: 75 },
  { key: "max_spread_cents", value: 5 },
  { key: "pick_stake_cents", value: 500 },
  { key: "signup_grant_cents", value: 10000 },
  { key: "daily_grant_cents", value: 1000 },
  { key: "snapshot_interval_minutes", value: 15 },
  { key: "max_price_age_seconds", value: 120 },
  { key: "curation_time_et", value: "10:00" },
  { key: "ingest_schedule_et", value: "0 8-22/2 * * *" },
  { key: "poller_interval_seconds", value: 30 },
  { key: "espn_form_window_games", value: 5 },
  { key: "espn_pause_ms", value: 250 },
  { key: "espn_max_consecutive_failures", value: 5 },
  { key: "espn_degraded_failed_players", value: 5 },
  { key: "espn_fallback_max_age_days", value: 1 },
  { key: "context_espn_schedule_et", value: "30 9 * * *" },
];
const without = (k: string) => valid.filter((r) => r.key !== k);
const withValue = (k: string, v: unknown) => valid.map((r) => (r.key === k ? { key: k, value: v } : r));

test("parses a complete, valid config into typed fields", () => {
  const c = parseConfig(valid);
  assert.equal(c.cardsPerDay, 10);
  assert.equal(c.pickStakeCents, 500);
  assert.equal(c.curationTimeEt, "10:00");
});

// ---------------------------------------------------------------- story settings: their own loader (STO-106)

const story = [
  { key: "story_min_minutes", value: 10 }, { key: "story_baseline_min_games", value: 5 },
  { key: "story_hot_streak_min_games", value: 3 }, { key: "story_hot_streak_margin_pct", value: 20 },
  { key: "story_min_stat_avg_tenths", value: 10 }, { key: "story_return_min_missed_games", value: 3 },
  { key: "story_backup_max_min", value: 24 }, { key: "story_backup_out_min_minutes", value: 28 },
  { key: "story_backup_out_recent_games", value: 3 }, { key: "story_score_max", value: 100 }, { key: "story_score_return", value: 60 },
  { key: "shortlist_size", value: 50 }, { key: "shortlist_split_hot_streak", value: 1 },
  { key: "shortlist_split_back_from_injury", value: 1 }, { key: "shortlist_split_backup_steps_in", value: 1 },
];

test("STO-106: the worker's startup config needs no story settings (a missing one must not stop every job)", () => {
  assert.doesNotThrow(() => parseConfig(valid), "boot config with no story_* rows at all");
  assert.equal("storyScoreMax" in parseConfig([...valid, ...story]), false, "story settings are not part of the startup config");
});

test("story settings parse into their own typed config", () => {
  const c = parseStoryConfig(story);
  assert.deepEqual([c.storyHotStreakMinGames, c.storyHotStreakMarginPct, c.storyScoreMax, c.storyBackupOutRecentGames], [3, 20, 100, 3]);
});

test("a missing story setting still fails loudly, naming every missing key (no defaults in code)", () => {
  const rows = story.filter((r) => r.key !== "story_hot_streak_margin_pct" && r.key !== "story_score_max");
  assert.throws(() => parseStoryConfig(rows), (e: unknown) =>
    e instanceof ConfigError && /missing story_hot_streak_margin_pct/.test(e.message) && /missing story_score_max/.test(e.message));
  assert.throws(() => parseStoryConfig([]), (e: unknown) => e instanceof ConfigError && /missing story_min_minutes/.test(e.message));
});

test("ConfigError lists each bad key, so an alert can name them without parsing the message (STO-107)", () => {
  const rows = story.filter((r) => r.key !== "shortlist_size" && r.key !== "story_score_max");
  assert.throws(() => parseStoryConfig(rows), (e: unknown) =>
    e instanceof ConfigError && JSON.stringify(e.problems) === JSON.stringify(["missing story_score_max", "missing shortlist_size"]));
});

test("a mistyped story setting fails loudly", () => {
  assert.throws(() => parseStoryConfig(story.map((r) => (r.key === "story_min_minutes" ? { key: r.key, value: "ten" } : r))),
    (e: unknown) => e instanceof ConfigError && /story_min_minutes should be int/.test(e.message));
});

test("a missing setting fails loudly, naming the key (no silent defaults)", () => {
  assert.throws(() => parseConfig(without("cards_per_day")), (e: unknown) =>
    e instanceof ConfigError && /missing cards_per_day/.test(e.message));
});

test("a wrong type fails loudly", () => {
  assert.throws(() => parseConfig(withValue("cards_per_day", "ten")), /cards_per_day should be int/);
  assert.throws(() => parseConfig(withValue("pick_stake_cents", 4.5)), /pick_stake_cents should be int/);
});

test("reports every problem at once, not just the first", () => {
  const bad = withValue("cards_per_day", "ten").filter((r) => r.key !== "max_spread_cents");
  assert.throws(() => parseConfig(bad), (e: unknown) =>
    e instanceof Error && /cards_per_day/.test(e.message) && /max_spread_cents/.test(e.message));
});

test("the ESPN context settings come through typed", () => {
  const c = parseConfig(valid);
  assert.deepEqual(
    [c.espnFormWindowGames, c.espnPauseMs, c.espnMaxConsecutiveFailures, c.espnDegradedFailedPlayers, c.espnFallbackMaxAgeDays, c.contextEspnScheduleEt],
    [5, 250, 5, 5, 1, "30 9 * * *"]);
  assert.throws(() => parseConfig(without("espn_pause_ms")), /missing espn_pause_ms/);
});
