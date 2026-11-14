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
insert into markets (id, league, game_id, kind, title, player_id, stat, strike,
                     yes_ask_cents, no_ask_cents, status, prices_updated_at) values
  (mid('A4-EARLY'),  'nba', 'a4000000-0000-0000-0000-0000000000e1', 'player_stat', 'Early Starter: 20+', 'a4000000-0000-0000-0000-0000000000b1', 'points', 20, 50, 51, 'open', now()),
  (mid('A4-PAUSED'), 'nba', 'a4000000-0000-0000-0000-0000000000e2', 'player_stat', 'Paused Market: 20+', 'a4000000-0000-0000-0000-0000000000b2', 'points', 20, 50, 51, 'closed', now()),
  (mid('A4-OK'),     'nba', 'a4000000-0000-0000-0000-0000000000e2', 'player_stat', 'Normal Card: 20+',   'a4000000-0000-0000-0000-0000000000b3', 'points', 20, 50, 51, 'open', now()),
  (mid('A4-INGAME'), 'nba', 'a4000000-0000-0000-0000-0000000000e1', 'player_stat', 'In-Game Card: 20+',  'a4000000-0000-0000-0000-0000000000b4', 'points', 20, 50, 51, 'open', now()),
  (mid('A4-FINAL'),  'nba', 'a4000000-0000-0000-0000-0000000000e3', 'player_stat', 'Final Early: 20+',   'a4000000-0000-0000-0000-0000000000b5', 'points', 20, 50, 51, 'open', now());
insert into cards (id, slate_date, sort_key, game_id, subject, player_id, market_id, blurb, locks_at) values
  ('a4000000-0000-0000-0000-0000000000c1', storyline_today(), 41, 'a4000000-0000-0000-0000-0000000000e1', 'player', 'a4000000-0000-0000-0000-0000000000b1', mid('A4-EARLY'),  'early', null),
  ('a4000000-0000-0000-0000-0000000000c2', storyline_today(), 42, 'a4000000-0000-0000-0000-0000000000e2', 'player', 'a4000000-0000-0000-0000-0000000000b2', mid('A4-PAUSED'), 'paused', null),
  ('a4000000-0000-0000-0000-0000000000c3', storyline_today(), 43, 'a4000000-0000-0000-0000-0000000000e2', 'player', 'a4000000-0000-0000-0000-0000000000b3', mid('A4-OK'),     'ok', null),
  -- An in-game card has its own lock time, so an in-progress game must NOT lock it.
  ('a4000000-0000-0000-0000-0000000000c4', storyline_today(), 44, 'a4000000-0000-0000-0000-0000000000e1', 'player', 'a4000000-0000-0000-0000-0000000000b4', mid('A4-INGAME'), 'in-game', now() + interval '1 hour'),
  ('a4000000-0000-0000-0000-0000000000c5', storyline_today(), 45, 'a4000000-0000-0000-0000-0000000000e3', 'player', 'a4000000-0000-0000-0000-0000000000b5', mid('A4-FINAL'),  'final', null);

select t_eq('safety: pre-game card on a game ESPN shows in progress is live, not open',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c1'), 'live'::card_state);
select t_eq('safety: card on a game ESPN shows final is locked',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c5'), 'locked'::card_state);
select t_eq('safety: card whose market Kalshi is not trading is out',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c2'), 'out'::card_state);
select t_eq('safety: in-game card with its own lock time stays open while the game is on',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c4'), 'open'::card_state);

-- Review findings (PR A): final/canceled lock EVERY card, including in-game cards with their
-- own lock time; and the other game statuses behave as expected.
insert into players (id, league, full_name, team_id, kalshi_player_id) values
  ('a4000000-0000-0000-0000-0000000000b6', 'nba', 'Canceled Game',  2, 'a4k6'),
  ('a4000000-0000-0000-0000-0000000000b7', 'nba', 'Postponed Game', 2, 'a4k7'),
  ('a4000000-0000-0000-0000-0000000000b8', 'nba', 'In-Game Final',  2, 'a4k8');
insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a4000000-0000-0000-0000-0000000000e4', 'nba', 'a4e4', 'A4G4', storyline_today(), 1, 2, now() + interval '6 hours', 'canceled'),
  ('a4000000-0000-0000-0000-0000000000e5', 'nba', 'a4e5', 'A4G5', storyline_today(), 1, 2, now() + interval '6 hours', 'postponed');
insert into markets (id, league, game_id, kind, title, player_id, stat, strike,
                     yes_ask_cents, no_ask_cents, status, prices_updated_at) values
  (mid('A4-CANCEL'), 'nba', 'a4000000-0000-0000-0000-0000000000e4', 'player_stat', 'x', 'a4000000-0000-0000-0000-0000000000b6', 'points', 20, 50, 51, 'open', now()),
  (mid('A4-POSTP'),  'nba', 'a4000000-0000-0000-0000-0000000000e5', 'player_stat', 'x', 'a4000000-0000-0000-0000-0000000000b7', 'points', 20, 50, 51, 'open', now()),
  (mid('A4-IGFIN'),  'nba', 'a4000000-0000-0000-0000-0000000000e3', 'player_stat', 'x', 'a4000000-0000-0000-0000-0000000000b8', 'points', 20, 50, 51, 'open', now());
insert into cards (id, slate_date, sort_key, game_id, subject, player_id, market_id, blurb, locks_at) values
  ('a4000000-0000-0000-0000-0000000000c6', storyline_today(), 46, 'a4000000-0000-0000-0000-0000000000e4', 'player', 'a4000000-0000-0000-0000-0000000000b6', mid('A4-CANCEL'), 'x', null),
  ('a4000000-0000-0000-0000-0000000000c7', storyline_today(), 47, 'a4000000-0000-0000-0000-0000000000e5', 'player', 'a4000000-0000-0000-0000-0000000000b7', mid('A4-POSTP'),  'x', null),
  ('a4000000-0000-0000-0000-0000000000c8', storyline_today(), 48, 'a4000000-0000-0000-0000-0000000000e3', 'player', 'a4000000-0000-0000-0000-0000000000b8', mid('A4-IGFIN'),  'x', now() + interval '1 hour');
select t_eq('safety: card on a canceled game is locked',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c6'), 'locked'::card_state);
select t_eq('safety: card on a postponed game (new tip-off ahead) stays open',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c7'), 'open'::card_state);
select t_eq('safety: in-game card on a final game is locked despite its later lock time',
  (select state from card_feed where id = 'a4000000-0000-0000-0000-0000000000c8'), 'locked'::card_state);

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

-- ---------------------------------------------------------------- market status (ADR-021)
-- Cards follow our own market status, not a provider's words.
select t_eq('status: an open market keeps its card open',
  (select state::text from card_feed where market_id = mid('A4-OK')), 'open');
update markets set status = 'paused' where id = mid('A4-OK');
select t_eq('status: a paused market turns its card out',
  (select state::text from card_feed where market_id = mid('A4-OK')), 'out');
update markets set status = 'closed' where id = mid('A4-OK');
select t_eq('status: a closed market (result not final) turns its card out',
  (select state::text from card_feed where market_id = mid('A4-OK')), 'out');
update markets set status = 'settled' where id = mid('A4-OK');
select t_eq('status: a market the exchange settled, before our settlement has run, is out (no picks)',
  (select state::text from card_feed where market_id = mid('A4-OK')), 'out');
update markets set status = 'open' where id = mid('A4-OK');
select t_err('status: a provider''s own word can''t be stored',
  $q$update markets set status = 'active' where id = mid('A4-OK')$q$, '%invalid input value for enum market_status%');
