// Player-name matching between Kalshi (display name in market titles) and ESPN
// (roster names). Matching is always scoped to a single team, which keeps it
// both simple and safe: two players with similar names on one roster is rare.

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/** "Nikola Jokić" → "nikola jokic"; "Jaren Jackson Jr." → "jaren jackson"; "T.J. McConnell" → "tj mcconnell" */
export function normalizeName(name: string): string {
  const tokens = name
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/[.'’]/g, "")                             // T.J. → tj, O'Neale → oneale
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(" ");
}

export interface RosterPlayer {
  espnId: string;
  fullName: string;
}

export type MatchResult =
  | { kind: "exact"; player: RosterPlayer }
  | { kind: "fuzzy"; player: RosterPlayer }   // unique last-name + first-initial match
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: RosterPlayer[] };

/** Match a Kalshi name against one team's ESPN roster. */
export function matchPlayer(kalshiName: string, roster: RosterPlayer[]): MatchResult {
  const target = normalizeName(kalshiName);

  const exact = roster.filter((p) => normalizeName(p.fullName) === target);
  if (exact.length === 1) return { kind: "exact", player: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  // Fallback: same last name and first initial (handles "Nic" vs "Nicolas").
  const t = target.split(" ");
  const first = t[0]?.[0];
  const last = t[t.length - 1];
  const fuzzy = roster.filter((p) => {
    const n = normalizeName(p.fullName).split(" ");
    return n[n.length - 1] === last && n[0]?.[0] === first;
  });
  if (fuzzy.length === 1) return { kind: "fuzzy", player: fuzzy[0]! };
  if (fuzzy.length > 1) return { kind: "ambiguous", candidates: fuzzy };
  return { kind: "none" };
}
