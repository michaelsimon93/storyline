-- test-adversary (STO-38): money path after the re-key, and integrity holes in external_ids.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- ---------------------------------------------------------------- seed: 2 games, 4 team markets
insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9100000-0000-0000-0000-0000000000e1', 'nba', 'x91a', 'X91A', storyline_today(), 1, 2, now() + interval '1 day', 'scheduled'),
  ('a9100000-0000-0000-0000-0000000000e2', 'nba', 'x91b', 'X91B', storyline_today(), 1, 2, now() + interval '1 day', 'scheduled');
insert into markets (id, league, game_id, kind, title, team_id, yes_ask_cents, no_ask_cents, status, prices_updated_at) values
  (mid('ADV91-W'),  'nba', 'a9100000-0000-0000-0000-0000000000e1', 'game_winner', 'Team1 wins G1', 1, 1,  99, 'open', now()),
  (mid('ADV91-L'),  'nba', 'a9100000-0000-0000-0000-0000000000e1', 'game_winner', 'Team2 wins G1', 2, 99, 2,  'open', now()),
  (mid('ADV91-V'),  'nba', 'a9100000-0000-0000-0000-0000000000e2', 'game_winner', 'Team1 wins G2', 1, 40, 61, 'open', now()),
  (mid('ADV91-FV'), 'nba', 'a9100000-0000-0000-0000-0000000000e2', 'game_winner', 'Team2 wins G2', 2, 40, 61, 'open', now());
insert into external_ids (source, kind, external_id, market_id) values
  ('kalshi', 'market', 'ADV91-W', mid('ADV91-W')), ('kalshi', 'market', 'ADV91-L', mid('ADV91-L')),
  ('kalshi', 'market', 'ADV91-V', mid('ADV91-V')), ('kalshi', 'market', 'ADV91-FV', mid('ADV91-FV'));
insert into cards (id, slate_date, sort_key, game_id, subject, team_id, market_id, blurb) values
  ('a9100000-0000-0000-0000-0000000000c1', storyline_today(), 91, 'a9100000-0000-0000-0000-0000000000e1', 'team', 1, mid('ADV91-W'),  'w'),
  ('a9100000-0000-0000-0000-0000000000c2', storyline_today(), 92, 'a9100000-0000-0000-0000-0000000000e1', 'team', 2, mid('ADV91-L'),  'l'),
  ('a9100000-0000-0000-0000-0000000000c3', storyline_today(), 93, 'a9100000-0000-0000-0000-0000000000e2', 'team', 1, mid('ADV91-V'),  'v'),
  ('a9100000-0000-0000-0000-0000000000c4', storyline_today(), 94, 'a9100000-0000-0000-0000-0000000000e2', 'team', 2, mid('ADV91-FV'), 'fv');
insert into auth.users (id) values ('a9100000-0000-0000-0000-0000000000a1');

-- ---------------------------------------------------------------- money path, as the user
set role authenticated; select as_user('a9100000-0000-0000-0000-0000000000a1');
select create_profile('Adv91') \g /dev/null
-- Boundary: 1c price (max payout) and 99c price, through the re-keyed place_pick.
select t_eq('adv38 money: pick @1c records the card''s market id',
  (select market_id from place_pick('a9100000-0000-0000-0000-0000000000c1', 'yes')), mid('ADV91-W'));
select t_eq('adv38 money: pick @2c (No) records the card''s market id',
  (select market_id from place_pick('a9100000-0000-0000-0000-0000000000c2', 'no')), mid('ADV91-L'));
select t_eq('adv38 money: cash pick on the void market', (select price_cents from place_pick('a9100000-0000-0000-0000-0000000000c3', 'yes')), 40::smallint);
select t_eq('adv38 money: balance after 3 x $5 stakes', (select balance_cents from wallet_balances), 8500);
reset role;

-- A free trade on the 4th market (worker-granted credit), inserted the way the worker would.
insert into pick_credits (id, wallet_id, amount_cents, reason)
  select 'a9100000-0000-0000-0000-0000000000d1', id, 2000, 'promo' from wallets where user_id = 'a9100000-0000-0000-0000-0000000000a1';
insert into picks (user_id, wallet_id, card_id, market_id, side, price_cents, stake_cents, contracts, credit_id)
  select user_id, id, 'a9100000-0000-0000-0000-0000000000c4', mid('ADV91-FV'), 'yes', 40, 2000, 50, 'a9100000-0000-0000-0000-0000000000d1'
  from wallets where user_id = 'a9100000-0000-0000-0000-0000000000a1';

update markets set result = 'yes'    where id = mid('ADV91-W');
update markets set result = 'no'     where id = mid('ADV91-L');
update markets set result = 'scalar' where id in (mid('ADV91-V'), mid('ADV91-FV'));

-- Idempotency: settle every market twice; second pass touches nothing.
select t_eq('adv38 money: first settlement of 4 markets settles 4 picks',
  settle_market(mid('ADV91-W')) + settle_market(mid('ADV91-L')) + settle_market(mid('ADV91-V')) + settle_market(mid('ADV91-FV')), 4);
