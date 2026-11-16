-- STO-39 / ADR-021 step 3: teams, players and games keep only Storyline IDs.
-- Before: each carried provider-named ID columns (teams: Kalshi and ESPN abbreviations and the
-- ESPN team ID; players: ESPN athlete and Kalshi player IDs; games: ESPN event ID and Kalshi
-- game key). After: those IDs are rows in external_ids, like Kalshi's market tickers (STO-38).
-- A new provider adds rows, never columns.
--
-- Three rules change shape along the way:
-- 1. Provider IDs are scoped by league. ESPN team 16 is the Timberwolves (NBA) and the Vikings
--    (NFL), so (source, kind, external ID) alone can't be the key. external_ids gains league,
--    tied to its row's league by a composite foreign key so the two can't disagree.
-- 2. A game is identified by what it is: league, slate, home team, away team (games_identity),
--    the way markets are (markets_identity). ESPN's event ID attaches to it, and may attach to
--    several games, one per slate: a postponed game replayed another night keeps ESPN's event
--    ID but is a new game (STO-32, Michael's call Nov 16).
-- 3. The ESPN team abbreviation isn't kept. The ESPN adapter translates it (nbaTeams.ts); no
--    rule reads it.

-- ---------------------------------------------------------------- a league on every provider ID
alter table external_ids add column league league;
update external_ids x set league = m.league from markets m where m.id = x.market_id;
alter table external_ids alter column league set not null;

-- Composite keys so a provider ID's league always matches the row it points at.
alter table markets add constraint markets_id_league_key unique (id, league);
alter table teams   add constraint teams_id_league_key   unique (id, league);
alter table players add constraint players_id_league_key unique (id, league);
alter table games   add constraint games_id_league_key   unique (id, league);

alter table external_ids drop constraint external_ids_market_id_fkey;
alter table external_ids add foreign key (market_id, league) references markets (id, league) on delete cascade;

-- ---------------------------------------------------------------- team, player and game kinds
alter table external_ids add column team_id   smallint;
alter table external_ids add column player_id uuid;
alter table external_ids add column game_id   uuid;
alter table external_ids add foreign key (team_id, league)   references teams (id, league)   on delete cascade;
alter table external_ids add foreign key (player_id, league) references players (id, league) on delete cascade;
alter table external_ids add foreign key (game_id, league)   references games (id, league)   on delete cascade;

alter table external_ids drop constraint external_ids_kind_check;
alter table external_ids add constraint external_ids_kind_check
  check (kind in ('market', 'team', 'player', 'game'));
-- Exactly the column for its kind is set (replaces the market-only check).
alter table external_ids drop constraint external_ids_check;
alter table external_ids add constraint external_ids_points_at_one check (
  num_nonnulls(market_id, team_id, player_id, game_id) = 1
  and (kind = 'market') = (market_id is not null)
  and (kind = 'team')   = (team_id   is not null)
  and (kind = 'player') = (player_id is not null)
  and (kind = 'game')   = (game_id   is not null));

-- The key. A provider ID means one market, team or player in its league. A game ID can mean one
-- game per slate (rule 2 above), so games get their own rule: no duplicate rows.
alter table external_ids drop constraint external_ids_pkey;
alter table external_ids add column id bigint generated always as identity primary key;
create unique index external_ids_lookup on external_ids (source, kind, league, external_id) where kind <> 'game';
create unique index external_ids_game_lookup on external_ids (source, league, external_id, game_id) where kind = 'game';

-- One ID per row per provider: a player has one Kalshi ID, a team one ESPN ID, a game one event.
-- (external_ids_one_per_market, from STO-38, already covers markets.) Led by our own ID, so they
-- also serve cascades and reverse lookups.
create unique index external_ids_one_per_team   on external_ids (team_id, source)   where kind = 'team';
create unique index external_ids_one_per_player on external_ids (player_id, source) where kind = 'player';
create unique index external_ids_one_per_game   on external_ids (game_id, source)   where kind = 'game';

-- ---------------------------------------------------------------- move the IDs
insert into external_ids (source, kind, league, external_id, team_id)
select 'kalshi', 'team', league, kalshi_abbr, id from teams
union all
select 'espn', 'team', league, espn_id, id from teams;

insert into external_ids (source, kind, league, external_id, player_id)
select 'kalshi', 'player', league, kalshi_player_id, id from players where kalshi_player_id is not null
union all
select 'espn', 'player', league, espn_athlete_id, id from players where espn_athlete_id is not null;

insert into external_ids (source, kind, league, external_id, game_id)
select 'kalshi', 'game', league, kalshi_game_key, id from games
union all
select 'espn', 'game', league, espn_event_id, id from games;

-- ---------------------------------------------------------------- core tables speak Storyline
-- Fails loudly if two games already share a matchup on one slate; they'd need a manual merge.
alter table games add constraint games_identity unique (league, slate_date, home_team_id, away_team_id);

alter table teams   drop column kalshi_abbr, drop column espn_abbr, drop column espn_id;
alter table players drop column espn_athlete_id, drop column kalshi_player_id;
alter table games   drop column espn_event_id, drop column kalshi_game_key;   -- drops their unique keys too
