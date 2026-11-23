// What the story detectors read from ESPN (STO-76): today's injuries, each slate team's finished games, and the game logs of
// everyone a story could be about, plus teammates who are out (the "backup stepping in" angle needs their minutes).
// Only the worker calls ESPN (ADR-003). The raw logs aren't stored by the context pull (it stores only summarised signals),
// so the story step fetches them itself. Pacing and the outage rule are the same settings as the context pull's.
//
// Failure rules (same as the context pull): one failed call is counted and skipped; too many in a row stops, and if nothing
// useful came back the call throws "ESPN down". A story that couldn't be checked is never guessed at: the detectors fail
// closed on missing data.

import { fetchJson, throttle, type FetchOptions } from "../lib/http.js";
import { BASE, WEB_BASE } from "./espn.js";
import { parseGameLog, parseInjuries, parseSchedule, type GameLogRow, type FinishedGame, type InjuryEntry, type Parsed } from "../domain/espnParse.js";
import { isKnownWontPlay, isWontPlay, mostSevere, type InjuryStatus } from "../domain/injuryStatus.js";
import type { Slate } from "./types.js";

export interface StoryInputs {
  /** False if the injuries feed didn't load: then nobody's status from it is known, and ingest's stands in. */
  feedOk: boolean;
  /** ESPN athlete id → most severe status across all their injuries today. Absent = healthy (only if feedOk). */
  statusByAthlete: Map<string, InjuryStatus>;
  /** Our team id → today's injury entries, for finding teammates who are out. */
  injuriesByTeam: Map<number, InjuryEntry[]>;
  /** Our team id → its finished regular-season games. */
  teamGames: Map<number, FinishedGame[]>;
  /** ESPN athlete id → regular-season game log, newest first. */
  logs: Map<string, GameLogRow[]>;
  calls: number;
  failures: string[];
  skippedRows: string[];
  unknownStatuses: string[];
}

export interface StoryInputOptions {
  pauseMs: number;
  maxConsecutiveFailures: number;
  fetchOpts?: FetchOptions;
}

/** A slate player's status tonight: the fresh feed when it loaded (absent = healthy), else what ingest stored. */
export function tonightStatus(p: { externalId: string | null; injuryStatus: InjuryStatus | null }, inputs: Pick<StoryInputs, "feedOk" | "statusByAthlete">): InjuryStatus | null {
  return inputs.feedOk && p.externalId ? (inputs.statusByAthlete.get(p.externalId) ?? null) : p.injuryStatus;
}

export async function collectStoryInputs(slate: Slate, opts: StoryInputOptions): Promise<StoryInputs> {
  if (!Number.isFinite(opts.pauseMs) || opts.pauseMs < 0) throw new Error(`pauseMs must be >= 0, got ${opts.pauseMs}`);
  if (!Number.isInteger(opts.maxConsecutiveFailures) || opts.maxConsecutiveFailures < 1) throw new Error(`maxConsecutiveFailures must be a positive integer, got ${opts.maxConsecutiveFailures}`);
  const wait = throttle(opts.pauseMs);
  const out: StoryInputs = {
    feedOk: false, statusByAthlete: new Map(), injuriesByTeam: new Map(), teamGames: new Map(), logs: new Map(),
    calls: 0, failures: [], skippedRows: [], unknownStatuses: [],
  };
  let inARow = 0, aborted = false;

  const get = async <T>(label: string, url: string, parse: (raw: unknown) => Parsed<T>): Promise<T | undefined> => {
    if (aborted) return undefined;
    out.calls++;
    await wait();
    try {
      const { rows, skipped } = parse(await fetchJson<unknown>(url, opts.fetchOpts));
      out.skippedRows.push(...skipped.map((s) => `${label}: ${s}`));
      inARow = 0;
      return rows;
    } catch (e) {
      out.failures.push(`${label}: ${(e as Error).message}`);
      if (++inARow >= opts.maxConsecutiveFailures) aborted = true;
      return undefined;
    }
  };

  const teamByEspn = new Map<string, number>();
  for (const t of slate.teams) if (t.externalId) teamByEspn.set(t.externalId, t.id);

  // Today's injuries, league-wide: one call.
  const feed = await get("injuries", `${BASE}/injuries`, parseInjuries);
  if (feed) {
    out.feedOk = true;
    const byAthlete = new Map<string, string[]>();
    for (const [espnTeam, entries] of feed) {
      const ours = teamByEspn.get(espnTeam);
      if (ours !== undefined) out.injuriesByTeam.set(ours, entries);
      for (const e of entries) byAthlete.set(e.athleteId, [...(byAthlete.get(e.athleteId) ?? []), e.status]);
    }
    for (const [id, raws] of byAthlete) { const s = mostSevere(raws); if (s) out.statusByAthlete.set(id, s); }
  }

  // Each slate team's finished games.
  for (const [espnTeam, ours] of teamByEspn) {
    const games = await get(`schedule ${espnTeam}`, `${BASE}/teams/${espnTeam}/schedule`, parseSchedule);
    if (games) out.teamGames.set(ours, games);
  }

  // Game logs for: slate players who may play (a story about a player who won't is dropped anyway, so we don't fetch his),
  // and teammates listed Out or Doubtful on a slate team (their minutes are what a backup inherits).
  const wanted = new Map<string, string>();   // ESPN athlete id → label
  for (const p of slate.players) {
    if (!p.externalId) continue;
    const status = tonightStatus(p, out);
    if (status?.status === "Unknown") out.unknownStatuses.push(`${p.name}: ${JSON.stringify(status.raw)}`);
    if (!isWontPlay(status)) wanted.set(p.externalId, p.name);
  }
  for (const entries of out.injuriesByTeam.values()) {
    for (const e of entries) {
      const s = out.statusByAthlete.get(e.athleteId);
      if (isKnownWontPlay(s)) wanted.set(e.athleteId, e.name);
    }
  }
  for (const [id, name] of [...wanted].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (aborted) break;
    const log = await get(`gamelog ${id} (${name})`, `${WEB_BASE}/athletes/${id}/gamelog`, parseGameLog);
    if (log) out.logs.set(id, log);
  }

  if (aborted) throw new Error(`ESPN down: stopped after ${opts.maxConsecutiveFailures} failed calls in a row (${out.calls} calls made), first: ${out.failures[0]}`);
  if (out.logs.size === 0 && out.failures.length > 0) throw new Error(`ESPN down: ${out.failures.length} of ${out.calls} calls failed, first: ${out.failures[0]}`);
  return out;
}
