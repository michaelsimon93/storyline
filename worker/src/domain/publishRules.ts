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
export interface LiveMarket { status: string; yesAskCents: number | null; gameId: string; playerId: string | null }

export type SkipReason = "blurb_invalid" | "market_closed" | "out_of_band" | "wrong_market" | "game_started" | "player_repeat";
export interface Skip { storyId: string; reason: SkipReason; detail: string }

/** Why this card can't go live, or undefined if it can. */
export function whyNotPublishable(
  blurb: CardBlurb, story: { gameId: string; playerId: string }, market: LiveMarket | undefined, gameStarted: boolean, rules: PublishRules,
): Skip | undefined {
  const skip = (reason: SkipReason, detail: string): Skip => ({ storyId: blurb.storyId, reason, detail });
  const text = blurb.blurb;
  if (text.trim() === "" || [...text].length > rules.maxChars) return skip("blurb_invalid", `blurb is empty or over ${rules.maxChars} characters`);
  // ADR-024: an unreviewed post never reaches a card; an approved one is shown with its source, so it must have a link and be named.
  for (const g of blurb.facts.signals) {
    if (g.trust === "unreviewed") return skip("blurb_invalid", `cites signal ${g.id}, which is unreviewed`);
    if (g.trust === "attributed") {
      const account = g.url ? /^https?:\/\/[^/]+\/([^/?#]+)/u.exec(g.url)?.[1] : undefined;
      if (!account) return skip("blurb_invalid", `cites signal ${g.id}, an attributed post with no link`);
      if (!text.toLowerCase().includes(account.toLowerCase())) return skip("blurb_invalid", `cites signal ${g.id} without naming @${account}`);
    }
  }
  if (!market) return skip("wrong_market", "the picked market no longer exists");
  if (market.gameId !== story.gameId || market.playerId !== story.playerId) return skip("wrong_market", "the picked market is not this player's in this game");
  if (market.status !== "open") return skip("market_closed", `market is ${market.status}`);
  if (market.yesAskCents === null || market.yesAskCents < rules.bandMin || market.yesAskCents > rules.bandMax) {
    return skip("out_of_band", `yes price is ${market.yesAskCents ?? "missing"}c, band ${rules.bandMin}-${rules.bandMax}c`);
  }
  if (gameStarted) return skip("game_started", "the game has already started");
  return undefined;
}
