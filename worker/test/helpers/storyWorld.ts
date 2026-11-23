// A small made-up slate for the story step's integration tests: NY at TOR, with ESPN responses in the recorded shape
// (labels, events, seasonTypes for a game log; competitions for a schedule; the injuries feed). The recorded fixtures are for
// one team and can't produce a hot streak or a return on demand, so these builders write the same JSON shape from a few numbers.
// The detectors' maths is unit-tested on its own (storyDetectors.test.ts); this world only has to make each angle fire.

import { json, type Route } from "./mockFetch.js";

export const NY = 18, TOR = 28;                       // our team ids, and ESPN's (the same numbers here)
export const DAY = "2026-11-20";
export const GAME = "d0000000-0000-0000-0000-0000000000a1";

/** Players: our id, ESPN's id, team, and their shape. */
export const P = {
  HOT:    { id: "d0000000-0000-0000-0000-0000000000b1", espn: "9001", team: NY,  name: "Hot Hand" },
  HOTOUT: { id: "d0000000-0000-0000-0000-0000000000b2", espn: "9002", team: NY,  name: "Hot But Out" },
  RET:    { id: "d0000000-0000-0000-0000-0000000000b3", espn: "9003", team: TOR, name: "Just Back" },
  BACKUP: { id: "d0000000-0000-0000-0000-0000000000b4", espn: "9004", team: TOR, name: "Bench Guy" },
} as const;
export const STAR = { espn: "9005", team: TOR, name: "Star Out" };   // not on the slate (no market); listed Out

const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
const teamEvent = (team: number, i: number) => `${team}-g${i}`;
const N_GAMES = 10;

interface Row { game: number; min: number; pts: number; reb: number; ast: number; fg3m: number }

/** ESPN game-log JSON for `rows` (game numbers 1..10 on `team`'s schedule). */
export function gameLog(team: number, rows: Row[]) {
  const labels = ["MIN", "FG", "FG%", "3PT", "3P%", "FT", "FT%", "REB", "AST", "BLK", "STL", "PF", "TO", "PTS"];
  const events: Record<string, unknown> = {};
  const evs = rows.map((r) => {
    const id = teamEvent(team, r.game);
    events[id] = { id, gameDate: `${day(r.game)}T00:00:00.000+00:00`, atVs: r.game % 2 ? "vs" : "@", homeTeamId: String(team), awayTeamId: "99", gameResult: "W", opponent: { id: "99", abbreviation: "OPP" } };
    return { eventId: id, stats: [String(r.min), "0-0", "0.0", `${r.fg3m}-${r.fg3m + 1}`, "0.0", "0-0", "0.0", String(r.reb), String(r.ast), "0", "0", "0", "0", String(r.pts)] };
  });
  return { labels, events, seasonTypes: [{ displayName: "2026-27 Regular Season", categories: [{ displayName: "november", events: evs }] }] };
}

/** A team's schedule: games 1..10 final, regular season. */
export function schedule(team: number) {
  const side = (homeAway: string, id: number, abbr: string, score: number) => ({ homeAway, winner: false, score: { value: score, displayValue: String(score) }, team: { id: String(id), abbreviation: abbr } });
  return {
    events: Array.from({ length: N_GAMES }, (_, k) => k + 1).map((i) => ({
      id: teamEvent(team, i), date: `${day(i)}T23:00Z`, name: `game ${i}`, seasonType: { id: "2" },
      competitions: [{ status: { type: { name: "STATUS_FINAL" } }, competitors: [side("home", team, "HME", 100), side("away", 99, "OPP", 90)] }],
    })),
  };
}

export interface Hurt { team: number; athleteId: string; name: string; status: string }
export function injuries(entries: Hurt[]) {
  const teams = [...new Set(entries.map((e) => e.team))];
  return {
    injuries: teams.map((t) => ({
      id: String(t), displayName: `Team ${t}`,
      injuries: entries.filter((e) => e.team === t).map((e, i) => ({
        id: `${-(t * 100 + i)}`, status: e.status, date: `${DAY}T10:00Z`, shortComment: `${e.name} is ${e.status}`,
        athlete: { displayName: e.name, links: [{ rel: ["playercard", "desktop", "athlete"], href: `https://www.espn.com/nba/player/_/id/${e.athleteId}/x` }] },
      })),
    })),
  };
}

const all = (f: (g: number) => Partial<Row>): Row[] =>
  Array.from({ length: N_GAMES }, (_, k) => k + 1).map((game) => ({ game, min: 30, pts: 12, reb: 4, ast: 2, fg3m: 0, ...f(game) }));

/** Each player's log. HOT: 12 points a game, then 16 in his last three (+21% over a 13.2 average). RET: missed the last three. BACKUP: 15 minutes a game. */
export const LOGS: Record<string, ReturnType<typeof gameLog>> = {
  [P.HOT.espn]:    gameLog(NY, all((g) => ({ pts: g > 7 ? 16 : 12 }))),
  [P.HOTOUT.espn]: gameLog(NY, all((g) => ({ pts: g > 7 ? 16 : 12 }))),
  [P.RET.espn]:    gameLog(TOR, all(() => ({})).filter((r) => r.game <= 7)),
  [P.BACKUP.espn]: gameLog(TOR, all(() => ({ min: 15, pts: 6, reb: 2, ast: 1 }))),
  [STAR.espn]:     gameLog(TOR, all(() => ({ min: 34, pts: 25 }))),
};

export const HURT_TODAY: Hurt[] = [
  { team: NY, athleteId: P.HOTOUT.espn, name: P.HOTOUT.name, status: "Out" },
  { team: TOR, athleteId: STAR.espn, name: STAR.name, status: "Out" },
];

/** ESPN routes for the world. `over` replaces a route by name: "injuries", `schedule-18`, `gamelog-9001`. */
export const storyRoutes = (over: Record<string, () => Response> = {}): Route => (url) => {
  const hit = (k: string) => over[k]?.();
  const p = url.pathname;
  let m;
  if (url.hostname === "site.api.espn.com") {
    if (p.endsWith("/injuries")) return hit("injuries") ?? json(injuries(HURT_TODAY));
    if ((m = p.match(/\/teams\/(\d+)\/schedule$/))) return hit(`schedule-${m[1]}`) ?? json(schedule(Number(m[1])));
  }
  if (url.hostname === "site.web.api.espn.com" && (m = p.match(/\/athletes\/(\d+)\/gamelog$/))) {
    return hit(`gamelog-${m[1]}`) ?? (LOGS[m[1]!] ? json(LOGS[m[1]!]) : json({}, 404));
  }
  return undefined;
};
