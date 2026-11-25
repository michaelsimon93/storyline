// What Grok's X search says, turned into our signals (STO-75, ADR-024, ADR-014). Pure: no network, no database.
//
// Grok is a source of leads, not facts. Nothing it says is stored unless it is (1) a post with a real X URL, so a claim with no post
// behind it is dropped, and (2) about a player, team or game we can name in our own IDs, so a story we can't resolve is dropped.
// Both drops are counted and listed, never silent. The account handle always comes from the post's URL, not from what Grok wrote
// beside it. A post from an approved account is `attributed`; every other is `unreviewed` (ADR-024 rule 2).

import { normalizeName } from "./names.js";
import type { SignalDraft, SignalSubject } from "../sources/types.js";

export const CHATTER = ["low", "medium", "high"] as const;
export type Chatter = (typeof CHATTER)[number];

/** The answer Grok must give. Strict mode makes it likely; parseStories re-checks it, because a schema is a request, not a guarantee. */
export const STORIES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["stories"],
  properties: { stories: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["subject", "kind", "why_care", "chatter", "chatter_basis", "posts"],
    properties: {
      subject: { type: "string" }, kind: { type: "string", enum: ["player", "team", "game"] },
      why_care: { type: "string" }, chatter: { type: "string", enum: [...CHATTER] }, chatter_basis: { type: "string" },
      posts: { type: "array", items: { type: "object", additionalProperties: false, required: ["url", "handle", "excerpt"],
        properties: { url: { type: "string" }, handle: { type: "string" }, excerpt: { type: "string" } } } },
    },
  } } },
} as const;

/** Tonight's games by team name, for the prompt and for matching. */
export interface XSlateRef {
  teams: { id: number; name: string }[];
  games: { id: string; homeTeamId: number; awayTeamId: number }[];
  players: { id: string; name: string; teamId: number }[];
}

export function storiesPrompt(ref: XSlateRef, maxStories: number): string {
  const name = (id: number) => ref.teams.find((t) => t.id === id)?.name ?? `team ${id}`;
  const games = ref.games.map((g) => `- ${name(g.awayTeamId)} at ${name(g.homeTeamId)}`);
  return [
    "Search X for what NBA fans and reporters are talking about tonight. Tonight's games:",
    ...games,
    "",
    `Return up to ${maxStories} stories, about tonight's games only. Rules:`,
    "- One subject per story: one player's full name, one team's name, or one game written \"Away vs Home\". Never two players in one story.",
    "- Every story needs at least one supporting post. For each post give its exact x.com URL, the account handle, and a short excerpt copied from the post. Do not include a claim you cannot point to a post for.",
    "- why_care: one sentence on what people are saying, only what the posts say. No numbers or facts that are not in a post.",
    "- chatter: low, medium or high, and chatter_basis says how you judged it (post count, engagement).",
  ].join("\n");
}

// ---------------------------------------------------------------- parsing

/** `claimedHandle` is what Grok wrote beside the URL; it is only compared with the URL's handle, never used as the author. */
export interface XPost { url: string; handle: string; statusId: string; excerpt: string; claimedHandle: string | null }
export interface XStory { subject: string; kind: "player" | "team" | "game"; whyCare: string; chatter: Chatter; chatterBasis: string; posts: XPost[] }

export interface Dropped { story: string; reason: string }

const POST_URL = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:[/?#].*)?$/u;
const MAX_EXCERPT = 280;

/** A post is real only if its URL is an X status URL. Handle and canonical URL come from the URL itself. */
export function parsePost(p: unknown): XPost | null {
  const o = p as { url?: unknown; excerpt?: unknown } | null;
  if (typeof o?.url !== "string" || typeof o.excerpt !== "string") return null;
  const m = POST_URL.exec(o.url.trim());
  // Control characters (a NUL can't be stored in Postgres text) become spaces, then whitespace collapses.
  const excerpt = o.excerpt.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_EXCERPT);
  if (!m || !excerpt) return null;
  const handle = m[1]!.toLowerCase();
  if (handle === "i") return null;   // x.com/i/status/<id> is X's author-less link, not an account
  const claimed = typeof (p as { handle?: unknown }).handle === "string" ? (p as { handle: string }).handle.trim().replace(/^@/u, "").toLowerCase() : null;
  return { handle, statusId: m[2]!, url: `https://x.com/${m[1]}/status/${m[2]}`, excerpt, claimedHandle: claimed };
}

