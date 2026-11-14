-- test-adversary (STO-38): privilege leaks around the new market key and external_ids.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- ---------------------------------------------------------------- catalog-level: who holds what
-- Attack: any table/view privilege at all (incl. TRUNCATE/REFERENCES/TRIGGER) on external_ids for app roles.
select t_eq('adv38 priv: anon/authenticated hold no privilege of any kind on external_ids',
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'external_ids' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
-- Attack: column-level grants slipping in on external_ids.
select t_eq('adv38 priv: no column grants on external_ids for app roles',
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'external_ids' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
-- Attack: recreated user_affinities view picked up a grant (it must stay worker-only).
select t_eq('adv38 priv: user_affinities has no grant to anon/authenticated',
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'user_affinities' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
-- Attack: recreated card_feed got more than SELECT for authenticated, or anything for anon.
select t_eq('adv38 priv: card_feed grants are exactly SELECT to authenticated',
  (select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type)
     from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'card_feed' and grantee in ('anon', 'authenticated', 'PUBLIC')),
  'authenticated:SELECT');
-- Attack: recreated card_feed lost security_invoker (would bypass RLS on underlying tables).
select t_eq('adv38 priv: card_feed is still security_invoker',
  (select coalesce('security_invoker=true' = any(reloptions), false) from pg_class where oid = 'public.card_feed'::regclass), true);
-- Attack: the dropped-and-recreated settle_market(uuid) is executable by an app role (incl. via PUBLIC).
select t_eq('adv38 priv: settle_market(uuid) not executable by anon',
  has_function_privilege('anon', 'public.settle_market(uuid)', 'execute'), false);
select t_eq('adv38 priv: settle_market(uuid) not executable by authenticated',
  has_function_privilege('authenticated', 'public.settle_market(uuid)', 'execute'), false);
select t_eq('adv38 priv: settle_market(uuid) executable by service_role',
  has_function_privilege('service_role', 'public.settle_market(uuid)', 'execute'), true);
-- Attack: the old text overload survived and keeps a usable grant.
select t_eq('adv38 priv: old settle_market(text) overload is gone',
  (select count(*)::int from pg_proc where proname = 'settle_market' and pg_get_function_identity_arguments(oid) <> 'p_market_id uuid'), 0);
-- Attack: CREATE OR REPLACE of place_pick/snapshot_prices changed their ACLs.
select t_eq('adv38 priv: snapshot_prices not executable by authenticated',
  has_function_privilege('authenticated', 'public.snapshot_prices(interval)', 'execute'), false);
select t_eq('adv38 priv: snapshot_prices not executable by anon',
  has_function_privilege('anon', 'public.snapshot_prices(interval)', 'execute'), false);
select t_eq('adv38 priv: place_pick not executable by anon',
  has_function_privilege('anon', 'public.place_pick(uuid, pick_side, smallint, uuid)', 'execute'), false);
select t_eq('adv38 priv: place_pick still executable by authenticated',
  has_function_privilege('authenticated', 'public.place_pick(uuid, pick_side, smallint, uuid)', 'execute'), true);
-- Attack: any SECURITY DEFINER function in public callable by anon after this migration.
select t_eq('adv38 priv: no SECURITY DEFINER function in public is executable by anon',
  (select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')), null::text);
-- Attack: the new markets.id / picks.market_id / cards.market_id columns writable by authenticated.
select t_eq('adv38 priv: authenticated cannot update markets.id',
  has_column_privilege('authenticated', 'public.markets', 'id', 'update'), false);
select t_eq('adv38 priv: authenticated cannot update picks.market_id',
  has_column_privilege('authenticated', 'public.picks', 'market_id', 'update'), false);
select t_eq('adv38 priv: authenticated cannot insert into markets',
  has_table_privilege('authenticated', 'public.markets', 'insert'), false);
-- Attack: realtime publication dropped markets when its primary key was swapped.
select t_eq('adv38 priv: markets still published to realtime',
  (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'markets'), 1);
-- Coverage: external_ids RLS on with no policies (defense in depth if a grant ever slips in).
select t_eq('adv38 priv: external_ids has RLS and no policies',
  (select relrowsecurity and not exists (select 1 from pg_policies where tablename = 'external_ids')
     from pg_class where oid = 'public.external_ids'::regclass), true);

-- ---------------------------------------------------------------- behavioral: as anon
insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9000000-0000-0000-0000-0000000000e1', 'nba', 'x90', 'X90', storyline_today(), 1, 2, now() + interval '1 day', 'scheduled');
insert into markets (id, league, game_id, kind, title, team_id, status, result) values
  (mid('ADV90-A'), 'nba', 'a9000000-0000-0000-0000-0000000000e1', 'game_winner', 'A wins', 1, 'open', 'yes');
insert into external_ids (source, kind, external_id, market_id) values ('kalshi', 'market', 'ADV90-A', mid('ADV90-A'));

set role anon;
-- Attack: anon reads external_ids / user_affinities / card_feed / markets.
select t_err('adv38 priv: anon can''t read external_ids', $q$select * from external_ids$q$, 'permission denied%');
select t_err('adv38 priv: anon can''t read user_affinities', $q$select * from user_affinities$q$, 'permission denied%');
select t_err('adv38 priv: anon can''t read card_feed', $q$select * from card_feed$q$, 'permission denied%');
select t_err('adv38 priv: anon can''t read markets', $q$select id from markets$q$, 'permission denied%');
-- Attack: anon calls settlement with the new uuid signature.
select t_err('adv38 priv: anon can''t call settle_market(uuid)', $q$select settle_market(mid('ADV90-A'))$q$, 'permission denied%');
reset role;

-- ---------------------------------------------------------------- behavioral: as authenticated
set role authenticated;
select as_user('a9000000-0000-0000-0000-0000000000f1');
-- Attack: user reads user_affinities (personalization of every user).
select t_err('adv38 priv: authenticated can''t read user_affinities', $q$select * from user_affinities$q$, 'permission denied%');
-- Attack: user deletes/updates/truncates the cross-reference (would orphan markets from Kalshi).
select t_err('adv38 priv: authenticated can''t delete external_ids', $q$delete from external_ids$q$, 'permission denied%');
select t_err('adv38 priv: authenticated can''t update external_ids', $q$update external_ids set external_id = 'x'$q$, 'permission denied%');
select t_err('adv38 priv: authenticated can''t truncate external_ids', $q$truncate external_ids$q$, 'permission denied%');
-- Attack: user calls settle_market(uuid) / snapshot_prices.
select t_err('adv38 priv: authenticated can''t call settle_market(uuid)', $q$select settle_market(mid('ADV90-A'))$q$, 'permission denied%');
select t_err('adv38 priv: authenticated can''t call snapshot_prices', $q$select snapshot_prices()$q$, 'permission denied%');
-- Attack: user re-keys a market.
select t_err('adv38 priv: authenticated can''t update markets.id',
  $q$update markets set id = gen_random_uuid() where id = mid('ADV90-A')$q$, 'permission denied%');
-- Coverage: users can still read markets by the new id (the app needs it for realtime).
select t_eq('adv38 priv: authenticated can read a market by its id',
  (select title from markets where id = mid('ADV90-A')), 'A wins');
reset role;
delete from external_ids where market_id = mid('ADV90-A');
delete from markets where id = mid('ADV90-A');
