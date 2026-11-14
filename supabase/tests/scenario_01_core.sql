-- Core scenarios: slate day, picks, wallets, settlement, free trades, snapshots, lockdown.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- ---------------------------------------------------------------- slate day (3am ET rollover, DST-safe)
select t_eq('2:59am ET is still yesterday', storyline_day('2026-11-14 07:59:00+00'), '2026-11-13'::date);
select t_eq('3:00am ET rolls over',          storyline_day('2026-11-14 08:00:00+00'), '2026-11-14'::date);
select t_eq('DST spring-forward: 1:59am EST', storyline_day('2026-03-08 06:59:00+00'), '2026-03-07'::date);
select t_eq('DST spring-forward: 3:00am EDT', storyline_day('2026-03-08 07:00:00+00'), '2026-03-08'::date);
select t_eq('DST fall-back: 2:30am EST',     storyline_day('2026-11-01 07:30:00+00'), '2026-10-31'::date);
select t_eq('DST fall-back: 3:00am EST',     storyline_day('2026-11-01 08:00:00+00'), '2026-11-01'::date);
select t_eq('storyline_today() = storyline_day(now())', storyline_today(), storyline_day(now()));

-- ---------------------------------------------------------------- seed (worker)
insert into teams (id,league,name,kalshi_abbr,espn_abbr,espn_id) values
 (1,'nba','Spurs','SAS','SA','24'), (2,'nba','Warriors','GSW','GS','9'),
 (3,'nba','Timberwolves','MIN','MIN','16'), (4,'nfl','Vikings','MIN','MIN','16');  -- same abbr+espn id, different league
insert into players (id,league,full_name,team_id,espn_athlete_id,kalshi_player_id) values
 ('00000000-0000-0000-0000-0000000000a1','nba','Victor Wembanyama',1,'5104157','k1'),
 ('00000000-0000-0000-0000-0000000000a2','nba','Stephen Curry',2,'3975','k2'),
 ('00000000-0000-0000-0000-0000000000a3','nba','Keldon Johnson',1,'4395630','k3');
insert into games (id,league,espn_event_id,kalshi_game_key,slate_date,home_team_id,away_team_id,tip_off_at) values
 ('00000000-0000-0000-0000-0000000000b1','nba','e1','G1',storyline_today(),1,2, now()+interval '6 hours'),
 ('00000000-0000-0000-0000-0000000000b2','nba','e2','G2',storyline_today(),1,2, now()-interval '1 hour');
insert into markets (id,league,game_id,kind,title,player_id,team_id,stat,strike,yes_ask_cents,no_ask_cents,status,prices_updated_at) values
 (mid('WEMBY-30'),'nba','00000000-0000-0000-0000-0000000000b1','player_stat','Victor Wembanyama: 30+ points','00000000-0000-0000-0000-0000000000a1',null,'points',30,43,58,'open',now()),
 (mid('CURRY-5'), 'nba','00000000-0000-0000-0000-0000000000b2','player_stat','Stephen Curry: 5+ threes','00000000-0000-0000-0000-0000000000a2',null,'threes',5,50,51,'open',now()),
 (mid('KJ-8'),    'nba','00000000-0000-0000-0000-0000000000b1','player_stat','Keldon Johnson: 8+ rebounds','00000000-0000-0000-0000-0000000000a3',null,'rebounds',8,50,51,'open',now()-interval '10 minutes'),
 (mid('SAS-WIN'), 'nba','00000000-0000-0000-0000-0000000000b1','game_winner','San Antonio wins',null,1,null,null,62,40,'open',now());
insert into cards (id,slate_date,sort_key,game_id,subject,player_id,team_id,market_id,blurb) values
 ('00000000-0000-0000-0000-0000000000c1',storyline_today(),1,'00000000-0000-0000-0000-0000000000b1','player','00000000-0000-0000-0000-0000000000a1',1,mid('WEMBY-30'),'Wemby has hit 30 in 3 straight.'),
 ('00000000-0000-0000-0000-0000000000c2',storyline_today(),2,'00000000-0000-0000-0000-0000000000b2','player','00000000-0000-0000-0000-0000000000a2',2,mid('CURRY-5'),'Curry vs the Spurs again.'),
 ('00000000-0000-0000-0000-0000000000c3',storyline_today(),3,'00000000-0000-0000-0000-0000000000b1','player','00000000-0000-0000-0000-0000000000a3',1,mid('KJ-8'),'Starting with Sochan out.'),
 ('00000000-0000-0000-0000-0000000000c4',storyline_today(),4,'00000000-0000-0000-0000-0000000000b1','team',null,1,mid('SAS-WIN'),'Spurs chasing a 15th straight win.');
insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');

update cards set storyline_type='hot_streak' where id='00000000-0000-0000-0000-0000000000c1';
update cards set storyline_type='team_streak' where id='00000000-0000-0000-0000-0000000000c4';
select t_err('storyline_type must be a known type',
  $q$update cards set storyline_type='vibes' where id='00000000-0000-0000-0000-0000000000c1'$q$, '%check constraint%');
select t_eq('storyline types queryable', (select string_agg(storyline_type, ',' order by sort_key) from cards), 'hot_streak,other,other,team_streak');
select 'PASS league: NBA MIN and NFL MIN coexist' where (select count(*) from teams where kalshi_abbr='MIN') = 2;
select t_err('one card per player per game',
  $q$insert into cards (slate_date,sort_key,game_id,subject,player_id,team_id,market_id,blurb)
     values (storyline_today(),9,'00000000-0000-0000-0000-0000000000b1','player','00000000-0000-0000-0000-0000000000a1',1,mid('WEMBY-30'),'dupe')$q$,
  '%cards_one_per_player%');
select t_err('team card cannot also name a player',
  $q$insert into cards (slate_date,sort_key,game_id,subject,player_id,team_id,market_id,blurb)
     values (storyline_today(),9,'00000000-0000-0000-0000-0000000000b1','team','00000000-0000-0000-0000-0000000000a2',2,mid('SAS-WIN'),'bad')$q$,
  '%check constraint%');

-- ---------------------------------------------------------------- user A
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('A signup', (select display_name from create_profile('Michael')), 'Michael');
select t_eq('A starts with $100 in main wallet', (select balance_cents from wallet_balances where kind='main'), 10000);
select t_eq('A pick Yes Wemby 30+ @43 -> 11.6279 contracts',
  (select contracts from place_pick('00000000-0000-0000-0000-0000000000c1','yes')), 11.6279::numeric);
select t_err('A same card twice', $q$select place_pick('00000000-0000-0000-0000-0000000000c1','no')$q$, 'already_picked');
select t_err('A card after tip-off', $q$select place_pick('00000000-0000-0000-0000-0000000000c2','yes')$q$, 'card_not_open:locked');
select t_err('A stale prices', $q$select place_pick('00000000-0000-0000-0000-0000000000c3','yes')$q$, 'prices_stale');
select t_err('A price moved (v1.1 check)', $q$select place_pick('00000000-0000-0000-0000-0000000000c4','yes',60::smallint)$q$, 'price_moved:62');
select t_eq('A team-card pick (Spurs win @62)',
  (select price_cents from place_pick('00000000-0000-0000-0000-0000000000c4','yes',65::smallint)), 62::smallint);
select t_err('A cannot write ledger directly',
  $q$insert into ledger_entries (user_id,wallet_id,type,amount_cents) select user_id,id,'adjustment',99999 from wallets$q$,
  'permission denied%');
select t_err('A cannot create a wallet directly',
  $q$insert into wallets (user_id) values ('11111111-1111-1111-1111-111111111111')$q$, 'permission denied%');
select t_eq('A balance after two picks', (select balance_cents from wallet_balances), 9000);

-- ---------------------------------------------------------------- user B
select as_user('22222222-2222-2222-2222-222222222222');
select t_err('B name taken (case-insensitive)', $q$select create_profile('michael')$q$, 'display_name_taken_or_profile_exists');
select t_eq('B signup', (select display_name from create_profile('Dani')), 'Dani');
select t_eq('B picks No on Wemby', (select side from place_pick('00000000-0000-0000-0000-0000000000c1','no')), 'no'::pick_side);
select t_eq('B sees only own picks', (select count(*) from picks), 1::bigint);
select t_eq('B sees only own wallet', (select count(*) from wallets), 1::bigint);
select t_eq('card states', (select string_agg(state::text, ',' order by sort_key) from card_feed), 'open,locked,open,open');