/** Grok's answer → stories. A malformed answer is an error to report; a story with no valid post is dropped and listed. */
export function parseStories(answer: unknown, maxStories: number, citedIds?: ReadonlySet<string>): { stories: XStory[]; dropped: Dropped[] } {
  const raw = (answer as { stories?: unknown } | null)?.stories;
  if (!Array.isArray(raw)) throw new Error(`Grok's answer has no stories list: ${typeof answer === "string" ? answer.slice(0, 120) : JSON.stringify(answer)?.slice(0, 120)}`);
  const stories: XStory[] = [], dropped: Dropped[] = [];
  for (const s of raw.slice(0, maxStories)) {
    const subject = typeof s?.subject === "string" ? s.subject.trim() : "";
    const label = subject || "(no subject)";
    if (!subject || !["player", "team", "game"].includes(s?.kind)) { dropped.push({ story: label, reason: "no subject or kind" }); continue; }
    const seen = new Set<string>();
    const posts = (Array.isArray(s.posts) ? s.posts : []).flatMap((p: unknown) => {
      const post = parsePost(p);
      if (!post || seen.has(post.statusId)) return [];
      if (citedIds && !citedIds.has(post.statusId)) return [];   // a post the search never fetched is no post at all
      seen.add(post.statusId);
      return [post];
    });
    if (posts.length === 0) { dropped.push({ story: label, reason: "no post behind it" }); continue; }
    stories.push({
      subject, kind: s.kind, posts,
      whyCare: typeof s.why_care === "string" ? s.why_care.trim() : "",
      chatter: (CHATTER as readonly string[]).includes(s.chatter) ? s.chatter : "low",
      chatterBasis: typeof s.chatter_basis === "string" ? s.chatter_basis.trim() : "",
    });
  }
  return { stories, dropped };
}

// ---------------------------------------------------------------- resolving to our ids

export type Resolved = { subject: SignalSubject } | { unresolved: string };

/** "Boston Celtics" and "Celtics" are the team; "Boston" alone is not (too loose to attach a post to). */
function matchTeam(text: string, ref: XSlateRef): number | "ambiguous" | undefined {
  const t = normalizeName(text);
  if (!t) return undefined;
  const hits = ref.teams.filter((x) => { const n = normalizeName(x.name); return n === t || n.endsWith(` ${t}`); });
  return hits.length === 1 ? hits[0]!.id : hits.length > 1 ? "ambiguous" : undefined;
}

export function resolveSubject(s: Pick<XStory, "subject" | "kind">, ref: XSlateRef): Resolved {
  if (s.kind === "player") {
    const t = normalizeName(s.subject);
    const hits = ref.players.filter((p) => normalizeName(p.name) === t);
    if (hits.length === 1) return { subject: { kind: "player", id: hits[0]!.id } };
    return { unresolved: hits.length > 1 ? "ambiguous player name" : "player not on tonight's slate" };
  }
  if (s.kind === "team") {
    const id = matchTeam(s.subject, ref);
    return typeof id === "number" ? { subject: { kind: "team", id } } : { unresolved: id === "ambiguous" ? "ambiguous team name" : "team not on tonight's slate" };
  }
  const parts = s.subject.split(/\s+(?:vs\.?|v|at|@)\s+/iu);
  if (parts.length !== 2) return { unresolved: "game not written as two teams" };
  const [a, b] = parts.map((p) => matchTeam(p!, ref));
  if (typeof a !== "number" || typeof b !== "number" || a === b) return { unresolved: "game's teams not found" };
  const game = ref.games.find((g) => (g.homeTeamId === a && g.awayTeamId === b) || (g.homeTeamId === b && g.awayTeamId === a));
  return game ? { subject: { kind: "game", id: game.id } } : { unresolved: "those teams aren't playing each other tonight" };
}

