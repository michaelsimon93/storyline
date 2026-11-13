import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, parseConfig } from "../src/lib/config.js";

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
];
const without = (k: string) => valid.filter((r) => r.key !== k);
const withValue = (k: string, v: unknown) => valid.map((r) => (r.key === k ? { key: k, value: v } : r));

test("parses a complete, valid config into typed fields", () => {
  const c = parseConfig(valid);
  assert.equal(c.cardsPerDay, 10);
  assert.equal(c.pickStakeCents, 500);
  assert.equal(c.curationTimeEt, "10:00");
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
