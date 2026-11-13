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
} as const;

type Spec = typeof SPEC;
export type Config = {
  [K in keyof Spec]: Spec[K]["type"] extends "int" ? number : string;
};

export class ConfigError extends Error {}

/** Pure: turn app_config rows into a typed Config, collecting every problem at once. */
export function parseConfig(rows: { key: string; value: unknown }[]): Config {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const problems: string[] = [];
  const out: Record<string, unknown> = {};

  for (const [name, { key, type }] of Object.entries(SPEC)) {
    if (!byKey.has(key)) { problems.push(`missing ${key}`); continue; }
    const v = byKey.get(key);
    const ok = type === "int" ? Number.isInteger(v) : typeof v === "string";
    if (!ok) { problems.push(`${key} should be ${type}, got ${JSON.stringify(v)}`); continue; }
    out[name] = v;
  }

  // Range and cross-setting rules (e.g. price band min < max) are enforced by the
  // database on write, so they are not re-implemented here (single source, ADR-018).

  if (problems.length) throw new ConfigError(`Invalid app_config: ${problems.join("; ")}`);
  return out as Config;
}

export async function loadConfig(db: Db): Promise<Config> {
  const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from app_config`);
  return parseConfig(rows);
}

/** Server-side flag check for a specific user (the app uses my_flags() instead). */
export async function flagEnabled(db: Db, key: string, userId: string | null): Promise<boolean> {
  const { rows } = await db.query<{ on: boolean }>(`select flag_enabled($1, $2) as on`, [key, userId]);
  return rows[0]?.on ?? false;
}
