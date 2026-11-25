// Builders for xAI Responses API answers in the recorded shape (test/fixtures/xai-x-search-stories-2026-11-25.json), so a test
// can make Grok say exactly what it needs to without a second recording. The recorded fixture is the contract; this only varies the text.

import type { XStory } from "../../src/domain/xStories.js";

export interface RawStory { subject: string; kind: string; why_care?: string; chatter?: string; chatter_basis?: string; posts: { url: string; handle: string; excerpt: string }[] }

export const story = (subject: string, kind: string, posts: [handle: string, id: string, excerpt: string][]): RawStory => ({
  subject, kind, why_care: `${subject} is trending`, chatter: "medium", chatter_basis: "a few posts",
  posts: posts.map(([handle, id, excerpt]) => ({ url: `https://x.com/${handle}/status/${id}`, handle: `@${handle}`, excerpt })),
});

/** A completed Responses API body whose message text is `answer` (as JSON), with usage in the recorded shape. */
export function xaiResponse(answer: unknown, usage: { ticks?: number; posts?: number; searches?: number } = {}) {
  return {
    id: "resp-test", model: "grok-4.3", object: "response", status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", summary: [], status: "completed" },
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: typeof answer === "string" ? answer : JSON.stringify(answer), annotations: [] }] },
    ],
    usage: { input_tokens: 1, output_tokens: 1, cost_in_usd_ticks: usage.ticks ?? 1_000_000_000,
      server_side_tool_usage_details: { x_search_calls: usage.searches ?? 3, x_posts_fetched: usage.posts ?? 20 } },
  };
}

export type { XStory };
