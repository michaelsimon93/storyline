// The blurb rules (STO-77, spec §3 "Blurb rules", ADR-014, ADR-024). Pure: no network, no database. A prompt asks for these
// rules; this file is the check, so an answer that breaks one is rejected and asked for again.
//
// What is enforced here, and what isn't:
//  - Enforced: length, one line, no betting words, every blurb cites at least one signal, and only signals this story's writer
//    was shown (its own, or "same player, other angle", STO-120): so another player's fact, an invented id and an unreviewed
//    signal (which are never put in front of the writer) can't be cited. A dated fact isn't dressed up as news (STO-91).
//  - Not enforced: that the sentence actually says what the cited signal says. A validator can't read; the stored facts make
//    every claim auditable instead. (A numeric check was left out on purpose: "30.6" vs "30" would reject honest rounding.)
//  - Market-only blurbs (ADR-024 rule 7.3) have nothing to cite, so the one thing checked is that no number appears that
//    isn't the line or the price.

import { MARKET_STAT } from "../sources/curationInput.js";
import type { CurationInput, CurationSignal, OtherAngleSignal, Selection } from "./curationRules.js";

/** Betting language (spec §3). The same list is printed in blurb-style-guide.md; a test keeps the two together. */
export const BANNED_WORDS = ["lock", "hammer", "smash", "bet", "betting", "wager", "parlay", "guaranteed", "free money", "sure thing"] as const;
const BANNED = new RegExp(`\\b(?:${BANNED_WORDS.join("|")})(?:s|es|ed|ing)?\\b`, "iu");