-- ---------------------------------------------------------------- contest wallet (worker creates)
reset role;
insert into wallets (id,user_id,kind,contest_id) values
 ('00000000-0000-0000-0000-0000000000d1','11111111-1111-1111-1111-111111111111','contest','00000000-0000-0000-0000-0000000000e1');
insert into ledger_entries (user_id,wallet_id,type,amount_cents,memo) values
 ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-0000000000d1','bonus_grant',5000,'Contest bankroll');
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('A picks same card in contest wallet (separate bankroll)',
  (select side from place_pick('00000000-0000-0000-0000-0000000000c1','no',null,'00000000-0000-0000-0000-0000000000d1')), 'no'::pick_side);
select t_eq('contest wallet balance', (select balance_cents from wallet_balances where kind='contest'), 4500);
select t_eq('main wallet untouched', (select balance_cents from wallet_balances where kind='main'), 9000);
select as_user('22222222-2222-2222-2222-222222222222');
select t_err('B cannot use A''s contest wallet',
  $q$select place_pick('00000000-0000-0000-0000-0000000000c4','yes',null,'00000000-0000-0000-0000-0000000000d1')$q$, 'no_wallet');

-- ---------------------------------------------------------------- settlement (worker)
reset role;
update markets set result='yes' where id = mid('WEMBY-30');
select t_eq('settle Wemby: 3 picks', settle_market(mid('WEMBY-30')), 3);
select t_eq('settle again pays nothing', settle_market(mid('WEMBY-30')), 0);
select t_eq('A main: 9000 + 1163', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 10163);
select t_eq('A contest No lost: 4500', (select balance_cents from wallet_balances where kind='contest'), 4500);
select t_eq('B lost: 9500', (select balance_cents from wallet_balances where user_id='22222222-2222-2222-2222-222222222222'), 9500);

update markets set result='scalar' where id = mid('SAS-WIN');
select t_eq('void team pick', settle_market(mid('SAS-WIN')), 1);
select t_eq('void refunds $5', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 10663);

-- insufficient funds
insert into ledger_entries (user_id,wallet_id,type,amount_cents,memo)
  select user_id,id,'adjustment',-9200,'test drain' from wallets where user_id='22222222-2222-2222-2222-222222222222';
update markets set prices_updated_at=now() where id = mid('KJ-8');
set role authenticated; select as_user('22222222-2222-2222-2222-222222222222');
select t_err('B insufficient funds', $q$select place_pick('00000000-0000-0000-0000-0000000000c3','yes')$q$, 'insufficient_funds');

-- ---------------------------------------------------------------- free trades (credits)
reset role;
update markets set result = null where id = mid('KJ-8');
insert into pick_credits (id, wallet_id, amount_cents, reason)
  select '00000000-0000-0000-0000-0000000000f1', id, 2000, 'promo' from wallets where user_id='11111111-1111-1111-1111-111111111111' and kind='main';
insert into pick_credits (id, wallet_id, amount_cents, reason)
  select '00000000-0000-0000-0000-0000000000f2', id, 2000, 'promo' from wallets where user_id='11111111-1111-1111-1111-111111111111' and kind='main';
-- Credit-funded picks placed directly by the worker for the test (no cash stake entry).
insert into picks (user_id, wallet_id, card_id, market_id, side, price_cents, stake_cents, contracts, credit_id)
  select '11111111-1111-1111-1111-111111111111', id, '00000000-0000-0000-0000-0000000000c3', mid('KJ-8'), 'yes', 40, 2000, 50, '00000000-0000-0000-0000-0000000000f1'
  from wallets where user_id='11111111-1111-1111-1111-111111111111' and kind='main';
select t_eq('A main before free trade', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 10663);
update markets set result='yes' where id = mid('KJ-8');
select t_eq('settle free trade', settle_market(mid('KJ-8')), 1);
select t_eq('free $20 @40% wins $30 winnings only (not $50)', (select payout_cents from picks where credit_id='00000000-0000-0000-0000-0000000000f1'), 3000);
select t_eq('A main after free trade win: +$30', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 13663);
select t_eq('settle free trade again pays nothing', settle_market(mid('KJ-8')), 0);

