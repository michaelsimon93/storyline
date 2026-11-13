-- Storyline schema scenario tests. Run after supabase_stubs.sql + migrations.
-- Every line of output should start with PASS.
\set QUIET on
\pset tuples_only on
\pset format unaligned

create function t_err(label text, q text, pat text) returns text language plpgsql as $$
begin
  execute q;
  return 'FAIL ' || label || ' (expected error ' || pat || ')';
exception when others then
  return case when sqlerrm like pat then 'PASS ' || label
              else 'FAIL ' || label || ': got ' || sqlerrm end;
end $$;
create function t_eq(label text, got anyelement, want anyelement) returns text language sql as $$
  select case when got is not distinct from want then 'PASS ' || label
              else 'FAIL ' || label || ': got ' || coalesce(got::text,'null') || ', want ' || coalesce(want::text,'null') end
$$;
create function as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false) $$;

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
insert into markets (ticker,league,game_id,kind,kalshi_series,title,player_id,team_id,stat,strike,yes_ask_cents,no_ask_cents,kalshi_status,prices_updated_at) values
 ('WEMBY-30','nba','00000000-0000-0000-0000-0000000000b1','player_stat','KXNBAPTS','Victor Wembanyama: 30+ points','00000000-0000-0000-0000-0000000000a1',null,'points',30,43,58,'active',now()),
 ('CURRY-5', 'nba','00000000-0000-0000-0000-0000000000b2','player_stat','KXNBA3PT','Stephen Curry: 5+ threes','00000000-0000-0000-0000-0000000000a2',null,'threes',5,50,51,'active',now()),
 ('KJ-8',    'nba','00000000-0000-0000-0000-0000000000b1','player_stat','KXNBAREB','Keldon Johnson: 8+ rebounds','00000000-0000-0000-0000-0000000000a3',null,'rebounds',8,50,51,'active',now()-interval '10 minutes'),
 ('SAS-WIN', 'nba','00000000-0000-0000-0000-0000000000b1','game_winner','KXNBAGAME','San Antonio wins',null,1,null,null,62,40,'active',now());
insert into cards (id,slate_date,sort_key,game_id,subject,player_id,team_id,market_ticker,blurb) values
 ('00000000-0000-0000-0000-0000000000c1',storyline_today(),1,'00000000-0000-0000-0000-0000000000b1','player','00000000-0000-0000-0000-0000000000a1',null,'WEMBY-30','Wemby has hit 30 in 3 straight.'),
 ('00000000-0000-0000-0000-0000000000c2',storyline_today(),2,'00000000-0000-0000-0000-0000000000b2','player','00000000-0000-0000-0000-0000000000a2',null,'CURRY-5','Curry vs the Spurs again.'),
 ('00000000-0000-0000-0000-0000000000c3',storyline_today(),3,'00000000-0000-0000-0000-0000000000b1','player','00000000-0000-0000-0000-0000000000a3',null,'KJ-8','Starting with Sochan out.'),
 ('00000000-0000-0000-0000-0000000000c4',storyline_today(),4,'00000000-0000-0000-0000-0000000000b1','team',null,1,'SAS-WIN','Spurs chasing a 15th straight win.');
insert into auth.users values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');

select 'PASS league: NBA MIN and NFL MIN coexist' where (select count(*) from teams where kalshi_abbr='MIN') = 2;
select t_err('one card per player per game',
  $q$insert into cards (slate_date,sort_key,game_id,subject,player_id,market_ticker,blurb)
     values (storyline_today(),9,'00000000-0000-0000-0000-0000000000b1','player','00000000-0000-0000-0000-0000000000a1','WEMBY-30','dupe')$q$,
  '%cards_one_per_player%');
