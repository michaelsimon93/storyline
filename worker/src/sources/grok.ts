// The xAI (Grok) client, STO-75, ADR-003 (only the worker calls external APIs). One call: a Responses API request with the
// `x_search` tool and a JSON schema for the answer.
//
// Verified against a real call on 2026-11-25 (recorded: test/fixtures/xai-x-search-stories-2026-11-25.json): the answer is an output
// item of type "message" whose output_text is the JSON; usage carries cost_in_usd_ticks and x_posts_fetched.
// NOT verified: that a tick is 1e-10 USD. It is inferred (1,361,488,000 ticks for a call that fetched 24 posts = $0.136), so the
// dollar figure is labelled an estimate wherever it is shown.
//
// No retry: every attempt is billed, and a failed call is reported while curation goes on without X (ticket). So a 429 or 5xx
// throws like any other failure, instead of paying again behind our back.

export const XAI_URL = "https://api.x.ai/v1/responses";

export class GrokError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "GrokError"; }
}

export interface GrokOptions {
  apiKey: string;
  /** From app_config (x_model): no default in code (ADR-018). */
  model: string;
  timeoutMs: number;
}

export interface GrokUsage {
  /** xAI's own cost counter. 1 tick is believed to be 1e-10 USD (unverified, see the file comment). */
  costTicks: number;
  postsFetched: number;
  searchCalls: number;
}

export interface GrokAnswer { answer: unknown; usage: GrokUsage }

/** Ticks → US dollars, on the unverified 1e-10 assumption. */
export const ticksToUsd = (ticks: number) => ticks / 1e10;

/** One X search that answers in JSON matching `schema`. Throws GrokError on any failure; the answer is parsed JSON, or the raw text if it isn't JSON. */
export async function askGrok(opts: GrokOptions, call: { input: string; schema: Record<string, unknown>; schemaName: string }): Promise<GrokAnswer> {
  let res: Response;
  try {
    res = await fetch(XAI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}`, "user-agent": "storyline-worker/0.1" },
      body: JSON.stringify({
        model: opts.model,
        input: call.input,
        tools: [{ type: "x_search" }],
        text: { format: { type: "json_schema", name: call.schemaName, strict: true, schema: call.schema } },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw new GrokError(`xAI request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) throw new GrokError(`xAI HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);

  let parsed: any;
  try { parsed = JSON.parse(body); } catch { throw new GrokError("xAI answered with something that isn't JSON"); }
  if (parsed?.error) throw new GrokError(`xAI error: ${JSON.stringify(parsed.error).slice(0, 200)}`);
  if (parsed?.status && parsed.status !== "completed") throw new GrokError(`xAI response status ${parsed.status}${parsed.incomplete_details ? `: ${JSON.stringify(parsed.incomplete_details)}` : ""}`);

  const text = (parsed?.output ?? [])
    .filter((o: any) => o?.type === "message")
    .flatMap((o: any) => o.content ?? [])
    .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
    .map((c: any) => c.text as string)
    .join("");
  if (!text) throw new GrokError("xAI answered with no text");

  const u = parsed?.usage ?? {};
  const usage: GrokUsage = {
    costTicks: Number(u.cost_in_usd_ticks ?? 0),
    postsFetched: Number(u.server_side_tool_usage_details?.x_posts_fetched ?? 0),
    searchCalls: Number(u.server_side_tool_usage_details?.x_search_calls ?? 0),
  };
  try { return { answer: JSON.parse(text), usage }; } catch { return { answer: text, usage }; }
}
