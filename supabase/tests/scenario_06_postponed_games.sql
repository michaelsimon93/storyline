-- A postponed game replayed on another night is a second game for the same ESPN event (STO-32).
-- Games are identified by matchup and slate; ESPN's event ID is attached in external_ids (STO-39).
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a0600000-0000-0000-0000-0000000000e1', 'nba', storyline_today(),     29, 30, now() + interval '1 day',  'postponed'),
  ('a0600000-0000-0000-0000-0000000000e2', 'nba', storyline_today() + 2, 29, 30, now() + interval '3 days', 'scheduled');
insert into external_ids (source, kind, league, external_id, game_id) values
  ('espn', 'game', 'nba', 'x06', 'a0600000-0000-0000-0000-0000000000e1'),
  ('espn', 'game', 'nba', 'x06', 'a0600000-0000-0000-0000-0000000000e2');
select t_eq('postponed: the same ESPN event can be a game on two slates',
  (select count(*)::int from external_ids where source = 'espn' and kind = 'game' and external_id = 'x06'), 2);

select t_err('postponed: the same matchup can''t be two games on one slate',
  $$insert into games (league, slate_date, home_team_id, away_team_id, tip_off_at)
    values ('nba', storyline_today(), 29, 30, now())$$,
  '%games_identity%');
select t_err('postponed: an ESPN event can''t be attached to the same game twice',
  $$insert into external_ids (source, kind, league, external_id, game_id)
    values ('espn', 'game', 'nba', 'x06', 'a0600000-0000-0000-0000-0000000000e1')$$,
  '%external_ids_game_lookup%');
select t_err('postponed: a game has one ESPN event',
  $$insert into external_ids (source, kind, league, external_id, game_id)
    values ('espn', 'game', 'nba', 'x06-other', 'a0600000-0000-0000-0000-0000000000e1')$$,
  '%external_ids_one_per_game%');
