// A fake blurb writer for job tests (STO-77): no network. By default it writes a clean blurb for every story, citing the story's
// first own signal (or none, for a market-only story). Pass `answers` to script exact replies, or an Error to make a call fail.
import type { Curator } from "../../src/sources/types.js";
import type { BlurbRequest } from "../../src/sources/claudeBlurbs.js";

export type FakeWriter = Curator<BlurbRequest, unknown> & { seen: BlurbRequest[] };

export const cleanAnswer = (r: BlurbRequest) => ({
  blurbs: r.input.stories.map((s) => ({
    storyId: s.storyId,
    blurb: s.level === "market_only" ? `${s.playerName} and the ${s.market.team} take on the ${s.market.opponent}.` : `${s.playerName} is the story tonight.`,
    signalIds: s.signals.length ? [s.signals[0]!.id] : s.otherAngleSignals.length ? [s.otherAngleSignals[0]!.id] : [],
  })),
});

/** A scripted reply: a value, an Error to throw, or a function of the request. (Not `unknown`, which would erase the function's parameter type.) */
export type Reply = Error | string | Record<string, unknown> | ((r: BlurbRequest) => unknown);

export function fakeWriter(answers?: Reply[]): FakeWriter {
  const seen: BlurbRequest[] = [];
  return {
    name: "fake-writer", seen,
    async curate(r) {
      seen.push(r);
      const a = answers ? answers[seen.length - 1] : cleanAnswer;
      if (a instanceof Error) throw a;
      return typeof a === "function" ? a(r) : a;
    },
  };
}
export const GUIDE = "# test style guide";
