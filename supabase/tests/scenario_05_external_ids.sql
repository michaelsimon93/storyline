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

-- ---------------------------------------------------------------- our own team short code
select t_eq('teams: NBA MIN and NFL MIN share a short code across leagues',
  (select count(*)::int from teams where abbr = 'MIN'), 2);
select t_err('teams: two teams in one league can''t share a short code',
  $q$update teams set abbr = 'SAS' where id = 2$q$, '%teams_league_abbr_key%');
select t_err('teams: a short code is 2-4 capital letters',
  $q$update teams set abbr = 'sas ' where id = 1$q$, '%teams_abbr_format%');
select t_err('teams: every team has a short code',
  $q$insert into teams (league, name) values ('nba', 'No Code')$q$, '%not-null%');

set role authenticated;
select as_user('a4000000-0000-0000-0000-0000000000f1');
select t_err('external ids: users can''t read the provider cross-reference',
  $q$select * from external_ids$q$, 'permission denied%');
select t_eq('teams: users read our short code',
  (select abbr from teams where id = 1), 'SAS');
select t_eq('external ids: users still read teams, players and games',
  (select count(*)::int from games where id = 'a5500000-0000-0000-0000-0000000000e1'), 1);
select t_err('external ids: users can''t write it',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'market', 'nba', 'x', mid('X5-A'))$q$,
  'permission denied%');
reset role;