// ---------------------------------------------------------------- the run's result

export interface AccountPull { handle: string; storiesCiting: number; sampleUrl: string; sampleExcerpt: string }

export interface XBuild {
  signals: SignalDraft[];
  accounts: AccountPull[];
  /** What each kept story says, for the run log (the "why care" text is a lead for tuning; it is not stored as a signal). */
  stories: { subject: string; kind: string; whyCare: string; chatter: Chatter; chatterBasis: string; posts: number }[];
  dropped: Dropped[];
  postsOverCap: number;
}

/**
 * Stories in Grok's order, kept until the post cap is reached. One signal per post: its summary is the post's own words with the
 * account named, so a blurb that cites it can only say what that account said. Reported, never silent: every dropped story and every
 * post past the cap is counted.
 */
export function buildX(a: { answer: unknown; ref: XSlateRef; approved: ReadonlySet<string>; observedAt: string; maxStories: number; maxPosts: number; citedIds?: ReadonlySet<string> }): XBuild {
  const { stories, dropped } = parseStories(a.answer, a.maxStories, a.citedIds);
  // X ignores the handle in a status URL, so the handle is only Grok's word. When Grok contradicts itself (its two author fields
  // differ, or one post is credited to two accounts in the answer), it doesn't know who wrote the post: no account is trusted for it.
  const authors = new Map<string, Set<string>>();
  for (const s of stories) for (const p of s.posts) authors.set(p.statusId, (authors.get(p.statusId) ?? new Set()).add(p.handle));
  const authorKnown = (p: XPost) => (p.claimedHandle === null || p.claimedHandle === p.handle) && authors.get(p.statusId)!.size === 1;
  const signals = new Map<string, SignalDraft>();
  const accounts = new Map<string, AccountPull>();
  const kept: XBuild["stories"] = [];
  let postsKept = 0, postsOverCap = 0;

  for (const s of stories) {
    const r = resolveSubject(s, a.ref);
    if ("unresolved" in r) { dropped.push({ story: s.subject, reason: r.unresolved }); continue; }
    const room = Math.max(0, a.maxPosts - postsKept);
    const posts = s.posts.slice(0, room);
    postsOverCap += s.posts.length - posts.length;
    if (posts.length === 0) { dropped.push({ story: s.subject, reason: "post cap reached" }); continue; }
    postsKept += posts.length;
    for (const p of posts) {
      const key = `x:${p.statusId}`;
      signals.set(`${r.subject.kind}:${r.subject.id}|${key}`, {
        kind: "story", subject: r.subject, key,
        summary: `@${p.handle} on X: "${p.excerpt}"`,
        evidence: { url: p.url, quote: p.excerpt, handle: p.handle, observedAt: a.observedAt },
        trust: a.approved.has(p.handle) && authorKnown(p) ? "attributed" : "unreviewed",
      });
    }
    for (const h of new Set(posts.map((p) => p.handle))) {
      const first = posts.find((p) => p.handle === h)!;
      const cur = accounts.get(h);
      accounts.set(h, { handle: h, storiesCiting: (cur?.storiesCiting ?? 0) + 1, sampleUrl: cur?.sampleUrl ?? first.url, sampleExcerpt: cur?.sampleExcerpt ?? first.excerpt });
    }
    kept.push({ subject: s.subject, kind: s.kind, whyCare: s.whyCare, chatter: s.chatter, chatterBasis: s.chatterBasis, posts: posts.length });
  }
  return { signals: [...signals.values()], accounts: [...accounts.values()], stories: kept, dropped, postsOverCap };
}
