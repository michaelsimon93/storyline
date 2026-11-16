// Players, teams and games with their provider IDs joined back on, under the column names they
// had before ADR-021 moved them to external_ids (STO-39). Lets tests written against the old
// columns keep their assertions word for word: only the FROM clause changes.

const id = (alias: string, source: string, kind: string, col: string) =>
  `left join external_ids ${alias} on ${alias}.${col} = t.id and ${alias}.source = '${source}' and ${alias}.kind = '${kind}'`;

export const PLAYERS = `(select t.*, e.external_id as espn_athlete_id, k.external_id as kalshi_player_id from players t
  ${id("e", "espn", "player", "player_id")} ${id("k", "kalshi", "player", "player_id")}) players`;

export const TEAMS = (alias: string) => `(select t.*, k.external_id as kalshi_abbr, e.external_id as espn_id from teams t
  ${id("e", "espn", "team", "team_id")} ${id("k", "kalshi", "team", "team_id")}) ${alias}`;

export const GAMES = (alias: string) => `(select t.*, e.external_id as espn_event_id, k.external_id as kalshi_game_key from games t
  ${id("e", "espn", "game", "game_id")} ${id("k", "kalshi", "game", "game_id")}) ${alias}`;
