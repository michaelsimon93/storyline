// ESPN as a ContextSource (ADR-024): signals for everyone on the slate who is playing.
// Only the worker calls ESPN (ADR-003). Nothing here is a default: the flag key, window size
// and call pacing are passed in, from feature_flags / app_config by the runner (ADR-018).
//
// Failure rules (decided Nov 17): one failed call is counted and skipped, so a few bad players
// still leave a useful pull. If nothing at all came back the source throws, which the runner
// treats as "ESPN down" and answers with the fallback.

import { fetchJson, throttle, type FetchOptions } from "../lib/http.js";
import { BASE, WEB_BASE } from "./espn.js";
import {
  parseGameLog, parseInjuries, parseSchedule, parseNews,
  type InjuryEntry, type Article, type Parsed,
} from "../domain/espnParse.js";
import { playerSignals, teamInjurySignals, seriesSignal, newsSignals } from "../domain/espnSignals.js";
import { isWontPlay, mostSevere, type InjuryStatus } from "../domain/injuryStatus.js";
import type { ContextSource, SignalDraft, Slate } from "./types.js";

export interface CollectStats {
  players: { fetched: number; skippedWontPlay: number; unmatched: number; failed: number };
  /** Injury statuses we have no name for, as `player: "raw"`. Treated as won't-play; the runner alerts so we learn the new status. */
  unknownStatuses: string[];
  /** One line per failed call, for the alert. */
  failures: string[];
  /** One line per row a parser skipped inside an otherwise good response (a degraded pull, not a failed call). */
  skippedRows: string[];
}

export interface EspnSourceOptions {
  /** feature_flags key that turns this source on. */
  flag: string;
  /** How many recent games the form signals cover (app_config). */
  windowGames: number;
  /** Minimum gap between ESPN calls (app_config). */
  pauseMs: number;
  /** Stop and call ESPN down after this many failed calls in a row (app_config), so an outage fails in minutes, not after hundreds of slow retries. */
  maxConsecutiveFailures: number;
  fetchOpts?: FetchOptions;
  now?: () => Date;
  onStats?: (stats: CollectStats) => void;
}

