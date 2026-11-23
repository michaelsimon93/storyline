// The rules a curator's answer must satisfy before anything is published (STO-11, spec §3 step 5, ADR-014).
// Pure: no network, no database. Enforced here, in code, because a prompt is a request and this is the check.
//
// PROVISIONAL INPUT TYPE. `CurationInput` / `CurationStory` are written for STO-11 on its own, because the real
// matched shortlist (STO-76's follow-up) isn't on main yet. When it lands, one small adapter turns a shortlist
// entry into a `CurationStory`; the rules below only read the fields named here, so they don't change.
//
// Design rule: every fact a rule needs (player, game, stat, price) is read from OUR input, found through the
// story/market the model names. We never trust the model's own description of a pick, so it can't dodge a rule
// by mislabelling one.
//
// Adding X later (STO-75) is more data, not a new interface: more entries in a story's `signals` (source "x",
// kind "buzz"/"story", trust "attributed"/"unreviewed"). Nothing here reads signal contents.
//
// Scores are deliberately absent. Detector scores are per-angle and not comparable (STO-103), so a story carries
// its `angle` and a summary, and Claude is asked to compare across angles itself.

import type { SignalKind, TrustLevel } from "../sources/types.js";

/** A fact the curator may weigh. `id` is the stored signal's ID (what blurbs will cite in STO-77). */
export interface CurationSignal {
  id: number;
  source: string;
  kind: SignalKind;
  trust: TrustLevel;
  summary: string;
}

/** One rung of the player's ladder. `marketId` is our market id (ADR-021), never a provider's. */
export interface LadderStrike {
  marketId: string;
  strike: number;
  /** Integer cents, 1-99. */
  yesPriceCents: number;
}

export interface CurationStory {
  storyId: string;
  playerId: string;
  /** For people reading the #testing post; the rules never read it. */
  playerName: string;
  gameId: string;
  /** The stat the story is about ("pts", "reb"…): what "spread across stat types" counts. */
  stat: string;
  /** Text, not an enum: new angles need no change here. */
  angle: string;
  summary: string;
  signals: CurationSignal[];
  /** Every open, tight-spread strike we know for this player and stat. The curator is shown only the in-band part (`narrowToBand`); the rules still check the band on whatever it answers. */
  ladder: LadderStrike[];
}

export interface CurationInput {
  slateDate: string;
  stories: CurationStory[];
}

/** From app_config, passed in whole: there are no defaults in code (ADR-018). */
export interface CurationRules {
  /** How many cards to pick. */
  n: number;
  /** Price band for the chosen strike's Yes price, in cents, edges included. */
  bandMin: number;
  bandMax: number;
  maxPerGame: number;
  maxPerStat: number;
  /** Calls to the curator before giving up. */
  maxAttempts: number;
}

export interface Pick { storyId: string; marketId: string; reason: string }
export interface Selection { ranking: string[]; picks: Pick[] }

export type ViolationKind =
  | "malformed" | "ranking" | "pick_count" | "unknown_story" | "unknown_strike"
  | "player_repeat" | "out_of_band" | "game_cap" | "stat_cap" | "reason";

export interface Violation { kind: ViolationKind; message: string }

