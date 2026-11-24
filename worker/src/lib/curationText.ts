// The #testing post for a curation run (STO-11, STO-77): the picks, their reasons, each card's blurb with the signal ids it cites,
// and the story-type mix, so Michael can see whether one type dominates and how the blurbs read. Pure text; the job posts it
// through the test feed.

import type { CurationInput, Selection } from "../domain/curationRules.js";
import type { CardBlurb } from "../domain/blurbRules.js";
import type { TestFeed } from "./testFeed.js";

// Discord rejects messages over 2000 characters; stay under it and split on line boundaries.
const MAX_CHARS = 1800;

const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
};

/** `shown` is the stories the curator saw (after narrowing). Lines are kept whole; a long reason is truncated, not the pick. */
export function curationPostChunks(shown: CurationInput, sel: Selection, attemptsUsed: number, asked?: number, blurbs: CardBlurb[] = []): string[] {
  const blurbOf = new Map(blurbs.map((b) => [b.storyId, b]));
  const byId = new Map(shown.stories.map((s) => [s.storyId, s]));
  const lines = [`**Curation ${shown.slateDate}**: ${sel.picks.length} cards from ${shown.stories.length} stories (attempt ${attemptsUsed})` +
    (asked !== undefined && asked !== sel.picks.length ? `. **Short deck: asked for ${asked}**, the game and stat caps and the players available allow ${sel.picks.length}` : "")];
  sel.picks.forEach((p, i) => {
    const s = byId.get(p.storyId);
    const rung = s?.ladder.find((l) => l.marketId === p.marketId);
    const reason = p.reason.length > 220 ? `${p.reason.slice(0, 219)}…` : p.reason;
    const b = blurbOf.get(p.storyId);
    // The blurb is quoted as written (it is at most 200 characters). Cited ids: "own" and "same player, other angle" ones are told apart.
    const blurb = b ? `\n   > ${b.blurb}\n   cites ${b.facts.signals.map((g) => g.via === "own" ? `${g.id}` : `${g.id} (same player, other angle)`).join(", ") || "nothing (market only)"} · ${b.facts.level}` : "";
    lines.push(`${i + 1}. **${s?.playerName ?? p.storyId}** ${s?.stat ?? "?"} ${rung ? `${rung.strike}+ at ${rung.yesPriceCents}c` : "?"} · \`${s?.angle ?? "?"}\`\n   ${reason}${blurb}`);
  });
  const picked = sel.picks.map((p) => byId.get(p.storyId)?.angle ?? "?");
  lines.push(`Story types picked: ${tally(picked)}. On the shortlist: ${tally(shown.stories.map((s) => s.angle))}.`);
  if (blurbs.length) lines.push(`Blurbs: ${tally(blurbs.map((b) => b.facts.level))}.`);

  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > MAX_CHARS) { chunks.push(cur); cur = line; }
    else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Post the chunks in order. The feed never throws, so a failed post can't fail curation. */
export async function postCuration(feed: TestFeed, shown: CurationInput, sel: Selection, attemptsUsed: number, asked?: number, blurbs: CardBlurb[] = []): Promise<void> {
  for (const c of curationPostChunks(shown, sel, attemptsUsed, asked, blurbs)) await feed.post(c);
}