-- ---------------------------------------------------------------- privileges around the market key and external_ids (STO-38): who holds what, then the same as anon and as a user
-- ---------------------------------------------------------------- catalog-level: who holds what
-- Attack: any table/view privilege at all (incl. TRUNCATE/REFERENCES/TRIGGER) on external_ids for app roles.
select t_eq('market key priv: anon/authenticated hold no privilege of any kind on external_ids',
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'external_ids' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
-- Attack: column-level grants slipping in on external_ids.
select t_eq('market key priv: no column grants on external_ids for app roles',
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'external_ids' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
-- Attack: recreated user_affinities view picked up a grant (it must stay worker-only).
select t_eq('market key priv: user_affinities has no grant to anon/authenticated',
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'user_affinities' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
-- Attack: recreated card_feed got more than SELECT for authenticated, or anything for anon.
select t_eq('market key priv: card_feed grants are exactly SELECT to authenticated',
  (select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type)
     from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'card_feed' and grantee in ('anon', 'authenticated', 'PUBLIC')),
  'authenticated:SELECT');
-- Attack: recreated card_feed lost security_invoker (would bypass RLS on underlying tables).
select t_eq('market key priv: card_feed is still security_invoker',
  (select coalesce('security_invoker=true' = any(reloptions), false) from pg_class where oid = 'public.card_feed'::regclass), true);
-- Attack: the dropped-and-recreated settle_market(uuid) is executable by an app role (incl. via PUBLIC).
select t_eq('market key priv: settle_market(uuid) not executable by anon',
  has_function_privilege('anon', 'public.settle_market(uuid)', 'execute'), false);
select t_eq('market key priv: settle_market(uuid) not executable by authenticated',
  has_function_privilege('authenticated', 'public.settle_market(uuid)', 'execute'), false);
select t_eq('market key priv: settle_market(uuid) executable by service_role',
  has_function_privilege('service_role', 'public.settle_market(uuid)', 'execute'), true);
-- Attack: the old text overload survived and keeps a usable grant.
select t_eq('market key priv: old settle_market(text) overload is gone',
  (select count(*)::int from pg_proc where proname = 'settle_market' and pg_get_function_identity_arguments(oid) <> 'p_market_id uuid'), 0);
-- Attack: CREATE OR REPLACE of place_pick/snapshot_prices changed their ACLs.
select t_eq('market key priv: snapshot_prices not executable by authenticated',
  has_function_privilege('authenticated', 'public.snapshot_prices(interval)', 'execute'), false);
select t_eq('market key priv: snapshot_prices not executable by anon',
  has_function_privilege('anon', 'public.snapshot_prices(interval)', 'execute'), false);
select t_eq('market key priv: place_pick not executable by anon',
  has_function_privilege('anon', 'public.place_pick(uuid, pick_side, smallint, uuid)', 'execute'), false);
select t_eq('market key priv: place_pick still executable by authenticated',
  has_function_privilege('authenticated', 'public.place_pick(uuid, pick_side, smallint, uuid)', 'execute'), true);
-- Attack: any SECURITY DEFINER function in public callable by anon after this migration.
select t_eq('market key priv: no SECURITY DEFINER function in public is executable by anon',
  (select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')), null::text);
-- Attack: the new markets.id / picks.market_id / cards.market_id columns writable by authenticated.
select t_eq('market key priv: authenticated cannot update markets.id',
  has_column_privilege('authenticated', 'public.markets', 'id', 'update'), false);
select t_eq('market key priv: authenticated cannot update picks.market_id',
  has_column_privilege('authenticated', 'public.picks', 'market_id', 'update'), false);
select t_eq('market key priv: authenticated cannot insert into markets',
  has_table_privilege('authenticated', 'public.markets', 'insert'), false);
-- Attack: realtime publication dropped markets when its primary key was swapped.
select t_eq('market key priv: markets still published to realtime',
  (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'markets'), 1);
-- Coverage: external_ids RLS on with no policies (defense in depth if a grant ever slips in).
select t_eq('market key priv: external_ids has RLS and no policies',
  (select relrowsecurity and not exists (select 1 from pg_policies where tablename = 'external_ids')
     from pg_class where oid = 'public.external_ids'::regclass), true);

-- ---------------------------------------------------------------- behavioral: as anon
insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9000000-0000-0000-0000-0000000000e1', 'nba', storyline_today(), 23, 24, now() + interval '1 day', 'scheduled');
insert into markets (id, league, game_id, kind, title, team_id, status, result) values
  (mid('ADV90-A'), 'nba', 'a9000000-0000-0000-0000-0000000000e1', 'game_winner', 'A wins', 1, 'open', 'yes');
insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'market', 'nba', 'ADV90-A', mid('ADV90-A'));

set role anon;
-- Attack: anon reads external_ids / user_affinities / card_feed / markets.
select t_err('market key priv: anon can''t read external_ids', $q$select * from external_ids$q$, 'permission denied%');
select t_err('market key priv: anon can''t read user_affinities', $q$select * from user_affinities$q$, 'permission denied%');
select t_err('market key priv: anon can''t read card_feed', $q$select * from card_feed$q$, 'permission denied%');
select t_err('market key priv: anon can''t read markets', $q$select id from markets$q$, 'permission denied%');
-- Attack: anon calls settlement with the new uuid signature.
select t_err('market key priv: anon can''t call settle_market(uuid)', $q$select settle_market(mid('ADV90-A'))$q$, 'permission denied%');
reset role;

-- ---------------------------------------------------------------- behavioral: as authenticated
set role authenticated;
select as_user('a9000000-0000-0000-0000-0000000000f1');
-- Attack: user reads user_affinities (personalization of every user).
select t_err('market key priv: authenticated can''t read user_affinities', $q$select * from user_affinities$q$, 'permission denied%');
-- Attack: user deletes/updates/truncates the cross-reference (would orphan markets from Kalshi).
select t_err('market key priv: authenticated can''t delete external_ids', $q$delete from external_ids$q$, 'permission denied%');
select t_err('market key priv: authenticated can''t update external_ids', $q$update external_ids set external_id = 'x'$q$, 'permission denied%');
select t_err('market key priv: authenticated can''t truncate external_ids', $q$truncate external_ids$q$, 'permission denied%');
-- Attack: user calls settle_market(uuid) / snapshot_prices.
select t_err('market key priv: authenticated can''t call settle_market(uuid)', $q$select settle_market(mid('ADV90-A'))$q$, 'permission denied%');
select t_err('market key priv: authenticated can''t call snapshot_prices', $q$select snapshot_prices()$q$, 'permission denied%');
-- Attack: user re-keys a market.
select t_err('market key priv: authenticated can''t update markets.id',
  $q$update markets set id = gen_random_uuid() where id = mid('ADV90-A')$q$, 'permission denied%');
-- Coverage: users can still read markets by the new id (the app needs it for realtime).
select t_eq('market key priv: authenticated can read a market by its id',
  (select title from markets where id = mid('ADV90-A')), 'A wins');
reset role;
delete from external_ids where market_id = mid('ADV90-A');
delete from markets where id = mid('ADV90-A');

-- ---------------------------------------------------------------- money path after the re-key, and integrity holes in external_ids (STO-38)
-- ---------------------------------------------------------------- seed: 2 games, 4 team markets
insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9100000-0000-0000-0000-0000000000e1', 'nba', storyline_today(), 25, 26, now() + interval '1 day', 'scheduled'),
  ('a9100000-0000-0000-0000-0000000000e2', 'nba', storyline_today(), 27, 28, now() + interval '1 day', 'scheduled');
insert into markets (id, league, game_id, kind, title, team_id, yes_ask_cents, no_ask_cents, status, prices_updated_at) values
  (mid('ADV91-W'),  'nba', 'a9100000-0000-0000-0000-0000000000e1', 'game_winner', 'Team1 wins G1', 1, 1,  99, 'open', now()),
  (mid('ADV91-L'),  'nba', 'a9100000-0000-0000-0000-0000000000e1', 'game_winner', 'Team2 wins G1', 2, 99, 2,  'open', now()),
  (mid('ADV91-V'),  'nba', 'a9100000-0000-0000-0000-0000000000e2', 'game_winner', 'Team1 wins G2', 1, 40, 61, 'open', now()),
  (mid('ADV91-FV'), 'nba', 'a9100000-0000-0000-0000-0000000000e2', 'game_winner', 'Team2 wins G2', 2, 40, 61, 'open', now());
insert into external_ids (source, kind, league, external_id, market_id) values
  ('kalshi', 'market', 'nba', 'ADV91-W', mid('ADV91-W')), ('kalshi', 'market', 'nba', 'ADV91-L', mid('ADV91-L')),
  ('kalshi', 'market', 'nba', 'ADV91-V', mid('ADV91-V')), ('kalshi', 'market', 'nba', 'ADV91-FV', mid('ADV91-FV'));
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
select t_eq('market key money: pick @1c records the card''s market id',
  (select market_id from place_pick('a9100000-0000-0000-0000-0000000000c1', 'yes')), mid('ADV91-W'));
select t_eq('market key money: pick @2c (No) records the card''s market id',
  (select market_id from place_pick('a9100000-0000-0000-0000-0000000000c2', 'no')), mid('ADV91-L'));
select t_eq('market key money: cash pick on the void market', (select price_cents from place_pick('a9100000-0000-0000-0000-0000000000c3', 'yes')), 40::smallint);
select t_eq('market key money: balance after 3 x $5 stakes', (select balance_cents from wallet_balances), 8500);
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
select t_eq('market key money: first settlement of 4 markets settles 4 picks',
  settle_market(mid('ADV91-W')) + settle_market(mid('ADV91-L')) + settle_market(mid('ADV91-V')) + settle_market(mid('ADV91-FV')), 4);
select t_eq('market key money: second settlement settles nothing',
  settle_market(mid('ADV91-W')) + settle_market(mid('ADV91-L')) + settle_market(mid('ADV91-V')) + settle_market(mid('ADV91-FV')), 0);
-- Boundary: $5 @1c pays $500 exactly; $5 @2c (No) pays $250.
select t_eq('market key money: $5 @1c pays 50000c', (select payout_cents from picks where market_id = mid('ADV91-W')), 50000);
select t_eq('market key money: $5 @2c pays 25000c', (select payout_cents from picks where market_id = mid('ADV91-L')), 25000);
select t_eq('market key money: void cash pick refunds the stake once',
  (select count(*)::int || ':' || sum(amount_cents) from ledger_entries le join picks p on p.id = le.pick_id
    where p.market_id = mid('ADV91-V') and le.type = 'pick_refund'), '1:500');
select t_eq('market key money: void free trade reissues the credit exactly once, no cash',
  (select count(*)::int from pick_credits where reason like 'reissued: voided free trade %'
     and wallet_id = (select id from wallets where user_id = 'a9100000-0000-0000-0000-0000000000a1'))
  || ':' || (select count(*)::int from ledger_entries le join picks p on p.id = le.pick_id where p.market_id = mid('ADV91-FV')), '1:0');
-- Invariant: every settled pick has exactly one outcome entry (cash) / none (free void/loss).
select t_eq('market key money: no settled cash pick has more than one outcome entry',
  (select count(*)::int from (select le.pick_id from ledger_entries le join picks p on p.id = le.pick_id
     where p.user_id = 'a9100000-0000-0000-0000-0000000000a1' and le.type in ('pick_payout', 'pick_refund')
     group by le.pick_id having count(*) > 1) x), 0);
-- Invariant: money conserved. 10000 - 1500 stakes + 50000 + 25000 + 500 refund.
select t_eq('market key money: final balance is exactly grants - stakes + payouts',
  (select balance_cents from wallet_balances w join wallets ww on ww.id = w.wallet_id where ww.user_id = 'a9100000-0000-0000-0000-0000000000a1'),
  10000 - 1500 + 50000 + 25000 + 500);
-- Hostile/odd input: unknown or null market id.
select t_eq('market key money: settle_market on an unknown id is a no-op', settle_market(gen_random_uuid()), 0);
select t_eq('market key money: settle_market(null) is a no-op', settle_market(null), 0);

-- ---------------------------------------------------------------- integrity: deletes and re-keys
select t_err('external ids integrity: a market with picks can''t be deleted',
  $q$delete from markets where id = mid('ADV91-W')$q$, '%foreign key%');
select t_eq('external ids integrity: its Kalshi id survives the failed delete',
  (select count(*)::int from external_ids where market_id = mid('ADV91-W')), 1);
select t_err('external ids integrity: a market with picks can''t be re-keyed',
  $q$update markets set id = gen_random_uuid() where id = mid('ADV91-W')$q$, '%foreign key%');
select t_err('external ids integrity: a provider id can''t be re-pointed at a market that already has one',
  $q$update external_ids set market_id = mid('ADV91-L') where external_id = 'ADV91-W'$q$, '%external_ids_one_per_market%');
select t_err('external ids integrity: unknown kind rejected',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'player', 'nba', 'p1', mid('ADV91-W'))$q$, '%check%');
select t_err('external ids integrity: provider name with trailing space rejected',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi ', 'market', 'nba', 'ADV91-W', mid('ADV91-L'))$q$, '%external_ids_source_check%');
select t_err('external ids integrity: external_ids can''t point at a market that doesn''t exist',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('otherx', 'market', 'nba', 'ghost', gen_random_uuid())$q$, '%foreign key%');

-- Attack: an empty provider id is accepted and silently claims a market's one Kalshi slot.
-- (Distinct team totals: two game-winner markets for the same team would be the same market.)
insert into markets (id, league, game_id, kind, title, team_id, stat, strike, status) values
  (mid('ADV91-E'), 'nba', 'a9100000-0000-0000-0000-0000000000e2', 'team_stat', 'empty id', 1, 'points', 100.5, 'open'),
  (mid('ADV91-S'), 'nba', 'a9100000-0000-0000-0000-0000000000e2', 'team_stat', 'spaced id', 1, 'points', 101.5, 'open');
select t_err('external ids integrity: an empty external_id is rejected',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'market', 'nba', '', mid('ADV91-E'))$q$, '%check%');
-- Attack: a whitespace-padded copy of an existing ticker becomes a second market for the same Kalshi market.
select t_err('external ids integrity: a whitespace-padded duplicate of an existing ticker is rejected',
  $q$insert into external_ids (source, kind, league, external_id, market_id) values ('kalshi', 'market', 'nba', 'ADV91-W ', mid('ADV91-S'))$q$, '%check%');
delete from external_ids where market_id in (mid('ADV91-E'), mid('ADV91-S'));
delete from markets where id in (mid('ADV91-E'), mid('ADV91-S'));

-- ---------------------------------------------------------------- integrity and privilege attacks on the team/player/game cross-reference (STO-39)
-- Two games on one far-future slate (no clash with other scenarios' matchups).
insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9200000-0000-0000-0000-0000000000e1', 'nba', storyline_today() + 30, 11, 12, now() + interval '30 days', 'scheduled'),
  ('a9200000-0000-0000-0000-0000000000e2', 'nba', storyline_today() + 30, 12, 11, now() + interval '30 days', 'scheduled'),
  ('a9200000-0000-0000-0000-0000000000e3', 'nba', storyline_today() + 31, 13, 14, now() + interval '31 days', 'scheduled');
insert into external_ids (source, kind, league, external_id, game_id) values
  ('espn',   'game', 'nba', 'q92', 'a9200000-0000-0000-0000-0000000000e1'),
  ('kalshi', 'game', 'nba', 'Q92KEY', 'a9200000-0000-0000-0000-0000000000e1');

-- ---------------------------------------------------------------- one ESPN event per slate
-- The database no longer enforces "one ESPN event is at most one game per slate" or
-- "one Kalshi game key per game": games are identified by matchup (games_identity, Michael's call
-- on STO-39), which accepts that tradeoff rather than storing the slate on each game ID. Ingest
-- enforces it instead: worker/test/ingest.integration.test.ts, "one ESPN event never becomes
-- two games on one slate".
-- Coverage: the replay case (same ESPN event, different slate) is still allowed.
select t_eq('external ids: one ESPN event may be a game on another slate (a postponed game replayed)',
  (select t_err('x', $q$insert into external_ids (source, kind, league, external_id, game_id)
     values ('espn', 'game', 'nba', 'q92', 'a9200000-0000-0000-0000-0000000000e3')$q$, '%') like 'FAIL%'), true);
delete from external_ids where game_id = 'a9200000-0000-0000-0000-0000000000e3';

-- ---------------------------------------------------------------- league tie (composite FK)
-- Attack: re-point an existing ID row at a row from another league via UPDATE (not INSERT).
insert into external_ids (source, kind, league, external_id, team_id) values ('qa', 'team', 'nba', 'QA92', 11);
select t_err('external ids: a team ID can''t be moved to a team in another league by update',
  $q$update external_ids set team_id = 4 where source = 'qa' and external_id = 'QA92'$q$, '%foreign key%');
select t_err('external ids: an ID row''s league can''t be changed away from its row''s league',
  $q$update external_ids set league = 'nfl' where source = 'qa' and external_id = 'QA92'$q$, '%foreign key%');
-- Attack: change a referenced team's league out from under its provider IDs.
select t_err('external ids: a team''s league can''t change while it has provider IDs',
  $q$update teams set league = 'nfl' where id = 11$q$, '%foreign key%');
-- Attack: change kind on an existing row so it no longer matches its column.
select t_err('external ids: an ID row''s kind can''t be switched to another kind',
  $q$update external_ids set kind = 'player' where source = 'qa' and external_id = 'QA92'$q$, '%external_ids_points_at_one%');
-- Attack: an empty or blank provider ID for a team/player/game (market had this check in STO-38).
select t_err('external ids: an empty team ID is rejected',
  $q$insert into external_ids (source, kind, league, external_id, team_id) values ('qa2', 'team', 'nba', '', 12)$q$, '%check%');
select t_err('external ids: a null league is rejected',
  $q$insert into external_ids (source, kind, external_id, team_id) values ('qa3', 'team', 'X', 12)$q$, '%null%');
delete from external_ids where source = 'qa';

-- Coverage: cascade on team/game deletion removes their IDs (not left dangling).
insert into teams (id, league, name, abbr) values (91, 'nba', 'QA cascade', 'QAC');
insert into external_ids (source, kind, league, external_id, team_id) values ('espn', 'team', 'nba', 'qa91', 91);
delete from teams where id = 91;
select t_eq('external ids: deleting a team removes its provider IDs',
  (select count(*)::int from external_ids where external_id = 'qa91'), 0);

-- ---------------------------------------------------------------- privileges
-- Attack: the new identity sequence on external_ids picked up Supabase's default grants.
select t_eq('external ids priv: anon/authenticated have no privilege on external_ids'' id sequence',
  (select count(*)::int from information_schema.role_usage_grants
    where object_schema = 'public' and object_name = pg_get_serial_sequence('external_ids', 'id')::regclass::text
      and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('external ids priv: authenticated can''t use external_ids'' id sequence',
  has_sequence_privilege('authenticated', pg_get_serial_sequence('external_ids', 'id'), 'usage'), false);
-- Attack: users write teams/players/games directly (they hold only our IDs now, but are still core data).
set role authenticated;
select as_user('a4000000-0000-0000-0000-0000000000f1');
select t_err('external ids priv: users can''t insert a team', $q$insert into teams (league, name) values ('nba', 'x')$q$, 'permission denied%');
select t_err('external ids priv: users can''t insert a player', $q$insert into players (league, full_name) values ('nba', 'x')$q$, 'permission denied%');
select t_err('external ids priv: users can''t update a game',
  $q$update games set status = 'final' where id = 'a9200000-0000-0000-0000-0000000000e1'$q$, 'permission denied%');
select t_err('external ids priv: users can''t reach provider IDs by joining from games',
  $q$select x.external_id from games g join external_ids x on x.game_id = g.id$q$, 'permission denied%');
reset role;
set role anon;
select t_err('external ids priv: anon can''t read external_ids', $q$select count(*) from external_ids$q$, 'permission denied%');
reset role;
delete from games where id::text like 'a9200000%';
