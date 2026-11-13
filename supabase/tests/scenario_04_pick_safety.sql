-- Pick safety (test-adversary findings): picks must stop when the GAME has started per ESPN,
-- not only when the clock passes the scheduled tip-off; and when Kalshi isn't trading the market.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into auth.users (id) values ('a4000000-0000-0000-0000-0000000000f1');
insert into players (id, league, full_name, team_id, kalshi_player_id) values
  ('a4000000-0000-0000-0000-0000000000b1', 'nba', 'Early Starter',  1, 'a4k1'),
  ('a4000000-0000-0000-0000-0000000000b2', 'nba', 'Paused Market',  1, 'a4k2'),
  ('a4000000-0000-0000-0000-0000000000b3', 'nba', 'Normal Card',    2, 'a4k3'),
  ('a4000000-0000-0000-0000-0000000000b4', 'nba', 'In-Game Card',   2, 'a4k4'),
  ('a4000000-0000-0000-0000-0000000000b5', 'nba', 'Final Early',    1, 'a4k5');
insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  -- ESPN says in progress, but the stored tip-off is still 2h away (early start / stale schedule)
  ('a4000000-0000-0000-0000-0000000000e1', 'nba', 'a4e1', 'A4G1', storyline_today(), 1, 2, now() + interval '2 hours', 'in_progress'),
  ('a4000000-0000-0000-0000-0000000000e2', 'nba', 'a4e2', 'A4G2', storyline_today(), 1, 2, now() + interval '6 hours', 'scheduled'),
  ('a4000000-0000-0000-0000-0000000000e3', 'nba', 'a4e3', 'A4G3', storyline_today(), 1, 2, now() + interval '6 hours', 'final');
insert into markets (ticker, league, game_id, kind, kalshi_series, title, player_id, stat, strike,
                     yes_ask_cents, no_ask_cents, kalshi_status, prices_updated_at) values
  ('A4-EARLY',  'nba', 'a4000000-0000-0000-0000-0000000000e1', 'player_stat', 'KXNBAPTS', 'Early Starter: 20+', 'a4000000-0000-0000-0000-0000000000b1', 'points', 20, 50, 51, 'active', now()),
  ('A4-PAUSED', 'nba', 'a4000000-0000-0000-0000-0000000000e2', 'player_stat', 'KXNBAPTS', 'Paused Market: 20+', 'a4000000-0000-0000-0000-0000000000b2', 'points', 20, 50, 51, 'closed', now()),
  ('A4-OK',     'nba', 'a4000000-0000-0000-0000-0000000000e2', 'player_stat', 'KXNBAPTS', 'Normal Card: 20+',   'a4000000-0000-0000-0000-0000000000b3', 'points', 20, 50, 51, 'active', now()),
  ('A4-INGAME', 'nba', 'a4000000-0000-0000-0000-0000000000e1', 'player_stat', 'KXNBAPTS', 'In-Game Card: 20+',  'a4000000-0000-0000-0000-0000000000b4', 'points', 20, 50, 51, 'active', now()),
  ('A4-FINAL',  'nba', 'a4000000-0000-0000-0000-0000000000e3', 'player_stat', 'KXNBAPTS', 'Final Early: 20+',   'a4000000-0000-0000-0000-0000000000b5', 'points', 20, 50, 51, 'active', now());
insert into cards (id, slate_date, sort_key, game_id, subject, player_id, market_ticker, blurb, locks_at) values
  ('a4000000-0000-0000-0000-0000000000c1', storyline_today(), 41, 'a4000000-0000-0000-0000-0000000000e1', 'player', 'a4000000-0000-0000-0000-0000000000b1', 'A4-EARLY',  'early', null),
  ('a4000000-0000-0000-0000-0000000000c2', storyline_today(), 42, 'a4000000-0000-0000-0000-0000000000e2', 'player', 'a4000000-0000-0000-0000-0000000000b2', 'A4-PAUSED', 'paused', null),
  ('a4000000-0000-0000-0000-0000000000c3', storyline_today(), 43, 'a4000000-0000-0000-0000-0000000000e2', 'player', 'a4000000-0000-0000-0000-0000000000b3', 'A4-OK',     'ok', null),
  -- An in-game card has its own lock time, so an in-progress game must NOT lock it.
  ('a4000000-0000-0000-0000-0000000000c4', storyline_today(), 44, 'a4000000-0000-0000-0000-0000000000e1', 'player', 'a4000000-0000-0000-0000-0000000000b4', 'A4-INGAME', 'in-game', now() + interval '1 hour'),
  ('a4000000-0000-0000-0000-0000000000c5', storyline_today(), 45, 'a4000000-0000-0000-0000-0000000000e3', 'player', 'a4000000-0000-0000-0000-0000000000b5', 'A4-FINAL',  'final', null);

select t_eq('safety: pre-game card on a game ESPN shows in progress is live, not open',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c1'), 'live'::card_state);
select t_eq('safety: card on a game ESPN shows final is locked',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c5'), 'locked'::card_state);
select t_eq('safety: card whose market Kalshi is not trading is out',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c2'), 'out'::card_state);
select t_eq('safety: in-game card with its own lock time stays open while the game is on',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c4'), 'open'::card_state);

set role authenticated; select as_user('a4000000-0000-0000-0000-0000000000f1');
select create_profile('SafetyFan') \g /dev/null
select t_err('safety: no pick on a game ESPN shows in progress (before scheduled tip)',
  $q$select place_pick('a4000000-0000-0000-0000-0000000000c1', 'yes')$q$, 'card_not_open%');
select t_err('safety: no pick on a game ESPN shows final',
  $q$select place_pick('a4000000-0000-0000-0000-0000000000c5', 'yes')$q$, 'card_not_open%');
select t_err('safety: no pick on a market Kalshi is not trading',
  $q$select place_pick('a4000000-0000-0000-0000-0000000000c2', 'yes')$q$, 'card_not_open:out');
select t_eq('safety: a normal pre-game card still accepts picks',
  (select price_cents from place_pick('a4000000-0000-0000-0000-0000000000c3', 'yes')), 50::smallint);
select t_eq('safety: an in-game card accepts picks before its own lock time',
  (select price_cents from place_pick('a4000000-0000-0000-0000-0000000000c4', 'yes')), 50::smallint);
reset role;
