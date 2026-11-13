-- Personalization groundwork (ADR-019): team snapshot on cards, core vs pool placement,
-- and user_affinities built from what users saw and what they picked.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

select t_err('cards: a player card must record the player''s team at publish',
  $q$insert into cards (slate_date, sort_key, game_id, subject, player_id, market_ticker, blurb)
     values (storyline_today(), 50, '00000000-0000-0000-0000-0000000000b2', 'player',
             '00000000-0000-0000-0000-0000000000a1', 'WEMBY-30', 'no team')$q$, '%check constraint%');
select t_eq('cards: placement defaults to the shared core deck',
  (select placement from cards where id = '00000000-0000-0000-0000-0000000000c5'), 'core');
select t_err('cards: placement must be core or pool',
  $q$update cards set placement = 'vip' where id = '00000000-0000-0000-0000-0000000000c5'$q$, '%check constraint%');

-- A fresh user who views three cards and picks one.
insert into auth.users (id) values ('55555555-5555-5555-5555-555555555555');
insert into players (id, league, full_name, team_id, kalshi_player_id) values
  ('00000000-0000-0000-0000-0000000000a6', 'nba', 'Trade Candidate', 1, 'k6'),
  ('00000000-0000-0000-0000-0000000000a7', 'nba', 'Bench Guy', 2, 'k7');
insert into markets (ticker, league, game_id, kind, kalshi_series, title, player_id, stat, strike,
                     yes_ask_cents, no_ask_cents, kalshi_status, prices_updated_at) values
  ('TC-3', 'nba', '00000000-0000-0000-0000-0000000000b1', 'player_stat', 'KXNBA3PT', 'Trade Candidate: 3+ threes',
   '00000000-0000-0000-0000-0000000000a6', 'threes', 3, 40, 61, 'active', now()),
  ('BG-8', 'nba', '00000000-0000-0000-0000-0000000000b1', 'player_stat', 'KXNBAREB', 'Bench Guy: 8+ rebounds',
   '00000000-0000-0000-0000-0000000000a7', 'rebounds', 8, 50, 51, 'active', now());
insert into cards (id, slate_date, sort_key, game_id, subject, player_id, team_id, market_ticker, blurb, storyline_type, placement) values
  ('00000000-0000-0000-0000-0000000000c6', storyline_today(), 6, '00000000-0000-0000-0000-0000000000b1', 'player',
   '00000000-0000-0000-0000-0000000000a6', 1, 'TC-3', 'Hot from deep.', 'hot_streak', 'core'),
  ('00000000-0000-0000-0000-0000000000c7', storyline_today(), 7, '00000000-0000-0000-0000-0000000000b1', 'player',
   '00000000-0000-0000-0000-0000000000a7', 2, 'BG-8', 'Starting tonight.', 'injury_opportunity', 'pool');

set role authenticated; select as_user('55555555-5555-5555-5555-555555555555');
select create_profile('Fan55') \g /dev/null
insert into events (user_id, event, card_id) values
  ('55555555-5555-5555-5555-555555555555', 'card_view', '00000000-0000-0000-0000-0000000000c6'),
  ('55555555-5555-5555-5555-555555555555', 'card_view', '00000000-0000-0000-0000-0000000000c6'),  -- seen twice: counts once
  ('55555555-5555-5555-5555-555555555555', 'card_view', '00000000-0000-0000-0000-0000000000c7');
select place_pick('00000000-0000-0000-0000-0000000000c6', 'yes') \g /dev/null
select t_err('affinity: users cannot read the affinity view', $q$select * from user_affinities$q$, 'permission denied%');
reset role;

-- The player is traded after the pick. History must still credit his team at the time.
update players set team_id = 2 where id = '00000000-0000-0000-0000-0000000000a6';

select t_eq('affinity: picks credit the team at publish, even after a trade',
  (select picks from user_affinities where user_id = '55555555-5555-5555-5555-555555555555'
     and dimension = 'team' and value = '1'), 1);
select t_eq('affinity: team 2 shows a view but no pick',
  (select cards_viewed || '/' || picks from user_affinities where user_id = '55555555-5555-5555-5555-555555555555'
     and dimension = 'team' and value = '2'), '1/0');
select t_eq('affinity: by stat',
  (select picks from user_affinities where user_id = '55555555-5555-5555-5555-555555555555'
     and dimension = 'stat' and value = 'threes'), 1);
select t_eq('affinity: by storyline type (viewed, skipped)',
  (select cards_viewed || '/' || picks from user_affinities where user_id = '55555555-5555-5555-5555-555555555555'
     and dimension = 'storyline_type' and value = 'injury_opportunity'), '1/0');
select t_eq('affinity: by player, with pick rate',
  (select pick_rate from user_affinities where user_id = '55555555-5555-5555-5555-555555555555'
     and dimension = 'player' and value = '00000000-0000-0000-0000-0000000000a6'), 1.0::numeric);