-- void free trade -> credit reissued, no cash
update markets set result=null where id = mid('CURRY-5');
insert into picks (user_id, wallet_id, card_id, market_id, side, price_cents, stake_cents, contracts, credit_id)
  select '11111111-1111-1111-1111-111111111111', id, '00000000-0000-0000-0000-0000000000c2', mid('CURRY-5'), 'no', 50, 2000, 40, '00000000-0000-0000-0000-0000000000f2'
  from wallets where user_id='11111111-1111-1111-1111-111111111111' and kind='main'
  on conflict (wallet_id, card_id) do nothing;
-- (A already has a cash pick on c2? no; c2 was locked for A) -> inserted
update markets set result='scalar' where id = mid('CURRY-5');
select settle_market(mid('CURRY-5')) \g /dev/null
select t_eq('void free trade: no cash', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 13663);
select t_eq('void free trade: credit reissued', (select count(*) from pick_credits where reason like 'reissued:%'), 1::bigint);

-- ---------------------------------------------------------------- price snapshots (line movement)
reset role;
update markets set result = null where id in (mid('SAS-WIN'), mid('WEMBY-30'));   -- two live markets, two settled
select t_eq('first snapshot captures every live market', snapshot_prices(), 2);
select t_eq('settled markets are not snapshotted',
  (select count(*)::int from market_price_snapshots where market_id in (mid('KJ-8'), mid('CURRY-5'))), 0);
select t_eq('unchanged prices: no new snapshots', snapshot_prices(), 0);
update markets set yes_ask_cents = 61, prices_updated_at = now() where id = mid('SAS-WIN');
select t_eq('a price move is captured', snapshot_prices(), 1);
select t_eq('history shows the move',
  (select string_agg(yes_ask_cents::text, '->' order by captured_at) from market_price_snapshots where market_id = mid('SAS-WIN')), '62->61');
update market_price_snapshots set captured_at = captured_at - interval '20 minutes';
select t_eq('unchanged but stale: re-snapshotted after the interval', snapshot_prices(), 2);
-- Regression (review PR #1): markets nobody polls anymore must not be re-snapshotted forever.
update markets set prices_updated_at = now() - interval '2 hours' where id = mid('WEMBY-30');
update market_price_snapshots set captured_at = captured_at - interval '20 minutes';
select t_eq('a market nobody is polling is not re-snapshotted', snapshot_prices(), 1);
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('users can read price history', (select count(*) > 0 from market_price_snapshots), true);
select t_err('users cannot write price history',
  $q$insert into market_price_snapshots (market_id, yes_ask_cents) values (mid('SAS-WIN'), 1)$q$, 'permission denied%');
select t_err('users cannot trigger snapshots', $q$select snapshot_prices()$q$, 'permission denied%');
reset role;

-- ---------------------------------------------------------------- permission lockdown
-- Regression (review PR #1): grants given back must actually work, not just restrictions.
reset role; set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('signed-in user can ask for today''s slate day', storyline_today() = storyline_day(now()), true);
-- Supabase grants everything to anon/authenticated by default; these prove we revoked it.
reset role; set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_err('user cannot run settle_market', $q$select settle_market(mid('KJ-8'))$q$, 'permission denied%');
select t_err('user cannot insert a pick directly',
  $q$insert into picks (user_id,wallet_id,card_id,market_id,side,price_cents,stake_cents,contracts)
     select user_id,id,'00000000-0000-0000-0000-0000000000c1',mid('WEMBY-30'),'yes',1,500,500 from wallets limit 1$q$, 'permission denied%');
select t_err('user cannot change prices', $q$update markets set yes_ask_cents = 1$q$, 'permission denied%');
select t_err('user cannot delete ledger rows', $q$delete from ledger_entries$q$, 'permission denied%');
select t_err('user cannot grant themselves credits',
  $q$insert into pick_credits (wallet_id,amount_cents,reason) select id,100000,'x' from wallets limit 1$q$, 'permission denied%');
select t_err('user cannot read pipeline runs', $q$select * from pipeline_runs$q$, 'permission denied%');
reset role; set role anon;
select t_err('signed-out visitor cannot read cards', $q$select * from cards$q$, 'permission denied%');
select t_err('signed-out visitor cannot place picks',
  $q$select place_pick('00000000-0000-0000-0000-0000000000c1','yes')$q$, 'permission denied%');
reset role;