export function createEspnSource(opts: EspnSourceOptions): ContextSource {
  // Config comes from the database in 3b; a bad value must stop here, not turn into `slice(0, -1)`.
  if (!Number.isInteger(opts.windowGames) || opts.windowGames < 1) throw new Error(`windowGames must be a positive integer, got ${opts.windowGames}`);
  if (!Number.isFinite(opts.pauseMs) || opts.pauseMs < 0) throw new Error(`pauseMs must be >= 0, got ${opts.pauseMs}`);
  if (!Number.isInteger(opts.maxConsecutiveFailures) || opts.maxConsecutiveFailures < 1) throw new Error(`maxConsecutiveFailures must be a positive integer, got ${opts.maxConsecutiveFailures}`);

  return {
    name: "espn",
    stage: "discover",
    flag: opts.flag,
    async collect(slate: Slate): Promise<SignalDraft[]> {
      const observedAt = (opts.now ?? (() => new Date()))().toISOString();
      const wait = throttle(opts.pauseMs);
      const stats: CollectStats = { players: { fetched: 0, skippedWontPlay: 0, unmatched: 0, failed: 0 }, unknownStatuses: [], failures: [], skippedRows: [] };
      let calls = 0, inARow = 0, aborted = false;
      const drafts: SignalDraft[] = [];

      /** One ESPN call, parsed. A failure of any kind is recorded and returns undefined; too many in a row stops all further calls. */
      const get = async <T>(label: string, url: string, parse: (raw: unknown) => Parsed<T>): Promise<T | undefined> => {
        if (aborted) return undefined;
        calls++;
        await wait();
        try {
          const { rows, skipped } = parse(await fetchJson<unknown>(url, opts.fetchOpts));
          stats.skippedRows.push(...skipped.map((s) => `${label}: ${s}`));
          inARow = 0;
          return rows;
        } catch (e) {
          stats.failures.push(`${label}: ${(e as Error).message}`);
          if (++inARow >= opts.maxConsecutiveFailures) aborted = true;
          return undefined;
        }
      };

      const teamByEspn: Record<string, number> = {};
      for (const t of slate.teams) if (t.externalId) teamByEspn[t.externalId] = t.id;

      // League injuries: one call a day covers every team.
      let injuries = new Map<string, InjuryEntry[]>();
      let feedOk = false; // an empty feed that loaded means "nobody is hurt"; a failed one means "we don't know"
      if (slate.teams.length > 0) {
        const feed = await get("injuries", `${BASE}/injuries`, parseInjuries);
        if (feed) { injuries = feed; feedOk = true; }
        for (const [espnId, teamId] of Object.entries(teamByEspn)) {
          drafts.push(...teamInjurySignals({ teamId, entries: injuries.get(espnId) ?? [], observedAt }));
        }
      }

      // Per game: season series from the away team's schedule, news from both teams' feeds.
      for (const g of slate.games) {
        const home = slate.teams.find((t) => t.id === g.homeTeamId)?.externalId;
        const away = slate.teams.find((t) => t.id === g.awayTeamId)?.externalId;
        if (!home || !away) { stats.failures.push(`game ${g.id}: a team has no ESPN id`); continue; }
        const abbr = {} as Record<string, string>;
        const schedule = await get(`schedule ${away}`, `${BASE}/teams/${away}/schedule`, (raw) => {
          const parsed = parseSchedule(raw);
          for (const x of parsed.rows) { abbr[x.homeId] = x.homeAbbr; abbr[x.awayId] = x.awayAbbr; }
          return parsed;
        });
        if (schedule && abbr[home] && abbr[away]) {
          const s = seriesSignal({ gameId: g.id, teamA: { espnId: away, abbr: abbr[away]! }, teamB: { espnId: home, abbr: abbr[home]! }, games: schedule, observedAt });
          if (s) drafts.push(s);
        }
        const articles: Article[] = [];
        for (const t of [home, away]) {
          articles.push(...((await get(`news team ${t}`, `${BASE}/news?team=${t}`, parseNews)) ?? []));
        }
        drafts.push(...newsSignals({ articles, game: { id: g.id, homeEspnId: home, awayEspnId: away }, teamIds: teamByEspn, observedAt }));
      }

      // Today's status per athlete, across all their injuries (STO-90). Ingest stored only a first injury, at ingest time.
      const feedStatus = new Map<string, InjuryStatus>();
      if (feedOk) {
        const byAthlete = new Map<string, string[]>();
        for (const entries of injuries.values()) for (const e of entries) byAthlete.set(e.athleteId, [...(byAthlete.get(e.athleteId) ?? []), e.status]);
        for (const [id, raws] of byAthlete) { const w = mostSevere(raws); if (w) feedStatus.set(id, w); }
      }

      // Per player: form and home/road split, both from the one game-log call. Players who won't play tell us nothing.
      for (const p of slate.players) {
        if (aborted) break;
        // The fresh feed is authoritative when it loaded (absent = healthy, even if ingest said Out this morning).
        // That includes a player whose feed row the parser skipped (no athlete id): he reads as healthy. Accepted:
        // the skipped row makes the pull "degraded", which alerts (see contextEspn.ts).
        // Without it, or for a player we can't look up, ingest's status is the best we have.
        const status = feedOk && p.externalId ? (feedStatus.get(p.externalId) ?? null) : p.injuryStatus;
        if (status?.status === "Unknown") stats.unknownStatuses.push(`${p.name}: ${JSON.stringify(status.raw)}`);
        if (isWontPlay(status)) { stats.players.skippedWontPlay++; continue; }
        if (!p.externalId) { stats.players.unmatched++; continue; } // never invent a match
        const before = stats.failures.length;
        const log = await get(`gamelog ${p.externalId}`, `${WEB_BASE}/athletes/${p.externalId}/gamelog`, parseGameLog);
        if (stats.failures.length > before) stats.players.failed++;
        if (!log) continue;
        stats.players.fetched++;
        drafts.push(...playerSignals({ playerId: p.id, espnId: p.externalId, log, windowGames: opts.windowGames, observedAt }));
      }

      opts.onStats?.(stats);
      if (aborted) {
        throw new Error(`ESPN down: stopped after ${opts.maxConsecutiveFailures} failed calls in a row (${calls} calls made), first: ${stats.failures[0]}`);
      }
      if (drafts.length === 0 && stats.failures.length > 0) {
        throw new Error(`ESPN down: ${stats.failures.length} of ${calls} calls failed, first: ${stats.failures[0]}`);
      }
      return drafts;
    },
  };
}
