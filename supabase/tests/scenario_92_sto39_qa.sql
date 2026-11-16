-- qa (STO-39): integrity and privilege attacks on the team/player/game cross-reference.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- Two games on one far-future slate (no clash with other scenarios' matchups).
insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9200000-0000-0000-0000-0000000000e1', 'nba', storyline_today() + 30, 11, 12, now() + interval '30 days', 'scheduled'),
  ('a9200000-0000-0000-0000-0000000000e2', 'nba', storyline_today() + 30, 12, 11, now() + interval '30 days', 'scheduled'),
  ('a9200000-0000-0000-0000-0000000000e3', 'nba', storyline_today() + 31, 13, 14, now() + interval '31 days', 'scheduled');
insert into external_ids (source, kind, league, external_id, game_id) values
  ('espn',   'game', 'nba', 'q92', 'a9200000-0000-0000-0000-0000000000e1'),
  ('kalshi', 'game', 'nba', 'Q92KEY', 'a9200000-0000-0000-0000-0000000000e1');

-- ---------------------------------------------------------------- one ESPN event per slate
-- qa found that the database no longer enforces "one ESPN event is at most one game per slate" or
-- "one Kalshi game key per game": games are identified by matchup (games_identity, Michael's call
-- on STO-39), which accepts that tradeoff rather than storing the slate on each game ID. Ingest
-- enforces it instead: worker/test/sto39_qa.integration.test.ts, "one ESPN event never becomes
-- two games on one slate".
-- Coverage: the replay case (same ESPN event, different slate) is still allowed.
select t_eq('qa39: one ESPN event may be a game on another slate (STO-32 replay)',
  (select t_err('x', $q$insert into external_ids (source, kind, league, external_id, game_id)
     values ('espn', 'game', 'nba', 'q92', 'a9200000-0000-0000-0000-0000000000e3')$q$, '%') like 'FAIL%'), true);
delete from external_ids where game_id = 'a9200000-0000-0000-0000-0000000000e3';

-- ---------------------------------------------------------------- league tie (composite FK)
-- Attack: re-point an existing ID row at a row from another league via UPDATE (not INSERT).
insert into external_ids (source, kind, league, external_id, team_id) values ('qa', 'team', 'nba', 'QA92', 11);
select t_err('qa39: a team ID can''t be moved to a team in another league by update',
  $q$update external_ids set team_id = 4 where source = 'qa' and external_id = 'QA92'$q$, '%foreign key%');
select t_err('qa39: an ID row''s league can''t be changed away from its row''s league',
  $q$update external_ids set league = 'nfl' where source = 'qa' and external_id = 'QA92'$q$, '%foreign key%');
-- Attack: change a referenced team's league out from under its provider IDs.
select t_err('qa39: a team''s league can''t change while it has provider IDs',
  $q$update teams set league = 'nfl' where id = 11$q$, '%foreign key%');
-- Attack: change kind on an existing row so it no longer matches its column.
select t_err('qa39: an ID row''s kind can''t be switched to another kind',
  $q$update external_ids set kind = 'player' where source = 'qa' and external_id = 'QA92'$q$, '%external_ids_points_at_one%');
-- Attack: an empty or blank provider ID for a team/player/game (market had this check in STO-38).
select t_err('qa39: an empty team ID is rejected',
  $q$insert into external_ids (source, kind, league, external_id, team_id) values ('qa2', 'team', 'nba', '', 12)$q$, '%check%');
select t_err('qa39: a null league is rejected',
  $q$insert into external_ids (source, kind, external_id, team_id) values ('qa3', 'team', 'X', 12)$q$, '%null%');
delete from external_ids where source = 'qa';

-- Coverage: cascade on team/game deletion removes their IDs (not left dangling).
insert into teams (id, league, name, abbr) values (91, 'nba', 'QA cascade', 'QAC');
insert into external_ids (source, kind, league, external_id, team_id) values ('espn', 'team', 'nba', 'qa91', 91);
delete from teams where id = 91;
select t_eq('qa39: deleting a team removes its provider IDs',
  (select count(*)::int from external_ids where external_id = 'qa91'), 0);

-- ---------------------------------------------------------------- privileges
-- Attack: the new identity sequence on external_ids picked up Supabase's default grants.
select t_eq('qa39 priv: anon/authenticated have no privilege on external_ids'' id sequence',
  (select count(*)::int from information_schema.role_usage_grants
    where object_schema = 'public' and object_name = pg_get_serial_sequence('external_ids', 'id')::regclass::text
      and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('qa39 priv: authenticated can''t use external_ids'' id sequence',
  has_sequence_privilege('authenticated', pg_get_serial_sequence('external_ids', 'id'), 'usage'), false);
-- Attack: users write teams/players/games directly (they hold only our IDs now, but are still core data).
set role authenticated;
select as_user('a4000000-0000-0000-0000-0000000000f1');
select t_err('qa39 priv: users can''t insert a team', $q$insert into teams (league, name) values ('nba', 'x')$q$, 'permission denied%');
select t_err('qa39 priv: users can''t insert a player', $q$insert into players (league, full_name) values ('nba', 'x')$q$, 'permission denied%');
select t_err('qa39 priv: users can''t update a game',
  $q$update games set status = 'final' where id = 'a9200000-0000-0000-0000-0000000000e1'$q$, 'permission denied%');
select t_err('qa39 priv: users can''t reach provider IDs by joining from games',
  $q$select x.external_id from games g join external_ids x on x.game_id = g.id$q$, 'permission denied%');
reset role;
set role anon;
select t_err('qa39 priv: anon can''t read external_ids', $q$select count(*) from external_ids$q$, 'permission denied%');
reset role;
delete from games where id::text like 'a9200000%';
