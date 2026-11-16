// Test-feed messages (STO-40), built from what a job already returns. Pure, so it's unit-tested.

import type { IngestSummary } from "../jobs/ingest.js";

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
  if (s.games === 0) return `${head}\nNo games on this slate.`;

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
    ...list("Skipped markets", s.skipped, cap),
    ...list("Out / doubtful", s.outOrDoubtful, cap),
  ].join("\n");
  const text = LIST_CAPS.map(render).find((t) => t.length <= MAX_CHARS) ?? render(0);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}… (truncated)` : text;
}
