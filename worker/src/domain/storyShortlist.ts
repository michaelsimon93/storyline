// The pure rules of the story step (STO-76, ADR-024 steps 2-3): drop stories about players who won't play tonight, match
// each story to a market, and build the shortlist with a quota per angle. No network, no database, no clock; every
// number comes in (ADR-018).
//
// Why a quota and not one ranking: the angles' scores are on different scales (a hot streak's percent lift, a return's
// base plus games missed, a backup's minutes freed), so sorting them together lets one angle crowd out the rest (STO-103).
// We don't normalise them. Each angle is ranked by its own score; the Claude ranker (STO-11) does the ranking across angles.

import { isWontPlay, type InjuryStatus } from "./injuryStatus.js";
import { sortStories, type StatKey, type StoryCandidate } from "./storyDetectors.js";
import type { SlotKind } from "./shortlist.js";

/** The detector's stat key → the stat name on `markets.stat` (kalshiParse's PLAYER_PROP_SERIES). */
export const MARKET_STAT: Record<StatKey, string> = { pts: "points", reb: "rebounds", ast: "assists", "3pm": "threes" };

// ---------------------------------------------------------------- STO-102: plays tonight

/**
 * Drops every story whose player won't play tonight (Out, Doubtful, or a status we can't name), whatever the angle.
 * Done once here, on the stories, not inside each detector, so the rule lives in one place. `tonight` is the player's
 * status from today's injuries feed (null = healthy). A player missing from it is dropped: we don't know, so we don't say.
 */
export function dropNotPlaying<T extends { playerId: string }>(
  stories: T[], tonight: ReadonlyMap<string, InjuryStatus | null>,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [], dropped: T[] = [];
  for (const s of stories) (tonight.has(s.playerId) && !isWontPlay(tonight.get(s.playerId)) ? kept : dropped).push(s);
  return { kept, dropped };
}

// ---------------------------------------------------------------- matching to a market

export interface MarketRow {
  id: string; playerId: string; gameId: string;
  /** markets.stat: 'points', 'rebounds', ... */
  stat: string; strike: number;
  yesBidCents: number | null; yesAskCents: number | null;
}
export interface MarketRules { bandMin: number; bandMax: number; maxSpreadCents: number }

/**
 * An open market on the story's player and stat whose Yes price is in the band and whose spread is within the limit
 * (spec §3 step 3). Of several, the one closest to a coin flip, then the lower strike, then the lower id, so a re-run picks
 * the same one. The Yes price is the ask (what a user pays to take Yes). A market with no bid, no ask, or a bid above the
 * ask is not matchable. The caller passes only open markets of games that haven't started.
 */
export function pickMarket(story: { playerId: string; stat: StatKey }, markets: MarketRow[], rules: MarketRules): MarketRow | undefined {
  const stat = MARKET_STAT[story.stat];
  const ok = markets.filter((m) => {
    if (m.playerId !== story.playerId || m.stat !== stat) return false;
    if (m.yesBidCents === null || m.yesAskCents === null || m.yesBidCents > m.yesAskCents) return false;
    return m.yesAskCents >= rules.bandMin && m.yesAskCents <= rules.bandMax && m.yesAskCents - m.yesBidCents <= rules.maxSpreadCents;
  });
  const flip = (m: MarketRow) => Math.abs(m.yesAskCents! - 50);
  return ok.sort((a, b) => flip(a) - flip(b) || a.strike - b.strike || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

// ---------------------------------------------------------------- STO-103: the quota

/** A story with a market and the signals behind it: what can go on the shortlist. */
export interface Matched extends StoryCandidate {
  teamId: number; gameId: string; marketId: string;
  /** The stored signals the story rests on, by signals.id. */
  signalIds: number[];
}
export interface ShortlistPick extends Matched { position: number; slotKind: SlotKind }

/** Each angle's share of the list: floor(size × weight ÷ total weight). All weights 0 = no quotas; everything is filled by score. */
export function quotas(size: number, weights: Readonly<Record<string, number>>): Record<string, number> {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(weights).map(([angle, w]) => [angle, total === 0 ? 0 : Math.floor((size * w) / total)]));
}

/**
 * The shortlist: each angle's best stories up to its quota, ranked by that angle's own score; then the slots nobody used
 * (rounding, or an angle with too few stories) go to the highest scores left, whatever the angle. A player appears once per
 * angle, with his best stat, so one hot player can't fill an angle's quota with his points, rebounds and assists.
 * Positions run 1..n: quota stories first in the order of `weights`, then fills. It is a stable display order, not a ranking
 * across angles. The same stories always give the same list.
 */
export function buildShortlist(stories: Matched[], size: number, weights: Readonly<Record<string, number>>): ShortlistPick[] {
  const best = new Map<string, Matched>();   // one per (player, angle): the best-scoring stat
  for (const s of sortStories(stories)) if (!best.has(`${s.playerId}|${s.angle}`)) best.set(`${s.playerId}|${s.angle}`, s);
  const pool = sortStories([...best.values()]);

  const picked = new Set<Matched>();
  const out: { s: Matched; slotKind: SlotKind }[] = [];
  const share = quotas(size, weights);
  for (const angle of Object.keys(weights)) {
    for (const s of pool.filter((x) => x.angle === angle).slice(0, share[angle]!)) { picked.add(s); out.push({ s, slotKind: "quota" }); }
  }
  for (const s of pool) {
    if (out.length >= size) break;
    if (!picked.has(s)) out.push({ s, slotKind: "fill" });
  }
  return out.map(({ s, slotKind }, i) => ({ ...s, position: i + 1, slotKind }));
}
