// Builds a Slate (types.ts) from the database: tonight's games, their teams, and the players with
// a market tonight, each with its ID in the source being asked (external_ids, ADR-021).
// "On the slate" means what ingest means: a player who has a market in one of tonight's games.

import type { Db } from "../lib/db.js";
import type { Slate } from "./types.js";
import { parseInjuryStatus } from "../domain/injuryStatus.js";

/** Games that won't be played tonight have no use for form or news. */
const NOT_PLAYING = ["postponed", "canceled"];

export async function loadSlate(db: Db, slateDate: string, league: string, source: string): Promise<Slate> {
  const games = await db.query<{ id: string; home: number; away: number; ext: string | null }>(
    `select g.id, g.home_team_id as home, g.away_team_id as away, x.external_id as ext
       from games g
       left join external_ids x on x.game_id = g.id and x.source = $3 and x.kind = 'game'
      where g.league = $1 and g.slate_date = $2::date and g.status <> all($4::game_status[])
      order by g.tip_off_at, g.id`,
    [league, slateDate, source, NOT_PLAYING]);
  const teamIds = [...new Set(games.rows.flatMap((g) => [g.home, g.away]))];

  const teams = await db.query<{ id: number; ext: string | null }>(
    `select t.id, x.external_id as ext
       from teams t left join external_ids x on x.team_id = t.id and x.source = $2 and x.kind = 'team'
      where t.id = any($1::smallint[]) order by t.id`,
    [teamIds, source]);

  const players = await db.query<{ id: string; name: string; team_id: number; ext: string | null; injury: string | null }>(
    `select p.id, p.full_name as name, p.team_id, x.external_id as ext, p.injury_status as injury
       from players p
       left join external_ids x on x.player_id = p.id and x.source = $3 and x.kind = 'player'
      where p.id in (select m.player_id from markets m join games g on g.id = m.game_id
                      where g.league = $1 and g.slate_date = $2::date and g.status <> all($4::game_status[])
                        and m.player_id is not null)
      order by p.id`,
    [league, slateDate, source, NOT_PLAYING]);

  return {
    slateDate, league,
    games: games.rows.map((g) => ({ id: g.id, homeTeamId: g.home, awayTeamId: g.away, externalId: g.ext })),
    teams: teams.rows.map((t) => ({ id: t.id, externalId: t.ext })),
    players: players.rows.map((p) => ({ id: p.id, name: p.name, teamId: p.team_id, externalId: p.ext, injuryStatus: p.injury ? parseInjuryStatus(p.injury) : null })),
  };
}
