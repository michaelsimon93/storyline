// The Claude blurb writer (STO-77, ADR-024: "Curator: ranks stories and writes blurbs"). A second call after the picks are
// accepted, with its own prompt, schema and attempts. Only the worker calls Claude (ADR-003).
//
// Why a second call and not one call that picks and writes (the other option): the strike is known when the blurb is written, a
// bad blurb retries without re-ranking the deck, and the blurb prompt carries only the chosen stories' facts. It costs one more
// call a day. Revisit if blurbs regularly want to change the pick.
//
// What is verified: the request shape is the pick step's (STO-11), which a real production answer proved (Nov 23).
// What isn't: this schema and prompt have not met the real API in a recorded run (tests use a fake client).

import type { Curator } from "./types.js";
import { askClaude, checkEffort, signalView, type ClaudeCuratorOptions } from "./claudeCurator.js";
import { BANNED_WORDS, type BlurbInput, type BlurbRules } from "../domain/blurbRules.js";

/** What the writer is asked. `styleGuide` is the whole of blurb-style-guide.md; `feedback` is empty on the first attempt. */
export interface BlurbRequest {
  input: BlurbInput;
  rules: BlurbRules;
  styleGuide: string;
  feedback: string[];
}

export const BLURB_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["blurbs"],
  properties: {
    blurbs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["storyId", "blurb", "signalIds"],
        properties: { storyId: { type: "string" }, blurb: { type: "string" }, signalIds: { type: "array", items: { type: "integer" } } },
      },
    },
  },
} as const;

/** The rules in words (checkBlurbs enforces them), then the style guide in full. */
export function blurbSystemPrompt(req: BlurbRequest): string {
  return [
    "You write the blurbs for Storyline, a daily deck of NBA cards. A card is a storyline about one player pinned to one over/under line on a prediction market. The blurb is the line of text that tells a fan why they should care about that player tonight.",
    "",
    "Rules. Code checks every one of these; an answer that breaks one is rejected and you are asked again.",
    `- Write exactly one blurb for each story given, at most ${req.rules.maxChars} characters each, counting spaces. One line of plain text.`,
    "- Fan-first, about the player and the storyline. Not betting advice. Never use these words or their endings: " + BANNED_WORDS.join(", ") + ".",
    "- Every claim is grounded. Each story lists signals (facts with an id). In \"signalIds\" list the id of every signal a claim in the blurb relies on, at least one. A claim with no signal behind it must not be written.",
    "- Use only the signals listed for that story: its own \"signals\" and its \"samePlayerOtherAngle\" ones (facts about the same player from his other story). Never another player's fact, never a fact that isn't listed, and never an id that isn't listed.",
    "- A signal with trust \"verified\" may be stated as fact. A signal with trust \"attributed\" is a post from an approved account: state it only as reporting that names the source (\"Per <source>, ...\"), never as plain fact. Its link is stored with the card.",
    "- observedAt is when we saw a signal and slateDate is the day it belongs to. If a signal's slateDate is earlier than the slate day it is dated: say it as history (\"over his last five games\"), and never as breaking news or tonight's news.",
    "- A story with level \"market_only\" has no signals. Write a short, plain blurb from its \"market\" facts alone (player, team, opponent, home or away, stat, line, price). No stats, streaks or news, and use no numbers except the line and the price. Give an empty \"signalIds\".",
    "- \"summary\" only describes the story's angle. It is not a fact to cite: cite the signals.",
    "- Refer to stories by storyId, exactly as given.",
    "",
    "The style guide follows. It is the editor's voice for every blurb; the rules above win if they ever disagree.",
    "",
    req.styleGuide.trim(),
  ].join("\n");
}

export function blurbUserPrompt(req: BlurbRequest): string {
  const stories = req.input.stories.map((s) => ({
    storyId: s.storyId, player: s.playerName, angle: s.angle, summary: s.summary, level: s.level, market: s.market,
    signals: s.signals.map(signalView),
    ...(s.otherAngleSignals.length ? { samePlayerOtherAngle: s.otherAngleSignals.map((g) => ({ ...signalView(g), angle: g.angle })) } : {}),
  }));
  const lines = [`Slate ${req.input.slateDate}. Write blurbs for these ${stories.length} chosen stories:`, JSON.stringify(stories)];
  if (req.feedback.length) lines.push("", "Your previous answer was rejected:", ...req.feedback.map((f) => `- ${f}`), "Fix all of these.");
  return lines.join("\n");
}

export function createClaudeBlurbWriter(opts: ClaudeCuratorOptions): Curator<BlurbRequest, unknown> {
  const effort = checkEffort(opts.effort);
  return {
    name: "claude",
    curate: (req) => askClaude(opts, effort, { system: blurbSystemPrompt(req), user: blurbUserPrompt(req), schema: BLURB_SCHEMA }),
  };
}
