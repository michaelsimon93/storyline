// Run a Curator under the rules (STO-11): reject an answer that breaks them, retry with the reasons, up to a cap.
// If every attempt fails, send one detailed alert and return no selection: never a partial one.
//
// Works with any Curator, which is why the tests use a fake. Every attempt is returned (the request it was given,
// what came back, why it was rejected) because that is exactly what a run has to store so a pick can be traced
// to what the model saw (stored by storeAttempts in curationStore.ts).

import { checkSelection, narrowToBand, type CurationInput, type CurationRules, type Selection, type Violation } from "../domain/curationRules.js";
import type { Alert } from "../lib/alert.js";
import type { Curator } from "./types.js";

/** What a Curator is asked. `feedback` is empty on the first attempt, then lists what the last answer got wrong. */
export interface CurationRequest {
  input: CurationInput;
  rules: CurationRules;
  feedback: string[];
}

export interface Attempt {
  attempt: number;
  request: CurationRequest;
  /** The raw answer, exactly as the curator returned it (undefined if it threw). */
  output?: unknown;
  violations: Violation[];
  /** True for the one attempt whose answer passed every rule. */
  accepted: boolean;
  /** Set when the curator itself failed (network, overload, unparseable) rather than breaking a rule. */
  error?: string;
}

export type CurateResult =
  | { ok: true; selection: Selection; attempts: Attempt[] }
  | { ok: false; attempts: Attempt[] };

/** What the retry is told: the first few problems in full-ish, then a count, so one hostile answer can't balloon the next prompt. */
const MAX_FEEDBACK_ITEMS = 10, MAX_FEEDBACK_CHARS = 300;
function boundedFeedback(violations: Violation[]): string[] {
  const lines = violations.slice(0, MAX_FEEDBACK_ITEMS).map((x) => x.message.length > MAX_FEEDBACK_CHARS ? `${x.message.slice(0, MAX_FEEDBACK_CHARS)}…` : x.message);
  if (violations.length > MAX_FEEDBACK_ITEMS) lines.push(`…and ${violations.length - MAX_FEEDBACK_ITEMS} more problems`);
  return lines;
}

export async function curateWithRules(
  curator: Curator<CurationRequest, unknown>,
  input: CurationInput,
  rules: CurationRules,
  alert: Alert,
): Promise<CurateResult> {
  if (!Number.isInteger(rules.maxAttempts) || rules.maxAttempts < 1) {
    throw new Error(`curation maxAttempts must be an integer >= 1, got ${rules.maxAttempts}`);
  }

  // What the model sees: ladders cut to the band, stories with no in-band strike left dropped. The answer is
  // still checked against the full input, so a strike it was never shown is caught, not trusted.
  const shown = narrowToBand(input, rules);
  if (shown.stories.length === 0) {
    // Nothing can be picked (every ladder is out of band, or the band is misconfigured). Don't pay for a call that can only
    // answer "nothing", and don't call an empty deck a success.
    try {
      await alert(`Curation failed for ${input.slateDate}: none of the ${input.stories.length} shortlisted stories has a strike inside the price band ` +
        `(${rules.bandMin}-${rules.bandMax}%), so Claude was not called and nothing was published. Check the price band and the market prices.`);
    } catch (err) {
      console.error(`curation: could not send the failure alert: ${err instanceof Error ? err.message : err}`);
    }
    return { ok: false, attempts: [] };
  }
  const attempts: Attempt[] = [];
  let feedback: string[] = [];
  for (let i = 1; i <= rules.maxAttempts; i++) {
    const request: CurationRequest = { input: shown, rules, feedback };
    let output: unknown;
    try {
      output = await curator.curate(request);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      attempts.push({ attempt: i, request, violations: [], accepted: false, error });
      feedback = [`the last attempt failed before answering: ${error}`];
      continue;
    }
    const checked = checkSelection(input, output, rules);
    if (checked.ok) {
      attempts.push({ attempt: i, request, output, violations: [], accepted: true });
      return { ok: true, selection: checked.selection, attempts };
    }
    attempts.push({ attempt: i, request, output, violations: checked.violations, accepted: false });
    feedback = boundedFeedback(checked.violations);
  }

  // The alert helper truncates long messages, so keep each attempt to one short line.
  const lines = attempts.map((a) =>
    `#${a.attempt}: ${a.error ? `curator error: ${a.error}` : a.violations.map((x) => `${x.kind} (${x.message})`).join("; ")}`);
  try {
    await alert(
      `Curation failed for ${input.slateDate}: ${attempts.length} attempts, none passed the rules (${input.stories.length} stories, n=${rules.n}). ` +
      `Nothing was published.\n${lines.join("\n")}`);
  } catch (err) {
    console.error(`curation: could not send the failure alert: ${err instanceof Error ? err.message : err}`);
  }
  return { ok: false, attempts };
}
