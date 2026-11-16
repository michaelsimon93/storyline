-- Provider IDs live in external_ids, never in core tables (ADR-021, STO-38).
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a5500000-0000-0000-0000-0000000000e1', 'nba', storyline_today(), 21, 22, now() + interval '1 day', 'scheduled');
insert into markets (id, league, game_id, kind, title, team_id, status) values
  (mid('X5-A'), 'nba', 'a5500000-0000-0000-0000-0000000000e1', 'game_winner', 'A wins', 1, 'open'),
  (mid('X5-B'), 'nba', 'a5500000-0000-0000-0000-0000000000e1', 'game_winner', 'B wins', 2, 'open');
insert into external_ids (source, kind, league, external_id, market_id) values
  ('kalshi', 'market', 'nba', 'KXNBAGAME-X55-A', mid('X5-A'));

select t_eq('external ids: a market is found by its provider id',
  (select market_id from external_ids where source = 'kalshi' and kind = 'market' and external_id = 'KXNBAGAME-X55-A'),
  mid('X5-A'));
select t_err('external ids: two markets can''t claim the same provider id',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'market', 'nba', 'KXNBAGAME-X55-A', mid('X5-B'))$q$,
  '%external_ids_lookup%');
select t_err('external ids: a market can''t have two ids from one provider',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'market', 'nba', 'KXNBAGAME-X55-A2', mid('X5-A'))$q$,
  '%external_ids_one_per_market%');
insert into external_ids (source, kind, league, external_id, market_id) values
  ('otherx', 'market', 'nba', 'KXNBAGAME-X55-A', mid('X5-B'));
select t_eq('external ids: another provider may use the same id string for its own market',
  (select market_id from external_ids where source = 'otherx' and external_id = 'KXNBAGAME-X55-A'), mid('X5-B'));
select t_err('external ids: a market row must point at a market',
  $q$insert into external_ids (source, kind, league, external_id) values ('kalshi', 'market', 'nba', 'orphan')$q$,
  '%external_ids_points_at_one%');
select t_err('external ids: provider names are lowercase identifiers',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('Kalshi API', 'market', 'nba', 'z', mid('X5-B'))$q$,
  '%external_ids_source_check%');
select t_err('markets: the same market (game, kind, team or player, stat, line) can''t exist twice',
  $q$insert into markets (id, league, game_id, kind, title, team_id, status)
     values (mid('X5-A2'), 'nba', 'a5500000-0000-0000-0000-0000000000e1', 'game_winner', 'A wins again', 1, 'open')$q$,
  '%markets_identity%');
delete from markets where id = mid('X5-B');
select t_eq('external ids: deleting a market removes its provider ids',
  (select count(*)::int from external_ids where market_id = mid('X5-B')), 0);
select t_eq('core tables: no provider-named columns remain',
  (select count(*)::int from information_schema.columns
   where table_schema = 'public'
     and table_name in ('teams', 'players', 'games', 'markets', 'cards', 'picks', 'market_price_snapshots')
     and column_name ~ '(kalshi|espn|ticker)'), 0);


-- ---------------------------------------------------------------- teams, players, games (STO-39)
insert into players (id, league, full_name, team_id) values
  ('a5500000-0000-0000-0000-0000000000b1', 'nba', 'Xref Player', 21),
  ('a5500000-0000-0000-0000-0000000000b2', 'nba', 'Kalshi Only', 21);
insert into external_ids (source, kind, league, external_id, player_id) values
  ('kalshi', 'player', 'nba', 'kp55', 'a5500000-0000-0000-0000-0000000000b1'),
  ('espn',   'player', 'nba', 'ea55', 'a5500000-0000-0000-0000-0000000000b1'),
  ('kalshi', 'player', 'nba', 'kp56', 'a5500000-0000-0000-0000-0000000000b2');
insert into external_ids (source, kind, league, external_id, game_id) values
  ('kalshi', 'game', 'nba', 'X55', 'a5500000-0000-0000-0000-0000000000e1');
select t_eq('external ids: a team is found by its provider id in its league',
  (select team_id from external_ids where source = 'espn' and kind = 'team' and league = 'nfl' and external_id = '16'), 4::smallint);
select t_eq('external ids: a player is found by his Kalshi id',
  (select player_id from external_ids where source = 'kalshi' and kind = 'player' and league = 'nba' and external_id = 'kp55'),
  'a5500000-0000-0000-0000-0000000000b1'::uuid);
select t_eq('external ids: a player with a Kalshi id and no ESPN id is valid',
  (select count(*)::int from external_ids where player_id = 'a5500000-0000-0000-0000-0000000000b2'), 1);
select t_err('external ids: two teams in one league can''t share a provider id',
  $q$insert into external_ids (source, kind, league, external_id, team_id) values ('kalshi', 'team', 'nba', 'SAS', 2)$q$,
  '%external_ids_lookup%');
select t_err('external ids: two players can''t share a Kalshi id',
  $q$insert into external_ids (source, kind, league, external_id, player_id) values ('kalshi', 'player', 'nba', 'kp55', 'a5500000-0000-0000-0000-0000000000b2')$q$,
  '%external_ids_lookup%');
select t_err('external ids: a player has one Kalshi id',
  $q$insert into external_ids (source, kind, league, external_id, player_id) values ('kalshi', 'player', 'nba', 'kp55-new', 'a5500000-0000-0000-0000-0000000000b1')$q$,
  '%external_ids_one_per_player%');
select t_err('external ids: a team has one ESPN id',
  $q$insert into external_ids (source, kind, league, external_id, team_id) values ('espn', 'team', 'nba', '99', 1)$q$,
  '%external_ids_one_per_team%');
select t_err('external ids: a provider id can''t claim a different league than its row',
  $q$insert into external_ids (source, kind, league, external_id, team_id) values ('otherx', 'team', 'nfl', 'SAS', 1)$q$,
  '%foreign key%');
select t_err('external ids: a row points at exactly one thing',
  $q$insert into external_ids (source, kind, league, external_id, team_id, player_id)
     values ('otherx', 'team', 'nba', 'two', 1, 'a5500000-0000-0000-0000-0000000000b2')$q$,
  '%external_ids_points_at_one%');
select t_err('external ids: the column must match the kind',
  $q$insert into external_ids (source, kind, league, external_id, team_id) values ('otherx', 'player', 'nba', 'wrong', 1)$q$,
  '%external_ids_points_at_one%');
delete from players where id = 'a5500000-0000-0000-0000-0000000000b2';
select t_eq('external ids: deleting a player removes his provider ids',
  (select count(*)::int from external_ids where external_id = 'kp56'), 0);

set role authenticated;
select as_user('a4000000-0000-0000-0000-0000000000f1');
select t_err('external ids: users can''t read the provider cross-reference',
  $q$select * from external_ids$q$, 'permission denied%');
select t_eq('external ids: users still read teams, players and games',
  (select count(*)::int from games where id = 'a5500000-0000-0000-0000-0000000000e1'), 1);
select t_err('external ids: users can''t write it',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'market', 'nba', 'x', mid('X5-A'))$q$,
  'permission denied%');
reset role;
