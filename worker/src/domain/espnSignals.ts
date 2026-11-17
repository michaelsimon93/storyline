// Turns parsed ESPN rows into SignalDrafts (ADR-024 rule 2). Pure: the clock comes in as `observedAt`.
// A key names the fact and never the run, so a re-run reports the same signal (see store_signals).

import type { SignalDraft } from "../sources/types.js";
import type { GameLogRow, InjuryEntry, FinishedGame, Article } from "./espnParse.js";

const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
const day = (iso: string) => iso.slice(0, 10);

const STATS: { key: string; label: string; pick: (r: GameLogRow) => number }[] = [
  { key: "pts", label: "PTS", pick: (r) => r.pts },
  { key: "reb", label: "REB", pick: (r) => r.reb },
  { key: "ast", label: "AST", pick: (r) => r.ast },
  { key: "3pm", label: "3PM", pick: (r) => r.fg3m },
];

export function playerSignals(a: {
  playerId: string; espnId: string;
  log: GameLogRow[]; windowGames: number; observedAt: string;
}): SignalDraft[] {
  const subject = { kind: "player", id: a.playerId } as const;
  const url = `https://www.espn.com/nba/player/gamelog/_/id/${a.espnId}`;
  const out: SignalDraft[] = [];
  const recent = a.log.slice(0, a.windowGames); // newest first
  if (recent.length > 0) {
    const n = recent.length;
    for (const s of STATS) {
      const vals = recent.map(s.pick);
      out.push({
        kind: "stat", subject, key: `form:${s.key}`, trust: "verified",
        summary: `Last ${n} ${n === 1 ? "game" : "games"}: ${avg(vals)} ${s.label} (${vals.join(", ")})`,
        evidence: { url, quote: `ESPN game log, ${recent.map((r) => day(r.date)).join(", ")}: ${vals.join(", ")} ${s.label}`, observedAt: a.observedAt },
      });
    }
  }
  // Home/road comes from the same game log (`atVs`), so it costs no extra call.
  const side = (home: boolean) => a.log.filter((r) => r.home === home);
  const [home, road] = [side(true), side(false)];
  if (home.length > 0 && road.length > 0) {
    const fmt = (rows: GameLogRow[]) => `${avg(rows.map((r) => r.pts))} PTS, ${avg(rows.map((r) => r.reb))} REB, ${avg(rows.map((r) => r.ast))} AST in ${rows.length} GP`;
    out.push({
      kind: "stat", subject, key: "split:home-road", trust: "verified",
      summary: `Home: ${fmt(home)}. Road: ${fmt(road)}.`,
      evidence: { url, quote: `ESPN game log, season: home ${fmt(home)}; road ${fmt(road)}`, observedAt: a.observedAt },
    });
  }
  return out;
}

export function teamInjurySignals(a: { teamId: number; entries: InjuryEntry[]; observedAt: string }): SignalDraft[] {
  return a.entries.map((e) => ({
    kind: "injury", subject: { kind: "team", id: a.teamId }, key: `injury:${e.athleteId}`, trust: "verified",
    summary: `${e.name} (${e.status})${e.comment ? `: ${e.comment}` : ""}`,
    evidence: { url: "https://www.espn.com/nba/injuries", quote: e.comment || `${e.name} listed ${e.status}`, observedAt: a.observedAt },
  }));
}

/** Season record between two teams from one team's finished games. None if they haven't met. */
export function seriesSignal(a: {
  gameId: string; teamA: { espnId: string; abbr: string }; teamB: { espnId: string; abbr: string };
  games: FinishedGame[]; observedAt: string;
}): SignalDraft | undefined {
  const met = a.games
    .filter((g) => [g.homeId, g.awayId].sort().join() === [a.teamA.espnId, a.teamB.espnId].sort().join())
    .sort((x, y) => (x.date < y.date ? -1 : 1));
  if (met.length === 0) return undefined;
  let winsA = 0, winsB = 0;
  const lines = met.map((g) => {
    const winner = g.homeScore > g.awayScore ? g.homeId : g.awayId;
    if (winner === a.teamA.espnId) winsA++; else winsB++;
    return `${day(g.date)}: ${g.awayAbbr} ${g.awayScore} @ ${g.homeAbbr} ${g.homeScore}`;
  });
  const record = winsA === winsB ? `tied ${winsA}-${winsB}`
    : winsA > winsB ? `${a.teamA.abbr} leads ${winsA}-${winsB}` : `${a.teamB.abbr} leads ${winsB}-${winsA}`;
  return {
    kind: "stat", subject: { kind: "game", id: a.gameId }, key: "series:season", trust: "verified",
    summary: `Season series: ${record} (${lines.join("; ")})`,
    evidence: { quote: `ESPN schedule results: ${lines.join("; ")}`, observedAt: a.observedAt },
  };
}

/**
 * An article tagged to both of tonight's teams, and no others, belongs to the game; tagged to just
 * one of them, to that team. Anything tagged to other teams (a league roundup) is about nobody
 * in particular and is dropped. Deduped by article id, since both teams' feeds carry the same pieces.
 * Dedup is per game on purpose: a team plays once a day, so one article can't qualify for two games.
 */
export function newsSignals(a: {
  articles: Article[]; game: { id: string; homeEspnId: string; awayEspnId: string };
  teamIds: Record<string, number>; observedAt: string;
}): SignalDraft[] {
  const pair = new Set([a.game.homeEspnId, a.game.awayEspnId]);
  const seen = new Set<string>();
  const out: SignalDraft[] = [];
  for (const art of a.articles) {
    if (seen.has(art.id) || art.teamIds.length === 0 || !art.teamIds.every((t) => pair.has(t))) continue;
    seen.add(art.id);
    const tags = new Set(art.teamIds);
    const only = tags.size === 1 ? a.teamIds[[...tags][0]!] : undefined;
    if (tags.size === 1 && only === undefined) continue;
    out.push({
      kind: "news", key: `news:${art.id}`, trust: "verified",
      subject: tags.size === 2 ? { kind: "game", id: a.game.id } : { kind: "team", id: only! },
      summary: `${art.type}: ${art.headline} (${day(art.published)})`,
      evidence: { url: art.url, observedAt: a.observedAt },
    });
  }
  return out;
}
