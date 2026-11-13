// Kalshi and ESPN use different abbreviations for 5 of the 30 NBA teams.
// Verified against live Kalshi tickers and the ESPN scoreboard on 2026-11-13.

export interface TeamCodes {
  kalshi: string;
  espn: string;
}

export const NBA_TEAMS: readonly TeamCodes[] = [
  { kalshi: "ATL", espn: "ATL" }, { kalshi: "BOS", espn: "BOS" }, { kalshi: "BKN", espn: "BKN" },
  { kalshi: "CHA", espn: "CHA" }, { kalshi: "CHI", espn: "CHI" }, { kalshi: "CLE", espn: "CLE" },
  { kalshi: "DAL", espn: "DAL" }, { kalshi: "DEN", espn: "DEN" }, { kalshi: "DET", espn: "DET" },
  { kalshi: "GSW", espn: "GS" },  { kalshi: "HOU", espn: "HOU" }, { kalshi: "IND", espn: "IND" },
  { kalshi: "LAC", espn: "LAC" }, { kalshi: "LAL", espn: "LAL" }, { kalshi: "MEM", espn: "MEM" },
  { kalshi: "MIA", espn: "MIA" }, { kalshi: "MIL", espn: "MIL" }, { kalshi: "MIN", espn: "MIN" },
  { kalshi: "NOP", espn: "NO" },  { kalshi: "NYK", espn: "NY" },  { kalshi: "OKC", espn: "OKC" },
  { kalshi: "ORL", espn: "ORL" }, { kalshi: "PHI", espn: "PHI" }, { kalshi: "PHX", espn: "PHX" },
  { kalshi: "POR", espn: "POR" }, { kalshi: "SAC", espn: "SAC" }, { kalshi: "SAS", espn: "SA" },
  { kalshi: "TOR", espn: "TOR" }, { kalshi: "UTA", espn: "UTAH" }, { kalshi: "WAS", espn: "WSH" },
];

const byEspn = new Map(NBA_TEAMS.map((t) => [t.espn, t]));
const byKalshi = new Map(NBA_TEAMS.map((t) => [t.kalshi, t]));

export function kalshiFromEspn(espnAbbr: string): string {
  const t = byEspn.get(espnAbbr);
  if (!t) throw new Error(`Unknown ESPN team abbreviation: ${espnAbbr}`);
  return t.kalshi;
}

export function isKalshiTeam(abbr: string): boolean {
  return byKalshi.has(abbr);
}
