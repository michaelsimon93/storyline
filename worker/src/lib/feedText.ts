// Test-feed messages (STO-40), built from what a job already returns. Pure, so it's unit-tested.

import type { IngestSummary } from "../jobs/ingest.js";
import type { StorySummary } from "../jobs/stories.js";

// Discord rejects messages over 2000 chars. Lists shrink until the message fits, so every
// count survives; a hard cut is the last resort.
const MAX_CHARS = 1900;
const LIST_CAPS = [8, 4, 2, 0];
const MAX_ITEM_CHARS = 120;

function list(label: string, items: string[], cap: number): string[] {
  if (items.length === 0) return [];
  const clip = (x: string) => (x.length > MAX_ITEM_CHARS ? `${x.slice(0, MAX_ITEM_CHARS)}…` : x);
  const shown = items.slice(0, cap).map((x) => `• ${clip(x)}`);
  if (items.length > cap) shown.push(`• …and ${items.length - cap} more`);
  return [`**${label} (${items.length})**`, ...shown];
}

/** "KXNBAPTS" → "PTS", "KXNBAGAME" → "GAME". */
const seriesLabel = (series: string) => series.replace(/^KXNBA/, "");

export function ingestSummaryText(s: IngestSummary): string {
  const head = `📥 **Ingest · slate ${s.slateDate}**`;
  if (s.games === 0 && s.skippedGames.length === 0) return `${head}\nNo games on this slate.`;

  const p = s.players;
  const totalMarkets = Object.values(s.markets).reduce((a, b) => a + b, 0);
  const bySeries = Object.entries(s.markets).map(([k, n]) => `${seriesLabel(k)} ${n}`).join(" · ");
  const render = (cap: number) => [
    head,
    `Games: ${s.games} · Markets: ${totalMarkets} (${bySeries}) · Price snapshots: ${s.snapshots}`,
    `Players: ${p.exact + p.fuzzy}/${p.total} matched (${p.exact} exact, ${p.fuzzy} fuzzy) · ` +
      `${p.unmatched.length} unmatched · ${p.ambiguous.length} ambiguous`,
    ...list("Unmatched", p.unmatched, cap),
    ...list("Ambiguous (left unmatched)", p.ambiguous, cap),
    ...list("Kalshi re-issued player ids", p.reissued, cap),
    ...list("Skipped games", s.skippedGames, cap),
    ...list("Skipped markets", s.skipped, cap),
    ...list("Out / doubtful", s.outOrDoubtful, cap),
    ...list("Unknown injury status (treated as out)", s.unknownInjuryStatus, cap),
  ].join("\n");
  const text = LIST_CAPS.map(render).find((t) => t.length <= MAX_CHARS) ?? render(0);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}… (truncated)` : text;
}

/**
 * The story step's #testing messages (STO-76, STO-103): the counts that show where stories went, the split per angle (so the
 * quota can be checked by eye), then every shortlisted story with its angle next to its score. One message can't hold 50 lines
 * under Discord's limit, so the list continues in more messages; each is posted whole.
 */
export function storySummaryMessages(s: StorySummary): string[] {
  const head = `📖 **Stories · slate ${s.slateDate}**`;
  const angles = Object.keys({ ...s.foundByAngle, ...s.byAngle }).sort();
  const split = angles.map((a) => {
    const b = s.byAngle[a] ?? { matched: 0, quota: 0, fill: 0 };
    return `${a}: ${b.quota + b.fill} on the list (${b.quota} quota + ${b.fill} fill) of ${b.matched} matched, ${s.foundByAngle[a] ?? 0} found`;
  });
  const first = [
    head,
    `Found ${s.found} · not playing tonight ${s.notPlaying} · no stored signals ${s.noSignals} · no market ${s.noMarket} · matched ${s.matched} · **shortlisted ${s.shortlisted}**`,
    ...(split.length ? ["**Split by angle**", ...split.map((x) => `• ${x}`)] : []),
    ...list("No market", s.noMarketSamples, 4).slice(0, 6),
    ...(s.inputs.playersWithoutInputs ? [`${s.inputs.playersWithoutInputs} players had no game log or schedule from ESPN, so no story about them`] : []),
    ...(s.found === 0 ? ["No stories found today."] : []),
  ].join("\n");

  const lines = s.shortlist.map((k) => `${k.position}. ${k.angle} · ${k.score} · ${k.player} ${k.stat.toUpperCase()} (${k.slotKind})`);
  const msgs = [first.length > MAX_CHARS ? `${first.slice(0, MAX_CHARS)}… (truncated)` : first];
  let cur: string[] = [];
  const flush = () => { if (cur.length) msgs.push([`**Shortlist, angle · score** (${msgs.length})`, ...cur].join("\n")); cur = []; };
  for (const l of lines) {
    if ([...cur, l].join("\n").length > MAX_CHARS - 80) flush();
    cur.push(l.length > MAX_ITEM_CHARS ? `${l.slice(0, MAX_ITEM_CHARS)}…` : l);
  }
  flush();
  return msgs;
}
