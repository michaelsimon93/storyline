// The day's story shortlist: the contract between the story job (STO-76, writes it) and the Claude ranker (STO-11, reads it).
// Table: story_shortlist + story_shortlist_signals (migration 20261123201500). Add fields freely; renaming or removing one
// breaks the ranker, so say so at the top of the PR that does.

import type { StatKey } from "./storyDetectors.js";

/** 'quota': in through its angle's share of the list. 'fill': an unused slot, given out by score across angles. */
export type SlotKind = "quota" | "fill";

export interface ShortlistEntry {
  /** story_shortlist.id. Changes when a re-run replaces the day's list, so don't keep it across runs. */
  id: number;
  /** The pipeline_runs row of the story job run that wrote it. */
  runId: number;
  /** The storyline day (storyline_day()), 'YYYY-MM-DD'. */
  slateDate: string;
  /**
   * 1-based, unique within the day. For display and debugging only. Scores are NOT comparable across angles, so
   * this is not a ranking: ranking across angles is the Claude ranker's job (STO-11).
   */
  position: number;
  playerId: string;
  gameId: string;
  /** Text, not a union: new angles (revenge game, trending) arrive without a type change. Today: hot_streak, back_from_injury, backup_steps_in. */
  angle: string;
  stat: StatKey;
  /** The angle's own scale, 0..story_score_max. Only comparable within one angle. */
  score: number;
  /** One line about the story, for the test feed and for debugging; not a blurb. */
  summary: string;
  /** markets.id of the market it matched: open, in the price band, spread within the limit. The ranker may pick another strike on the same player and stat. */
  marketId: string;
  slotKind: SlotKind;
  /** IDs of the stored signals behind the story (signals.id), which blurbs cite (ADR-014). */
  signalIds: number[];
}