select t_err('team card cannot also name a player',
  $q$insert into cards (slate_date,sort_key,game_id,subject,player_id,team_id,market_ticker,blurb)
     values (storyline_today(),9,'00000000-0000-0000-0000-0000000000b1','team','00000000-0000-0000-0000-0000000000a2',2,'SAS-WIN','bad')$q$,
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
update markets set result='yes' where ticker='WEMBY-30';
select t_eq('settle Wemby: 3 picks', settle_market('WEMBY-30'), 3);
select t_eq('settle again pays nothing', settle_market('WEMBY-30'), 0);
select t_eq('A main: 9000 + 1163', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 10163);
select t_eq('A contest No lost: 4500', (select balance_cents from wallet_balances where kind='contest'), 4500);
select t_eq('B lost: 9500', (select balance_cents from wallet_balances where user_id='22222222-2222-2222-2222-222222222222'), 9500);

update markets set result='scalar' where ticker='SAS-WIN';
select t_eq('void team pick', settle_market('SAS-WIN'), 1);
select t_eq('void refunds $5', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 10663);

-- insufficient funds
insert into ledger_entries (user_id,wallet_id,type,amount_cents,memo)
  select user_id,id,'adjustment',-9200,'test drain' from wallets where user_id='22222222-2222-2222-2222-222222222222';
update markets set prices_updated_at=now() where ticker='KJ-8';
set role authenticated; select as_user('22222222-2222-2222-2222-222222222222');
select t_err('B insufficient funds', $q$select place_pick('00000000-0000-0000-0000-0000000000c3','yes')$q$, 'insufficient_funds');

-- ---------------------------------------------------------------- free trades (credits)
reset role;
update markets set result = null where ticker = 'KJ-8';
insert into pick_credits (id, wallet_id, amount_cents, reason)
  select '00000000-0000-0000-0000-0000000000f1', id, 2000, 'promo' from wallets where user_id='11111111-1111-1111-1111-111111111111' and kind='main';
insert into pick_credits (id, wallet_id, amount_cents, reason)
  select '00000000-0000-0000-0000-0000000000f2', id, 2000, 'promo' from wallets where user_id='11111111-1111-1111-1111-111111111111' and kind='main';
-- Credit-funded picks placed directly by the worker for the test (no cash stake entry).
insert into picks (user_id, wallet_id, card_id, market_ticker, side, price_cents, stake_cents, contracts, credit_id)
  select '11111111-1111-1111-1111-111111111111', id, '00000000-0000-0000-0000-0000000000c3', 'KJ-8', 'yes', 40, 2000, 50, '00000000-0000-0000-0000-0000000000f1'
  from wallets where user_id='11111111-1111-1111-1111-111111111111' and kind='main';
select t_eq('A main before free trade', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 10663);
update markets set result='yes' where ticker='KJ-8';
select t_eq('settle free trade', settle_market('KJ-8'), 1);
select t_eq('free $20 @40% wins $30 winnings only (not $50)', (select payout_cents from picks where credit_id='00000000-0000-0000-0000-0000000000f1'), 3000);
select t_eq('A main after free trade win: +$30', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 13663);
select t_eq('settle free trade again pays nothing', settle_market('KJ-8'), 0);

-- void free trade -> credit reissued, no cash
update markets set result=null where ticker='CURRY-5';
insert into picks (user_id, wallet_id, card_id, market_ticker, side, price_cents, stake_cents, contracts, credit_id)
  select '11111111-1111-1111-1111-111111111111', id, '00000000-0000-0000-0000-0000000000c2', 'CURRY-5', 'no', 50, 2000, 40, '00000000-0000-0000-0000-0000000000f2'
  from wallets where user_id='11111111-1111-1111-1111-111111111111' and kind='main'
  on conflict (wallet_id, card_id) do nothing;
-- (A already has a cash pick on c2? no; c2 was locked for A) -> inserted
update markets set result='scalar' where ticker='CURRY-5';
select settle_market('CURRY-5') \g /dev/null
select t_eq('void free trade: no cash', (select balance_cents from wallet_balances where user_id='11111111-1111-1111-1111-111111111111' and kind='main'), 13663);
select t_eq('void free trade: credit reissued', (select count(*) from pick_credits where reason like 'reissued:%'), 1::bigint);
