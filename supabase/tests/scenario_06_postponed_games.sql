-- A postponed game replayed on another night is a second game for the same ESPN event (STO-32).
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a0600000-0000-0000-0000-0000000000e1', 'nba', 'x06', 'X06-D1', storyline_today(), 1, 2, now() + interval '1 day', 'postponed');

insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a0600000-0000-0000-0000-0000000000e2', 'nba', 'x06', 'X06-D3', storyline_today() + 2, 1, 2, now() + interval '3 days', 'scheduled');
select t_eq('postponed: the same ESPN event can be a game on two slates',
  (select count(*)::int from games where espn_event_id = 'x06'), 2);

select t_err('postponed: the same ESPN event can''t be two games on one slate',
  $$insert into games (league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at)
    values ('nba', 'x06', 'X06-DUP', storyline_today(), 1, 2, now())$$,
  '%games_league_espn_event_slate_key%');
