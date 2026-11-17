// The three kinds of source curation talks to (ADR-024). One interface each, one real
// implementation each today. Adding a source is a new module, not a plugin system (ADR-021).

import type { FetchOptions } from "../lib/http.js";

// ---------------------------------------------------------------- markets

/**
 * Lists markets, prices and results. v1: Kalshi.
 *
 * Generic over the provider's raw market shape on purpose: turning that into Storyline's own
 * model is still the provider's parser (kalshiParse.ts), and a second market source is what
 * would justify a neutral shape (ADR-021 rule 6). Until then the type parameter says what
 * ingest and the poller really read, instead of a neutral type with one provider hiding in it.
 *
 * A market source failing stops the run: there is nothing to attach stories to (ADR-024 rule 6).
 */
export interface MarketSource<M = unknown> {
  /** The provider's name in external_ids (ADR-021). */
  readonly name: string;
  /** Every open market in a series, following pagination, each market once. */
  listOpen(series: string): Promise<M[]>;
  /** Specific markets by ID, in any status (open, paused, closed, settled). */
  getByIds(ids: string[], opts?: FetchOptions): Promise<M[]>;
}

// ---------------------------------------------------------------- context

/** What a signal is: `stat` and `news` and `injury` from stats feeds; `buzz` and `story` from social/reporting. */
export type SignalKind = "stat" | "news" | "injury" | "buzz" | "story";

/**
 * How a blurb may use a signal (ADR-024 rule 2).
 * - verified: may be stated as fact (ESPN).
 * - attributed: may be stated only as reporting, naming the source and linking it.
 * - unreviewed: may inform discovery and ranking, never a blurb.
 */
export type TrustLevel = "verified" | "attributed" | "unreviewed";

/** A signal's subject, as our own IDs (ADR-021): never a provider's. */
export type SignalSubject =
  | { kind: "player"; id: string }   // players.id (uuid)
  | { kind: "team"; id: number }     // teams.id
  | { kind: "game"; id: string };    // games.id (uuid)

/** A signal as a source reports it. The store assigns the ID that blurbs cite. */
export interface SignalDraft {
  kind: SignalKind;
  subject: SignalSubject;
  /** One line, written to be read by the curator. */
  summary: string;
  /** Where it came from: a URL or a quote, plus when we saw it. */
  evidence: { url?: string; quote?: string; observedAt: string };
  trust: TrustLevel;
  /**
   * Stable within one source, subject and slate day: the same fact reported again by a re-run has
   * the same key, so re-running a day doesn't duplicate it. e.g. "last5:pts" or "news:<article id>".
   */
  key: string;
}

export interface SlatePlayer {
  id: string;
  name: string;
  teamId: number;
  /** This source's own ID for the player (external_ids), or null if we haven't matched one. */
  externalId: string | null;
  injuryStatus: string | null;
}

export interface SlateTeam { id: number; externalId: string | null }

export interface SlateGame {
  id: string;
  homeTeamId: number;
  awayTeamId: number;
  externalId: string | null;
}

/** Tonight's slate in our IDs, with each entity's ID in the source being asked. */
export interface Slate {
  slateDate: string;
  league: string;
  games: SlateGame[];
  teams: SlateTeam[];
  players: SlatePlayer[];
}

/**
 * Returns signals about players, teams and games (ADR-024). v1: ESPN.
 *
 * A context source that fails is reported and skipped; curation runs on the rest (ADR-024 rule 6).
 * Each is switched on and off by its own feature flag (ADR-018).
 */
export interface ContextSource {
  readonly name: string;
  /** `discover` runs over the whole slate; `enrich` is costly and runs on the shortlist only. */
  readonly stage: "discover" | "enrich";
  /** feature_flags key that turns this source on. */
  readonly flag: string;
  collect(slate: Slate): Promise<SignalDraft[]>;
}

// ---------------------------------------------------------------- curation

/**
 * Ranks stories and writes blurbs (ADR-024). v1: Claude, in STO-11, which also defines the
 * input and output. Declared here so the pipeline has one place that names the three kinds.
 */
export interface Curator<In = unknown, Out = unknown> {
  readonly name: string;
  curate(input: In): Promise<Out>;
}