export type CheckResult = { ok: true; selection: Selection } | { ok: false; violations: Violation[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The shape only: is this a ranking of strings and picks of three strings? */
function parseShape(out: unknown): Selection | undefined {
  if (!isRecord(out) || !Array.isArray(out.ranking) || !Array.isArray(out.picks)) return undefined;
  if (!out.ranking.every((r) => typeof r === "string")) return undefined;
  const picks: Pick[] = [];
  for (const p of out.picks) {
    if (!isRecord(p) || typeof p.storyId !== "string" || typeof p.marketId !== "string" || typeof p.reason !== "string") return undefined;
    picks.push({ storyId: p.storyId, marketId: p.marketId, reason: p.reason });
  }
  return { ranking: out.ranking as string[], picks };
}

const inBand = (l: LadderStrike, r: CurationRules) => l.yesPriceCents >= r.bandMin && l.yesPriceCents <= r.bandMax;

/**
 * What the curator is shown (STO-11 decision 2): each ladder cut to the price band, and a story with no in-band
 * strike left dropped, since it can't be a card. The band is a hard rule, so code applies it instead of asking the
 * model to, which makes out-of-band picks impossible rather than merely retried.
 */
export function narrowToBand(input: CurationInput, rules: CurationRules): CurationInput {
  const stories = input.stories
    .map((s) => ({ ...s, ladder: s.ladder.filter((l) => inBand(l, rules)) }))
    .filter((s) => s.ladder.length > 0);
  return { ...input, stories };
}

/** Check a curator's answer against the rules. Reports every problem at once, so one retry can fix them all. */
export function checkSelection(input: CurationInput, output: unknown, rules: CurationRules): CheckResult {
  const sel = parseShape(output);
  if (!sel) {
    return { ok: false, violations: [{ kind: "malformed", message: 'answer must be {"ranking": [storyId…], "picks": [{"storyId", "marketId", "reason"}…]}' }] };
  }

  const v: Violation[] = [];
  const add = (kind: ViolationKind, message: string) => v.push({ kind, message });
  const byId = new Map(input.stories.map((s) => [s.storyId, s]));

  // The ranked shortlist: every story the curator was shown (those with a strike in the band), exactly once.
  const shown = input.stories.filter((s) => s.ladder.some((l) => inBand(l, rules)));
  const shownIds = new Set(shown.map((s) => s.storyId));
  const ranked = new Set(sel.ranking);
  const missing = shown.filter((s) => !ranked.has(s.storyId)).map((s) => s.storyId);
  const invented = [...ranked].filter((id) => !shownIds.has(id));
  if (ranked.size !== sel.ranking.length || missing.length || invented.length) {
    add("ranking", `ranking must list each of the ${shown.length} stories exactly once` +
      (missing.length ? `; missing ${missing.join(", ")}` : "") +
      (invented.length ? `; not on the shortlist: ${invented.join(", ")}` : "") +
      (ranked.size !== sel.ranking.length ? "; repeats a story" : ""));
  }

  // How many: N, or every distinct player if the shortlist has fewer than N (one card per player).
  const want = Math.min(rules.n, new Set(shown.map((s) => s.playerId)).size);
  if (sel.picks.length !== want) add("pick_count", `expected ${want} picks, got ${sel.picks.length}`);

  const players = new Set<string>();
  const perGame = new Map<string, number>();
  const perStat = new Map<string, number>();

  for (const p of sel.picks) {
    const story = byId.get(p.storyId);
    if (!story) { add("unknown_story", `pick ${p.storyId} is not a story on the shortlist`); continue; }

    if (players.has(story.playerId)) add("player_repeat", `more than one pick for the player behind story ${p.storyId}`);
    players.add(story.playerId);
    perGame.set(story.gameId, (perGame.get(story.gameId) ?? 0) + 1);
    perStat.set(story.stat, (perStat.get(story.stat) ?? 0) + 1);

    const rung = story.ladder.find((l) => l.marketId === p.marketId);
    if (!rung) add("unknown_strike", `pick ${p.marketId} is not on the ladder for story ${p.storyId}`);
    else if (!inBand(rung, rules)) {
      add("out_of_band", `pick ${p.marketId} for story ${p.storyId} is out of band: yes price ${rung.yesPriceCents}c, band ${rules.bandMin}-${rules.bandMax}c`);
    }

    if (p.reason.trim() === "") add("reason", `pick ${p.storyId} has no reason`);
    else if (/[\r\n]/.test(p.reason.trim())) add("reason", `pick ${p.storyId}: the reason must be one line`);
  }

  for (const [g, n] of perGame) if (n > rules.maxPerGame) add("game_cap", `${n} picks from game ${g}; at most ${rules.maxPerGame}`);
  for (const [s, n] of perStat) if (n > rules.maxPerStat) add("stat_cap", `${n} picks on stat ${s}; at most ${rules.maxPerStat}`);

  return v.length ? { ok: false, violations: v } : { ok: true, selection: sel };
}
