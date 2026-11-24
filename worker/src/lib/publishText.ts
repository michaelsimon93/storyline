// The #testing post for a publish (STO-12): which cards went live, each blurb exactly as a user will see it, the source link for any
// approved X post it leans on, a "Short: 3 of 5" flag when the deck is under size (STO-116), and what was left out and why.

import type { PublishSummary } from "../jobs/publish.js";
import type { TestFeed } from "./testFeed.js";

const MAX_CHARS = 1800;   // Discord rejects over 2000

export function publishPostChunks(s: PublishSummary): string[] {
  const n = s.published.length;
  const lines = [`**Published ${s.slateDate}**: ${n} cards` + (n < s.asked ? `. **Short: ${n} of ${s.asked}**` : "")];
  s.published.forEach((c, i) => {
    // A link to an approved post is shown with the card (ADR-024 rule 2), wrapped in <> so Discord doesn't embed it.
    const links = c.facts.signals.filter((g) => g.trust === "attributed" && g.url).map((g) => `<${g.url}>`);
    lines.push(`${i + 1}. **${c.playerName}** ${c.facts.market.stat} ${c.strike}+ at ${c.yesPriceCents}c\n   > ${c.blurb}${links.length ? `\n   source: ${links.join(" ")}` : ""}`);
  });
  if (s.skipped.length) lines.push(`Left out: ${s.skipped.map((k) => `story ${k.storyId} (${k.reason}: ${k.detail})`).join("; ")}`);
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > MAX_CHARS) { chunks.push(cur); cur = line; }
    else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export async function postPublish(feed: TestFeed, s: PublishSummary): Promise<void> {
  for (const c of publishPostChunks(s)) await feed.post(c);
}
