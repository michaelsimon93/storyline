// Each NBA team's short code: ours (`abbr`, the NBA's official abbreviation, shown in the app),
// and what Kalshi and ESPN call it. Kalshi and ESPN differ for 5 of the 30 teams.
// Verified against live Kalshi tickers and the ESPN scoreboard on 2026-11-13.

export interface TeamCodes {
  /** Storyline's own code for the team (teams.abbr). Independent of any provider. */
  abbr: string;
  kalshi: string;
  espn: string;
}

export const NBA_TEAMS: readonly TeamCodes[] = [
  { abbr: "ATL", kalshi: "ATL", espn: "ATL" }, { abbr: "BOS", kalshi: "BOS", espn: "BOS" }, { abbr: "BKN", kalshi: "BKN", espn: "BKN" },
  { abbr: "CHA", kalshi: "CHA", espn: "CHA" }, { abbr: "CHI", kalshi: "CHI", espn: "CHI" }, { abbr: "CLE", kalshi: "CLE", espn: "CLE" },
  { abbr: "DAL", kalshi: "DAL", espn: "DAL" }, { abbr: "DEN", kalshi: "DEN", espn: "DEN" }, { abbr: "DET", kalshi: "DET", espn: "DET" },
  { abbr: "GSW", kalshi: "GSW", espn: "GS" },  { abbr: "HOU", kalshi: "HOU", espn: "HOU" }, { abbr: "IND", kalshi: "IND", espn: "IND" },
  { abbr: "LAC", kalshi: "LAC", espn: "LAC" }, { abbr: "LAL", kalshi: "LAL", espn: "LAL" }, { abbr: "MEM", kalshi: "MEM", espn: "MEM" },
  { abbr: "MIA", kalshi: "MIA", espn: "MIA" }, { abbr: "MIL", kalshi: "MIL", espn: "MIL" }, { abbr: "MIN", kalshi: "MIN", espn: "MIN" },
  { abbr: "NOP", kalshi: "NOP", espn: "NO" },  { abbr: "NYK", kalshi: "NYK", espn: "NY" },  { abbr: "OKC", kalshi: "OKC", espn: "OKC" },
  { abbr: "ORL", kalshi: "ORL", espn: "ORL" }, { abbr: "PHI", kalshi: "PHI", espn: "PHI" }, { abbr: "PHX", kalshi: "PHX", espn: "PHX" },
  { abbr: "POR", kalshi: "POR", espn: "POR" }, { abbr: "SAC", kalshi: "SAC", espn: "SAC" }, { abbr: "SAS", kalshi: "SAS", espn: "SA" },
  { abbr: "TOR", kalshi: "TOR", espn: "TOR" }, { abbr: "UTA", kalshi: "UTA", espn: "UTAH" }, { abbr: "WAS", kalshi: "WAS", espn: "WSH" },
];

const byEspn = new Map(NBA_TEAMS.map((t) => [t.espn, t]));
const byKalshi = new Map(NBA_TEAMS.map((t) => [t.kalshi, t]));

export function abbrFromEspn(espnAbbr: string): string {
  const t = byEspn.get(espnAbbr);
  if (!t) throw new Error(`Unknown ESPN team abbreviation: ${espnAbbr}`);
  return t.abbr;
}

export function kalshiFromEspn(espnAbbr: string): string {
  const t = byEspn.get(espnAbbr);
  if (!t) throw new Error(`Unknown ESPN team abbreviation: ${espnAbbr}`);
  return t.kalshi;
}

export function isKalshiTeam(abbr: string): boolean {
  return byKalshi.has(abbr);
}
