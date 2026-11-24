// The Claude implementation of Curator (STO-11, ADR-024). Only the worker calls Claude (ADR-003).
//
// What is verified and what isn't: the request shape (output_config.format json_schema, effort) is checked against
// the installed SDK's types and the skill reference, not against a recorded response. Tests use a fake client.
// Not enabled: the server-side `fallbacks` option. A refusal or a cut-off answer throws, which counts as a failed
// attempt and is retried by curateWithRules; revisit if refusals show up in the stored attempts.
//
// No sampling parameters and no forced tool_choice: newer models reject both. The answer's shape is constrained by a
// JSON schema, and the rules (one per player, band, caps) are still checked in code by checkSelection.

import type Anthropic from "@anthropic-ai/sdk";
import type { Curator } from "./types.js";
import type { CurationRequest } from "./curate.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ClaudeCuratorOptions {
  client: Pick<Anthropic, "messages">;
  /** From app_config (curation_model): no default in code (ADR-018). */
  model: string;
  maxTokens: number;
  effort: string;
}

/** The shape Claude must answer in. checkSelection re-validates it: a schema is a request, not a guarantee. */
export const SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ranking", "picks"],
  properties: {
    ranking: { type: "array", items: { type: "string" } },
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["storyId", "marketId", "reason"],
        properties: { storyId: { type: "string" }, marketId: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
} as const;

/** The instructions: the rules in words. The same rules are enforced in code, so this only has to make them likely. */
export function systemPrompt(req: CurationRequest): string {
  const r = req.rules;
  return [
    "You are the curator for Storyline, a daily deck of NBA cards. A card is a storyline about one player, pinned to one over/under line (a strike) on a prediction market. Rank the stories by \"why should a fan care?\", then pick the final cards.",
    "",
    "Rules. Code checks every one of these; an answer that breaks one is rejected and you are asked again.",
    `- Pick exactly ${r.n} stories, or as many as the rules below allow if the slate can't fill ${r.n} (few players, few games, or one stat). At most one pick per player.`,
    "- For each pick, choose one strike from that story's own ladder and give its marketId. Choose the strike that best fits the story, for example a player hitting 30 for five straight games wants a strike near that level. Every strike shown is already inside the allowed price band; the price is the market's chance, not a measure of quality.",
    `- At most ${r.maxPerGame} picks from one game (the "game" field) and at most ${r.maxPerStat} on one stat.`,
    "- \"ranking\" lists every story shown, best first, each exactly once. \"picks\" lists your final cards in deck order, best first.",
    "- Give each pick a one-line reason: why a fan should care, and why that strike. Plain text on one line, no betting advice.",
    "",
    "Story first, line second. Story types (the \"angle\" field) carry no scores, because scores from different types can't be compared: judge them against each other yourself. Don't favor a type out of habit. A day dominated by one type is fine only if those are truly the best stories.",
    "Each story lists its signals: facts with an id, a source and a trust level. Only \"verified\" and \"attributed\" signals are established; treat \"unreviewed\" ones as hints at most.",
    "Refer to stories by storyId and strikes by marketId, exactly as given.",
  ].join("\n");
}

/** The day's stories as the model sees them: only what it needs, in the order they were given. */
export function userPrompt(req: CurationRequest): string {
  const stories = req.input.stories.map((s) => ({
    storyId: s.storyId, player: s.playerName, game: s.gameId, stat: s.stat, angle: s.angle, summary: s.summary,
    signals: s.signals.map((g) => ({ id: g.id, source: g.source, kind: g.kind, trust: g.trust, summary: g.summary })),
    ladder: s.ladder.map((l) => ({ marketId: l.marketId, strike: l.strike, yesPriceCents: l.yesPriceCents })),
  }));
  const lines = [`Slate ${req.input.slateDate}. ${stories.length} stories:`, JSON.stringify(stories)];
  if (req.feedback.length) lines.push("", "Your previous answer was rejected:", ...req.feedback.map((f) => `- ${f}`), "Fix all of these.");
  return lines.join("\n");
}

export function createClaudeCurator(opts: ClaudeCuratorOptions): Curator<CurationRequest, unknown> {
  if (!(EFFORTS as readonly string[]).includes(opts.effort)) {
    throw new Error(`curation_effort must be one of ${EFFORTS.join(", ")}, got ${JSON.stringify(opts.effort)}`);
  }
  const effort = opts.effort as Effort;
  return {
    name: "claude",
    async curate(req) {
      const res = await opts.client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: systemPrompt(req),
        messages: [{ role: "user", content: userPrompt(req) }],
        output_config: { effort, format: { type: "json_schema", schema: SELECTION_SCHEMA } },
      });
      if (res.stop_reason === "refusal") {
        const cat = (res as { stop_details?: { category?: string | null } | null }).stop_details?.category;
        throw new Error(`Claude refused the request${cat ? ` (${cat})` : ""}`);
      }
      if (res.stop_reason === "max_tokens") throw new Error(`Claude's answer was cut off at ${opts.maxTokens} tokens`);
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      try { return JSON.parse(text) as unknown; } catch { return text; }   // unparseable: hand the text on, so it is stored and reported as malformed
    },
  };
}
