// What must still be true of a card at the moment it goes live (STO-12, spec §3 step 7). Pure: no database.
//
// The blurb rules (blurbRules.ts) ran when the blurb was written. Publishing re-checks the cheap, high-stakes ones against what is
// stored, because the stored run output is data like any other: the rules a user could be hurt by (a post nobody approved, a blurb
// over the limit, a line that has drifted out of the band since curation ran) are cheap to repeat here. It does not re-judge
// whether a sentence says what its signal says (ADR-014: not checkable).

import type { CardBlurb } from "./blurbRules.js";

/** Detector angles → cards.storyline_type. Anything unmapped is 'other': a new angle ships without a migration. */
const STORYLINE_TYPE: Record<string, string> = {
  hot_streak: "hot_streak",
  backup_steps_in: "injury_opportunity",
  back_from_injury: "news",
};
export const storylineTypeOf = (angle: string) => STORYLINE_TYPE[angle] ?? "other";

export interface PublishRules { bandMin: number; bandMax: number; maxChars: number }

/** The market as it is right now. */
export interface LiveMarket { status: string; yesAskCents: number | null; gameId: string; playerId: string | null; strike: number }

export type SkipReason = "malformed" | "over_deck_size" | "insert_failed" | "blurb_invalid" | "market_closed" | "out_of_band" | "wrong_market" | "game_started" | "player_repeat";
export interface Skip { storyId: string; reason: SkipReason; detail: string }

/** Why this card can't go live, or undefined if it can. */
export function whyNotPublishable(
  blurb: CardBlurb, story: { gameId: string; playerId: string }, market: LiveMarket | undefined, gameStarted: boolean, rules: PublishRules,
): Skip | undefined {
  const skip = (reason: SkipReason, detail: string): Skip => ({ storyId: blurb.storyId, reason, detail });
  const text = blurb.blurb;
  if (text.trim() === "" || [...text].length > rules.maxChars) return skip("blurb_invalid", `blurb is empty or over ${rules.maxChars} characters`);
  const signals = blurb.facts?.signals;
  if (!Array.isArray(signals)) return skip("blurb_invalid", "facts have no signals list");
  if (blurb.facts.level === "full" && signals.length === 0) return skip("blurb_invalid", "a full blurb cites no signal (ADR-014)");
  // ADR-024: only verified signals, or approved posts shown with their source. Anything else (unreviewed, unknown, missing) never publishes.
  // The account is the first path segment of an x.com / twitter.com link; "i" (x.com/i/status/…) is not an account.
  for (const g of signals) {
    if (g.trust === "verified") continue;
    if (g.trust !== "attributed") return skip("blurb_invalid", `cites signal ${g.id} with trust ${JSON.stringify(g.trust)}; only verified or attributed can publish`);
    const m = g.url ? /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//u.exec(g.url) : null;
    const account = m?.[1];
    if (!account || account.toLowerCase() === "i") return skip("blurb_invalid", `cites signal ${g.id}, an attributed post with no usable link`);
    if (!text.toLowerCase().includes(account.toLowerCase())) return skip("blurb_invalid", `cites signal ${g.id} without naming @${account}`);
  }
  if (!market) return skip("wrong_market", "the picked market no longer exists");
  if (market.gameId !== story.gameId || market.playerId !== story.playerId) return skip("wrong_market", "the picked market is not this player's in this game");
  if (blurb.facts.market?.strike !== market.strike) return skip("wrong_market", `the blurb's facts are about a ${blurb.facts.market?.strike} line, the market is ${market.strike}`);
  if (market.status !== "open") return skip("market_closed", `market is ${market.status}`);
  if (market.yesAskCents === null || market.yesAskCents < rules.bandMin || market.yesAskCents > rules.bandMax) {
    return skip("out_of_band", `yes price is ${market.yesAskCents ?? "missing"}c, band ${rules.bandMin}-${rules.bandMax}c`);
  }
  if (gameStarted) return skip("game_started", "the game has already started");
  return undefined;
}
