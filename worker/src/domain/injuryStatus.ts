// The one place that says what an injury status means (STO-89) and which statuses exist (STO-81).
// Ingest and the ESPN source both ask here, so "who won't play" can't drift between them.
//
// The union is strict on purpose, but ESPN's list is undocumented and we have only recorded part of it.
// A string that isn't in the union becomes "Unknown" with the raw value kept (ADR-021 rule 3): it is
// treated as won't-play (safer to skip a player than to write form for someone who may not suit up),
// and callers report the raw value so we learn the new status. It never fails the row.

export const KNOWN_STATUSES = ["Out", "Doubtful", "Questionable", "Day-To-Day", "Probable"] as const;
export type KnownStatus = (typeof KNOWN_STATUSES)[number];

/**
 * Seen in real ESPN responses (Nov 2026 fixtures: the league injuries feed and two team rosters).
 * The rest of KNOWN_STATUSES are ESPN's NBA designations from memory and have NOT been seen in a response yet.
 */
export const SEEN_IN_REAL_RESPONSES: readonly KnownStatus[] = ["Out", "Day-To-Day"];

export interface InjuryStatus {
  status: KnownStatus | "Unknown";
  /** ESPN's own string, exactly as it came. */
  raw: string;
}

export function parseInjuryStatus(raw: string): InjuryStatus {
  const key = raw.trim().toLowerCase();
  const status = KNOWN_STATUSES.find((s) => s.toLowerCase() === key);
  return { status: status ?? "Unknown", raw };
}

/** Out, Doubtful and anything we don't recognise. No status at all means healthy. */
export function isWontPlay(s: InjuryStatus | null | undefined): boolean {
  return !!s && (s.status === "Out" || s.status === "Doubtful" || s.status === "Unknown");
}

// Worst first. Unknown sits between Out and Doubtful: as bad as we can't rule out.
const SEVERITY: InjuryStatus["status"][] = ["Out", "Unknown", "Doubtful", "Questionable", "Day-To-Day", "Probable"];

/** A player can have several injuries listed; what matters is the most severe, whatever order ESPN lists them in. Blank strings are ignored. */
export function mostSevere(raws: string[]): InjuryStatus | null {
  let worst: InjuryStatus | null = null;
  for (const raw of raws) {
    if (raw.trim() === "") continue;
    const s = parseInjuryStatus(raw);
    if (!worst || SEVERITY.indexOf(s.status) < SEVERITY.indexOf(worst.status)) worst = s;
  }
  return worst;
}

/**
 * For claims in a story ("his teammate is out"): only a status ESPN gave in words we know. Unknown is skipped for
 * form (isWontPlay) but can't headline a story, because we don't know what it says (ADR-014: every claim is grounded).
 */
export function isKnownWontPlay(s: InjuryStatus | null | undefined): boolean {
  return !!s && (s.status === "Out" || s.status === "Doubtful");
}
