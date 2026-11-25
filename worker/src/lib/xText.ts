// The #testing post for the X source (STO-75): what the run found, and one line per account it pulled from, so Michael can look
// each one up and reply approved or not. Follower counts are left out on purpose: the search returns none, and they would never
// approve or block anything (decided Nov 25). Pure, so it is unit-tested.

import type { XSummary, ReviewLine } from "../jobs/contextX.js";

const MAX_CHARS = 1900;      // Discord rejects messages over 2000
const MAX_SAMPLE = 110;
const HANDLE = /^[a-z0-9_]{1,15}$/u;

/** The SQL that approves handles. Handles are checked against the same pattern the table enforces, so nothing else can reach the statement. */
export function approveStatement(handles: string[], status: "approved" | "rejected" = "approved"): string {
  const bad = handles.filter((h) => !HANDLE.test(h));
  if (bad.length) throw new Error(`not an X handle: ${bad.join(", ")}`);
  if (handles.length === 0) throw new Error("no handles to update");
  return `update x_accounts set status = '${status}' where handle in (${handles.map((h) => `'${h}'`).join(", ")});`;
}

const clean = (s: string) => s.replace(/[`\r\n]+/gu, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const money = (usd: number) => `$${usd.toFixed(2)}`;

export function accountLine(a: ReviewLine): string {
  const tag = a.status === "unreviewed" ? (a.isNew ? "NEW" : "unreviewed") : a.status;
  return `• \`@${a.handle}\` · ${tag} · <https://x.com/${a.handle}> · cited by ${a.storiesCiting} ${a.storiesCiting === 1 ? "story" : "stories"}\n  "${clip(clean(a.sampleExcerpt), MAX_SAMPLE)}" <${a.sampleUrl}>`;
}

export function xSummaryMessages(s: XSummary): string[] {
  const mode = s.mode === "report_only" ? "**report only**: nothing here reaches a card" : "live";
  const drops = s.dropped.length ? `; dropped ${s.dropped.length} (${[...new Set(s.dropped.map((d) => d.reason))].join(", ")})` : "";
  const head = [
    `🐦 **X · slate ${s.slateDate}** · ${mode}`,
    `${s.storiesKept} stories kept${drops} · ${s.postsKept} posts${s.postsOverCap ? ` (${s.postsOverCap} over the cap, dropped)` : ""} · ${s.signalsStored} signals stored`,
    `Spend: about ${money(s.spend.usdEstimate)} (estimate) · ${s.spend.postsFetched} posts fetched · ${s.spend.searchCalls} searches`,
    ...(s.dropped.length ? [`Dropped: ${s.dropped.slice(0, 5).map((d) => `${clip(clean(d.story), 60)} (${d.reason})`).join("; ")}${s.dropped.length > 5 ? `; …and ${s.dropped.length - 5} more` : ""}`] : []),
  ].join("\n");

  const order = { unreviewed: 0, approved: 1, rejected: 2 } as const;
  const sorted = [...s.accounts].sort((a, b) => order[a.status] - order[b.status] || b.storiesCiting - a.storiesCiting || a.handle.localeCompare(b.handle));
  const todo = sorted.filter((a) => a.status === "unreviewed").map((a) => a.handle);
  const foot = todo.length ? `To approve (edit the list first): \`${approveStatement(todo)}\`` : "";

  const msgs: string[] = [];
  let cur: string[] = [head, `**Accounts pulled from (${sorted.length})**: reply approved or not for each`];
  const flush = () => { if (cur.length) msgs.push(cur.join("\n")); cur = []; };
  for (const a of sorted) {
    const line = accountLine(a);
    if ([...cur, line].join("\n").length > MAX_CHARS) flush();
    cur.push(line);
  }
  if (sorted.length === 0) cur.push("No accounts this run.");
  if (foot) { if ([...cur, foot].join("\n").length > MAX_CHARS) flush(); cur.push(clip(foot, MAX_CHARS)); }
  flush();
  return msgs;
}
