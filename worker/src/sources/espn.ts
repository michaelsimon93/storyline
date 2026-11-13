// ESPN's public site API (undocumented: see ADR-005). Every response is shape-checked,
// so a breaking change fails loudly instead of writing bad data.

import { fetchJson } from "../lib/http.js";
import type { RosterPlayer } from "../domain/names.js";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

export interface EspnTeam {
  espnId: string;
  abbr: string;
  name: string;
}

export interface EspnGame {
  eventId: string;
  startsAt: string; // ISO UTC
  status: "scheduled" | "in_progress" | "final" | "postponed" | "canceled";
  home: EspnTeam;
  away: EspnTeam;
  broadcasts: { market: string; names: string[] }[];
}

export interface EspnRosterPlayer extends RosterPlayer {
  injuryStatus: string | null; // "Out", "Day-To-Day", ...
  headshotUrl: string | null;
}

function mapStatus(name: string): EspnGame["status"] {
  switch (name) {
    case "STATUS_SCHEDULED": return "scheduled";
    case "STATUS_IN_PROGRESS": case "STATUS_HALFTIME": case "STATUS_END_PERIOD": return "in_progress";
    case "STATUS_FINAL": return "final";
    case "STATUS_POSTPONED": return "postponed";
    case "STATUS_CANCELED": return "canceled";
    default: return "scheduled";
  }
}

function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`ESPN response missing ${what}`);
  return v;
}

/** Games on an ET calendar date (YYYY-MM-DD). */
export async function getGames(isoDate: string): Promise<EspnGame[]> {
  const data = await fetchJson<any>(`${BASE}/scoreboard?dates=${isoDate.replaceAll("-", "")}`);
  const events = must<any[]>(data.events, "events");

  return events.map((e) => {
    const comp = must<any>(e.competitions?.[0], "competition");
    const team = (side: "home" | "away"): EspnTeam => {
      const c = must<any>(comp.competitors?.find((x: any) => x.homeAway === side), `${side} competitor`);
      return { espnId: String(c.team.id), abbr: must(c.team.abbreviation, "team abbr"), name: c.team.displayName };
    };
    return {
      eventId: String(must(e.id, "event id")),
      startsAt: must(e.date, "event date"),
      status: mapStatus(e.status?.type?.name ?? ""),
      home: team("home"),
      away: team("away"),
      broadcasts: (comp.broadcasts ?? []).map((b: any) => ({ market: b.market, names: b.names ?? [] })),
    };
  });
}

export async function getRoster(teamEspnId: string): Promise<EspnRosterPlayer[]> {
  const data = await fetchJson<any>(`${BASE}/teams/${teamEspnId}/roster`);
  const athletes = must<any[]>(data.athletes, "roster athletes");
  return athletes.map((a) => ({
    espnId: String(must(a.id, "athlete id")),
    fullName: must(a.fullName, "athlete name"),
    injuryStatus: a.injuries?.[0]?.status ?? null,
    headshotUrl: a.headshot?.href ?? null,
  }));
}
