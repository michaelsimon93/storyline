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
  type InjuryEntry, type Article,
} from "../domain/espnParse.js";
import { playerSignals, teamInjurySignals, seriesSignal, newsSignals } from "../domain/espnSignals.js";
import type { ContextSource, SignalDraft, Slate } from "./types.js";

export interface CollectStats {
  players: { fetched: number; skippedOutOrDoubtful: number; unmatched: number; failed: number };
  /** One line per failed call, for the alert. */
  failures: string[];
}

export interface EspnSourceOptions {
  /** feature_flags key that turns this source on. */
  flag: string;
  /** How many recent games the form signals cover (app_config). */
  windowGames: number;
  /** Minimum gap between ESPN calls (app_config). */
  pauseMs: number;
  fetchOpts?: FetchOptions;
  now?: () => Date;
  onStats?: (stats: CollectStats) => void;
}

/** ESPN's own words for a player who won't play. Compared case-insensitively. */
const WONT_PLAY = new Set(["out", "doubtful"]);

export function createEspnSource(opts: EspnSourceOptions): ContextSource {
  return {
    name: "espn",
    stage: "discover",
    flag: opts.flag,
    async collect(slate: Slate): Promise<SignalDraft[]> {
      const observedAt = (opts.now ?? (() => new Date()))().toISOString();
      const wait = throttle(opts.pauseMs);
      const stats: CollectStats = { players: { fetched: 0, skippedOutOrDoubtful: 0, unmatched: 0, failed: 0 }, failures: [] };
      let calls = 0;
      const drafts: SignalDraft[] = [];

      /** One ESPN call, parsed. A failure of any kind is recorded and returns undefined. */
      const get = async <T>(label: string, url: string, parse: (raw: unknown) => T): Promise<T | undefined> => {
        calls++;
        await wait();
        try {
          return parse(await fetchJson<unknown>(url, opts.fetchOpts));
        } catch (e) {
          stats.failures.push(`${label}: ${(e as Error).message}`);
          return undefined;
        }
      };

      const teamByEspn: Record<string, number> = {};
      for (const t of slate.teams) if (t.externalId) teamByEspn[t.externalId] = t.id;

      // League injuries: one call a day covers every team.
      let injuries = new Map<string, InjuryEntry[]>();
      if (slate.teams.length > 0) {
        injuries = (await get("injuries", `${BASE}/injuries`, parseInjuries)) ?? injuries;
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
          const games = parseSchedule(raw);
          for (const x of games) { abbr[x.homeId] = x.homeAbbr; abbr[x.awayId] = x.awayAbbr; }
          return games;
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

      // Per player: form and home/road split, both from the one game-log call. Out and Doubtful players aren't playing, so form tells us nothing.
      for (const p of slate.players) {
        if (p.injuryStatus && WONT_PLAY.has(p.injuryStatus.toLowerCase())) { stats.players.skippedOutOrDoubtful++; continue; }
        if (!p.externalId) { stats.players.unmatched++; continue; } // never invent a match
        const before = stats.failures.length;
        const log = await get(`gamelog ${p.externalId}`, `${WEB_BASE}/athletes/${p.externalId}/gamelog`, parseGameLog);
        if (stats.failures.length > before) stats.players.failed++;
        if (!log) continue;
        stats.players.fetched++;
        drafts.push(...playerSignals({ playerId: p.id, espnId: p.externalId, log, windowGames: opts.windowGames, observedAt }));
      }

      opts.onStats?.(stats);
      if (drafts.length === 0 && stats.failures.length > 0) {
        throw new Error(`ESPN down: ${stats.failures.length} of ${calls} calls failed, first: ${stats.failures[0]}`);
      }
      return drafts;
    },
  };
}
