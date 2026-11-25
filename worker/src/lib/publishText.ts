// The #testing post for a publish (STO-12, STO-67): one embed per published card (player and market, the blurb, Yes %, No %,
// payout per $1, tip-off in ET), batched up to 10 per message under a header line naming the slate day. Also a "Short: 3 of 5"
// flag when the deck is under size (STO-116) and what was left out and why.
//
// `postCards` takes any list of cards plus the slate date, not "the deck", so a later mid-day add (STO-137) can reuse it.
// Discord limits (from memory, NOT verified against current docs): 10 embeds per message, 6000 characters across a message's
// embeds, 256 in a title, 4096 in a description, and about 5 requests per 2 seconds per webhook.

import type { PublishSummary, PublishedCard } from "../jobs/publish.js";
import type { TestFeed } from "./testFeed.js";

const MAX_EMBEDS = 10;
const MAX_EMBED_CHARS = 5000;       // under Discord's 6000 total, leaving room for the content line
const MAX_TEXT = 1800;              // a content line; Discord rejects over 2000
const PAUSE_MS = 500;               // 2 messages a second, inside ~5 per 2 seconds

type Embed = { title: string; description: string; fields: { name: string; value: string; inline: boolean }[]; footer: { text: string } };
export interface DeckMessage { content: string; embeds: Embed[] }

/** "2026-11-25" → "Wed, Nov 25" (the slate date, not a clock time, so no time zone shift). */
export function slateLabel(slateDate: string): string {
  return new Date(`${slateDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

const tipOffEt = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";

/** What a $1 pick at `cents` pays if it wins: round(100 × 100 ÷ price) cents, the one rounding rule (design.md §4). */
const payoutPerDollar = (cents: number | null) => (cents ? `$${(Math.round(10000 / cents) / 100).toFixed(2)}` : "n/a");

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const size = (e: Embed) => e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((a, f) => a + f.name.length + f.value.length, 0);

export function cardEmbed(c: PublishedCard, slateDate: string): Embed {
  // A link to an approved post is shown with the card (ADR-024 rule 2), wrapped in <> so Discord doesn't unfurl it.
  const links = c.facts.signals.filter((g) => g.trust === "attributed" && g.url).map((g) => `<${g.url}>`);
  const no = c.noPriceCents;
  return {
    title: clip(`${c.playerName} · ${c.facts.market.stat} ${c.strike}+`, 256),
    description: clip(`${c.blurb}${links.length ? `\nsource: ${links.join(" ")}` : ""}`, 1500),
    fields: [
      { name: "Yes", value: `${c.yesPriceCents}%`, inline: true },
      { name: "No", value: no == null ? "n/a" : `${no}%`, inline: true },
      { name: "Pays per $1", value: `Yes ${payoutPerDollar(c.yesPriceCents)} · No ${payoutPerDollar(no)}`, inline: true },
      { name: "Tip-off", value: tipOffEt(c.tipOffAt), inline: true },
    ],
    footer: { text: `Storylines for ${slateLabel(slateDate)}` },
  };
}

/** Messages for these cards: at most 10 embeds and `MAX_EMBED_CHARS` each, every one headed by the slate day. */
export function cardMessages(cards: PublishedCard[], slateDate: string, note = ""): DeckMessage[] {
  const header = `**Storylines for ${slateLabel(slateDate)}**`;
  const groups: Embed[][] = [];
  let cur: Embed[] = [], chars = 0;
  for (const e of cards.map((c) => cardEmbed(c, slateDate))) {
    if (cur.length && (cur.length >= MAX_EMBEDS || chars + size(e) > MAX_EMBED_CHARS)) { groups.push(cur); cur = []; chars = 0; }
    cur.push(e); chars += size(e);
  }
  if (cur.length) groups.push(cur);
  return groups.map((embeds, i) => ({ content: i === 0 && note ? `${header} · ${note}` : header, embeds }));
}

/** Post these cards to the test feed. Never throws (the feed doesn't); pauses between messages to stay under the rate limit. */
export async function postCards(feed: TestFeed, cards: PublishedCard[], slateDate: string, note = "", pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  const messages = cardMessages(cards, slateDate, note);
  for (const [i, m] of messages.entries()) {
    if (i > 0) await pause(PAUSE_MS);
    await feed.post(m.content, m.embeds);
  }
}

/** The deck as it was published: the cards, the short-set flag, and what was left out. */
export async function postPublish(feed: TestFeed, s: PublishSummary, pause?: (ms: number) => Promise<void>): Promise<void> {
  const n = s.published.length;
  await postCards(feed, s.published, s.slateDate, n < s.asked ? `**Short: ${n} of ${s.asked}**` : "", pause);
  if (s.skipped.length) {
    await feed.post(clip(`Left out (${slateLabel(s.slateDate)}): ${s.skipped.map((k) => `story ${k.storyId} (${k.reason}: ${k.detail})`).join("; ")}`, MAX_TEXT));
  }
}