select t_eq('adv38 money: second settlement settles nothing',
  settle_market(mid('ADV91-W')) + settle_market(mid('ADV91-L')) + settle_market(mid('ADV91-V')) + settle_market(mid('ADV91-FV')), 0);
-- Boundary: $5 @1c pays $500 exactly; $5 @2c (No) pays $250.
select t_eq('adv38 money: $5 @1c pays 50000c', (select payout_cents from picks where market_id = mid('ADV91-W')), 50000);
select t_eq('adv38 money: $5 @2c pays 25000c', (select payout_cents from picks where market_id = mid('ADV91-L')), 25000);
select t_eq('adv38 money: void cash pick refunds the stake once',
  (select count(*)::int || ':' || sum(amount_cents) from ledger_entries le join picks p on p.id = le.pick_id
    where p.market_id = mid('ADV91-V') and le.type = 'pick_refund'), '1:500');
select t_eq('adv38 money: void free trade reissues the credit exactly once, no cash',
  (select count(*)::int from pick_credits where reason like 'reissued: voided free trade %'
     and wallet_id = (select id from wallets where user_id = 'a9100000-0000-0000-0000-0000000000a1'))
  || ':' || (select count(*)::int from ledger_entries le join picks p on p.id = le.pick_id where p.market_id = mid('ADV91-FV')), '1:0');
-- Invariant: every settled pick has exactly one outcome entry (cash) / none (free void/loss).
select t_eq('adv38 money: no settled cash pick has more than one outcome entry',
  (select count(*)::int from (select le.pick_id from ledger_entries le join picks p on p.id = le.pick_id
     where p.user_id = 'a9100000-0000-0000-0000-0000000000a1' and le.type in ('pick_payout', 'pick_refund')
     group by le.pick_id having count(*) > 1) x), 0);
-- Invariant: money conserved. 10000 - 1500 stakes + 50000 + 25000 + 500 refund.
select t_eq('adv38 money: final balance is exactly grants - stakes + payouts',
  (select balance_cents from wallet_balances w join wallets ww on ww.id = w.wallet_id where ww.user_id = 'a9100000-0000-0000-0000-0000000000a1'),
  10000 - 1500 + 50000 + 25000 + 500);
-- Hostile/odd input: unknown or null market id.
select t_eq('adv38 money: settle_market on an unknown id is a no-op', settle_market(gen_random_uuid()), 0);
select t_eq('adv38 money: settle_market(null) is a no-op', settle_market(null), 0);

-- ---------------------------------------------------------------- integrity: deletes and re-keys
select t_err('adv38 integrity: a market with picks can''t be deleted',
  $q$delete from markets where id = mid('ADV91-W')$q$, '%foreign key%');
select t_eq('adv38 integrity: its Kalshi id survives the failed delete',
  (select count(*)::int from external_ids where market_id = mid('ADV91-W')), 1);
select t_err('adv38 integrity: a market with picks can''t be re-keyed',
  $q$update markets set id = gen_random_uuid() where id = mid('ADV91-W')$q$, '%foreign key%');
select t_err('adv38 integrity: a provider id can''t be re-pointed at a market that already has one',
  $q$update external_ids set market_id = mid('ADV91-L') where external_id = 'ADV91-W'$q$, '%external_ids_one_per_market%');
select t_err('adv38 integrity: unknown kind rejected',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('kalshi', 'player', 'p1', mid('ADV91-W'))$q$, '%check%');
select t_err('adv38 integrity: provider name with trailing space rejected',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('kalshi ', 'market', 'ADV91-W', mid('ADV91-L'))$q$, '%external_ids_source_check%');
select t_err('adv38 integrity: external_ids can''t point at a market that doesn''t exist',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('otherx', 'market', 'ghost', gen_random_uuid())$q$, '%foreign key%');

-- Attack: an empty provider id is accepted and silently claims a market's one Kalshi slot.
-- (Distinct team totals: two game-winner markets for the same team would be the same market.)
insert into markets (id, league, game_id, kind, title, team_id, stat, strike, status) values
  (mid('ADV91-E'), 'nba', 'a9100000-0000-0000-0000-0000000000e2', 'team_stat', 'empty id', 1, 'points', 100.5, 'open'),
  (mid('ADV91-S'), 'nba', 'a9100000-0000-0000-0000-0000000000e2', 'team_stat', 'spaced id', 1, 'points', 101.5, 'open');
select t_err('adv38 integrity: an empty external_id is rejected',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('kalshi', 'market', '', mid('ADV91-E'))$q$, '%check%');
-- Attack: a whitespace-padded copy of an existing ticker becomes a second market for the same Kalshi market.
select t_err('adv38 integrity: a whitespace-padded duplicate of an existing ticker is rejected',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('kalshi', 'market', 'ADV91-W ', mid('ADV91-S'))$q$, '%check%');
delete from external_ids where market_id in (mid('ADV91-E'), mid('ADV91-S'));
delete from markets where id in (mid('ADV91-E'), mid('ADV91-S'));