/** Words that make a fact sound like it just happened. Never allowed on a blurb that leans on a dated signal (ADR-024 rule 7.1). */
const FRESH_NEWS = /\b(?:breaking|just (?:announced|reported|learned|in)|announced (?:today|this morning)|this morning|tonight's news|moments ago|minutes ago)\b/iu;

/** The facts about the card itself, from our own tables: the one thing a market-only blurb may use. */
export interface BlurbMarket {
  player: string;
  team: string;
  opponent: string;
  home: boolean;
  stat: string;
  strike: number;
  yesPriceCents: number;
}

/** `full`: has signals to cite. `market_only`: ESPN is down or the story has only unreviewed signals (ADR-024 rule 7.3). */
export type BlurbLevel = "full" | "market_only";

export interface BlurbStory {
  storyId: string;
  playerName: string;
  angle: string;
  summary: string;
  market: BlurbMarket;
  /** Only verified signals, and attributed ones that have a link. Unreviewed signals are never put here. */
  signals: CurationSignal[];
  otherAngleSignals: OtherAngleSignal[];
  level: BlurbLevel;
}

export interface BlurbInput { slateDate: string; stories: BlurbStory[] }
export interface BlurbRules { maxChars: number; maxAttempts: number }

/** A signal as stored in `cards.blurb_facts` (ADR-014): enough to audit a claim without joining anything. */
export interface CitedSignal extends CurationSignal {
  /** "own" (the story's own signal) or "other_angle:<angle>" (same player, other angle: STO-120). */
  via: string;
}
export interface BlurbFacts { level: BlurbLevel; market: BlurbMarket; signals: CitedSignal[] }
export interface CardBlurb { storyId: string; blurb: string; facts: BlurbFacts }

export type BlurbViolationKind =
  | "malformed" | "story_set" | "format" | "length" | "banned_word" | "no_citation" | "unknown_signal"
  | "dated_news" | "dated_phrasing" | "market_only_number";
export interface BlurbViolation { kind: BlurbViolationKind; message: string }
export type BlurbCheck = { ok: true; blurbs: CardBlurb[] } | { ok: false; violations: BlurbViolation[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Code points, which is what Postgres `char_length` counts. */
const charLength = (s: string) => [...s].length;
const listIds = (ids: string[], max: number) => ids.length <= max ? ids.join(", ") : `${ids.slice(0, max).join(", ")} and ${ids.length - max} more`;

interface RawBlurb { storyId: string; blurb: string; signalIds: number[] }

function parseShape(out: unknown): RawBlurb[] | undefined {
  if (!isRecord(out) || !Array.isArray(out.blurbs)) return undefined;
  const list: RawBlurb[] = [];
  for (const b of out.blurbs) {
    if (!isRecord(b) || typeof b.storyId !== "string" || typeof b.blurb !== "string") return undefined;
    if (!Array.isArray(b.signalIds) || !b.signalIds.every((n) => Number.isInteger(n))) return undefined;
    list.push({ storyId: b.storyId, blurb: b.blurb, signalIds: b.signalIds as number[] });
  }
  return list;
}

export function checkBlurbs(input: BlurbInput, output: unknown, rules: BlurbRules): BlurbCheck {
  const raw = parseShape(output);
  if (!raw) return { ok: false, violations: [{ kind: "malformed", message: 'answer must be {"blurbs": [{"storyId": string, "blurb": string, "signalIds": [integer…]}…]}' }] };

  const v: BlurbViolation[] = [];
  const add = (kind: BlurbViolationKind, message: string) => v.push({ kind, message });
  const byId = new Map(input.stories.map((s) => [s.storyId, s]));

  const seen = new Set<string>(), repeated = new Set<string>();
  for (const b of raw) { if (seen.has(b.storyId)) repeated.add(b.storyId); seen.add(b.storyId); }
  const missing = input.stories.filter((s) => !seen.has(s.storyId)).map((s) => s.storyId);
  const extra = [...seen].filter((id) => !byId.has(id));
  if (missing.length || extra.length || repeated.size) {
    add("story_set", `write exactly one blurb for each of the ${input.stories.length} chosen stories` +
      (missing.length ? `; missing ${listIds(missing, 10)}` : "") + (extra.length ? `; not chosen: ${listIds(extra, 5)}` : "") + (repeated.size ? `; more than one blurb for ${listIds([...repeated], 5)}` : ""));
  }

  const done: CardBlurb[] = [];
  for (const b of raw) {
    const story = byId.get(b.storyId);
    if (!story) continue;
    const label = `story ${b.storyId}`;
    const text = b.blurb.trim();
    const before = v.length;

    if (text === "" || /[\p{Cc}\u2028\u2029]/u.test(text)) add("format", `${label}: the blurb must be one line of plain text (no line breaks or control characters)`);
    if (charLength(text) > rules.maxChars) add("length", `${label}: the blurb is ${charLength(text)} characters; at most ${rules.maxChars}`);
    const word = BANNED.exec(text);
    if (word) add("banned_word", `${label}: "${word[0]}" is betting language; this is a fan story, not betting advice`);

    // Citations. Only what this story's writer was shown can be cited: that single rule covers an invented id, another story's,
    // another player's, and an unreviewed signal (never shown). It is also what STO-120 asks: Powell's absence is citable on
    // Hield's hot-streak card only through the id of his other story's signal.
    const allowed = new Map<number, CitedSignal>();
    for (const g of story.signals) allowed.set(g.id, { ...g, via: "own" });
    for (const g of story.otherAngleSignals) { const { angle, ...rest } = g; allowed.set(g.id, { ...rest, via: `other_angle:${angle}` }); }
    const ids = [...new Set(b.signalIds)];
    const unknown = ids.filter((id) => !allowed.has(id));
    if (unknown.length) add("unknown_signal", `${label}: cites ${unknown.join(", ")}, which ${story.level === "market_only" ? "has no signals to cite" : "isn't one of the signals shown for this story"}`);
    if (story.level === "full" && ids.length === 0) add("no_citation", `${label}: cite the signal id behind every claim (at least one)`);

    const cited = ids.flatMap((id) => allowed.get(id) ?? []);
    const dated = cited.filter((g) => g.slateDate < input.slateDate);
    for (const g of dated) {
      if (g.kind !== "stat") add("dated_news", `${label}: signal ${g.id} is ${g.kind} from ${g.slateDate}, before the slate day ${input.slateDate}; it can't be used`);
    }
    if (dated.length && FRESH_NEWS.test(text)) add("dated_phrasing", `${label}: signal ${dated[0]!.id} is from ${dated[0]!.slateDate}; don't word it as breaking or fresh news`);

    if (story.level === "market_only") {
      const ok = new Set([String(story.market.strike), String(story.market.yesPriceCents)]);
      const stray = (text.match(/\d+(?:\.\d+)?/gu) ?? []).filter((n) => !ok.has(n));
      if (stray.length) add("market_only_number", `${label}: no stats are available, so the only numbers allowed are the line (${story.market.strike}) and the price (${story.market.yesPriceCents}); remove ${[...new Set(stray)].join(", ")}`);
    }

    if (v.length === before) done.push({ storyId: b.storyId, blurb: text, facts: { level: story.level, market: story.market, signals: cited } });
  }

  return v.length ? { ok: false, violations: v } : { ok: true, blurbs: done };
}

// ---------------------------------------------------------------- building the writer's input

/** What the writer is told of the matchup, from our teams table: loaded by the job, passed in so this stays pure. */
export type TeamsOf = (story: { storyId: string; playerId: string; gameId: string }) => { team: string; opponent: string; home: boolean };

/** A signal the writer may use: verified, or attributed and linked (ADR-024 rule 2). Unreviewed ones may inform ranking, never a blurb. */
const usable = (g: CurationSignal) => g.trust === "verified" || (g.trust === "attributed" && !!g.url);

/** The chosen stories, each with the strike that was picked and only the signals a blurb may use. */
export function buildBlurbInput(shown: CurationInput, selection: Selection, teamsOf: TeamsOf): BlurbInput {
  const byId = new Map(shown.stories.map((s) => [s.storyId, s]));
  const stories = selection.picks.map((p): BlurbStory => {
    const s = byId.get(p.storyId);
    if (!s) throw new Error(`blurbs: picked story ${p.storyId} is not on the shown stories`);
    const rung = s.ladder.find((l) => l.marketId === p.marketId);
    if (!rung) throw new Error(`blurbs: picked market ${p.marketId} is not on story ${p.storyId}'s ladder`);
    const signals = s.signals.filter(usable), otherAngleSignals = s.otherAngleSignals.filter(usable);
    return {
      storyId: s.storyId, playerName: s.playerName, angle: s.angle, summary: s.summary, signals, otherAngleSignals,
      level: signals.length + otherAngleSignals.length === 0 ? "market_only" : "full",
      market: { player: s.playerName, ...teamsOf(s), stat: (MARKET_STAT as Record<string, string>)[s.stat] ?? s.stat, strike: rung.strike, yesPriceCents: rung.yesPriceCents },
    };
  });
  return { slateDate: shown.slateDate, stories };
}
