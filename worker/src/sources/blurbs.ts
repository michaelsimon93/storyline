// Run a blurb writer under the rules (STO-77): reject an answer that breaks them, retry with the reasons, up to a cap; if every
// attempt fails, send one alert and return nothing. Never a partial set: a card can't be published without its blurb.
//
// Same shape as curateWithRules (STO-11) on purpose: any Curator works, so tests use a fake, and every attempt is returned so the
// run can store what the writer saw and said (storeAttempts, step "blurb").

import { checkBlurbs, type BlurbInput, type BlurbRules, type BlurbViolation, type CardBlurb } from "../domain/blurbRules.js";
import type { Alert } from "../lib/alert.js";
import type { BlurbRequest } from "./claudeBlurbs.js";
import type { Curator } from "./types.js";

export interface BlurbAttempt {
  attempt: number;
  request: BlurbRequest;
  output?: unknown;
  violations: BlurbViolation[];
  accepted: boolean;
  error?: string;
}

export type BlurbResult = { ok: true; blurbs: CardBlurb[]; attempts: BlurbAttempt[] } | { ok: false; attempts: BlurbAttempt[] };

const MAX_FEEDBACK_ITEMS = 10, MAX_FEEDBACK_CHARS = 300;
function boundedFeedback(violations: BlurbViolation[]): string[] {
  const lines = violations.slice(0, MAX_FEEDBACK_ITEMS).map((x) => x.message.length > MAX_FEEDBACK_CHARS ? `${x.message.slice(0, MAX_FEEDBACK_CHARS)}…` : x.message);
  if (violations.length > MAX_FEEDBACK_ITEMS) lines.push(`…and ${violations.length - MAX_FEEDBACK_ITEMS} more problems`);
  return lines;
}

export async function writeBlurbsWithRules(
  writer: Curator<BlurbRequest, unknown>, input: BlurbInput, rules: BlurbRules, styleGuide: string, alert: Alert,
): Promise<BlurbResult> {
  if (!Number.isInteger(rules.maxAttempts) || rules.maxAttempts < 1) throw new Error(`blurb maxAttempts must be an integer >= 1, got ${rules.maxAttempts}`);
  const attempts: BlurbAttempt[] = [];
  let feedback: string[] = [];
  for (let i = 1; i <= rules.maxAttempts; i++) {
    const request: BlurbRequest = { input, rules, styleGuide, feedback };
    let output: unknown;
    try {
      output = await writer.curate(request);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      attempts.push({ attempt: i, request, violations: [], accepted: false, error });
      feedback = [`the last attempt failed before answering: ${error}`];
      continue;
    }
    const checked = checkBlurbs(input, output, rules);
    if (checked.ok) {
      attempts.push({ attempt: i, request, output, violations: [], accepted: true });
      return { ok: true, blurbs: checked.blurbs, attempts };
    }
    attempts.push({ attempt: i, request, output, violations: checked.violations, accepted: false });
    feedback = boundedFeedback(checked.violations);
  }
  const lines = attempts.map((a) => `#${a.attempt}: ${a.error ? `writer error: ${a.error}` : a.violations.map((x) => `${x.kind} (${x.message})`).join("; ")}`);
  try {
    await alert(`Blurbs failed for ${input.slateDate}: ${attempts.length} attempts, none passed the rules (${input.stories.length} cards). The picks were made but nothing was published.\n${lines.join("\n")}`);
  } catch (err) {
    console.error(`blurbs: could not send the failure alert: ${err instanceof Error ? err.message : err}`);
  }
  return { ok: false, attempts };
}
