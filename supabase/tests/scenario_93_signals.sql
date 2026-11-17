-- STO-10 part 2: the signals table and store_signals. Duplicates first, then privileges.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9300000-0000-0000-0000-0000000000e1', 'nba', storyline_today() + 60, 29, 30, now() + interval '1 day', 'scheduled');
insert into players (id, league, full_name, team_id) values ('a9300000-0000-0000-0000-0000000000b1', 'nba', 'Sig Player', 29);
insert into pipeline_runs (id, job, slate_date, status) values (930001, 'context:test', storyline_today(), 'ok'), (930002, 'context:test', storyline_today(), 'ok');

create function sig(k text, summ text, at text, trust text default 'verified') returns jsonb language sql as $$
  select jsonb_build_object('kind', 'stat', 'subject', jsonb_build_object('kind', 'player', 'id', 'a9300000-0000-0000-0000-0000000000b1'),
    'summary', summ, 'evidence', jsonb_build_object('url', 'https://x.test/' || k, 'observedAt', at), 'trust', trust, 'key', k) $$;

-- ------------------------------------------------ re-running is safe
select store_signals(930001, 'espn', storyline_today(), jsonb_build_array(sig('last5:pts', 'v1', '2026-11-17T10:00:00Z'), sig('last5:reb', 'r1', '2026-11-17T10:00:00Z'))) \g /dev/null
select t_eq('sig: first run stores two signals', (select count(*)::int from signals where source = 'espn'), 2);
create temp table ids as select key, id from signals;
select store_signals(930002, 'espn', storyline_today(), jsonb_build_array(sig('last5:pts', 'v1', '2026-11-17T10:00:00Z'), sig('last5:reb', 'r1', '2026-11-17T10:00:00Z'))) \g /dev/null
select t_eq('sig: re-run adds no duplicates', (select count(*)::int from signals where source = 'espn'), 2);
select t_eq('sig: ids are stable across re-runs (blurbs cite them)',
  (select count(*)::int from signals s join ids i using (key, id)), 2);
select t_eq('sig: re-run re-stamps run_id so the newest ok run owns what it saw',
  (select count(*)::int from signals where run_id = 930002), 2);
-- newer sighting refreshes; older one doesn't
select store_signals(930002, 'espn', storyline_today(), jsonb_build_array(sig('last5:pts', 'v2', '2026-11-17T11:00:00Z'))) \g /dev/null
select t_eq('sig: newer sighting refreshes summary', (select summary from signals where key = 'last5:pts'), 'v2');
select t_eq('sig: ...and observed_at', (select observed_at from signals where key = 'last5:pts'), '2026-11-17T11:00:00Z'::timestamptz);
select store_signals(930002, 'espn', storyline_today(), jsonb_build_array(sig('last5:pts', 'stale', '2026-11-17T09:00:00Z'))) \g /dev/null
select t_eq('sig: older sighting does not overwrite', (select summary from signals where key = 'last5:pts'), 'v2');
-- an older run replayed can't take ownership back
insert into pipeline_runs (id, job, slate_date, status) values (930003, 'context:test', storyline_today(), 'ok');
select store_signals(930001, 'espn', storyline_today(), jsonb_build_array(sig('last5:pts', 'v2', '2026-11-17T11:00:00Z'))) \g /dev/null
select t_eq('sig: replaying an older run does not reclaim run_id', (select run_id from signals where key = 'last5:pts'), 930002::bigint);
-- same fact twice in one batch
select store_signals(930003, 'espn', storyline_today(), jsonb_build_array(sig('dup', 'a', '2026-11-17T10:00:00Z'), sig('dup', 'b', '2026-11-17T12:00:00Z'))) \g /dev/null
select t_eq('sig: same key twice in one batch stores once, newest wins', (select summary from signals where key = 'dup'), 'b');
-- same key, different source / day / subject are different facts
select store_signals(930003, 'other', storyline_today(), jsonb_build_array(sig('dup', 'c', '2026-11-17T10:00:00Z'))) \g /dev/null
select store_signals(930003, 'espn', storyline_today() - 1, jsonb_build_array(sig('dup', 'd', '2026-11-17T10:00:00Z'))) \g /dev/null
select t_eq('sig: other source and other day are separate signals', (select count(*)::int from signals where key = 'dup'), 3);
select store_signals(930003, 'espn', storyline_today(), jsonb_build_array(jsonb_build_object('kind', 'news',
  'subject', jsonb_build_object('kind', 'game', 'id', 'a9300000-0000-0000-0000-0000000000e1'),
  'summary', 'g', 'evidence', jsonb_build_object('quote', 'q', 'observedAt', '2026-11-17T10:00:00Z'), 'trust', 'attributed', 'key', 'dup'))) \g /dev/null
select t_eq('sig: other subject is a separate signal; game subject and quote evidence work',
  (select count(*)::int from signals where key = 'dup' and game_id is not null and evidence = '{"quote":"q"}'), 1);
select t_eq('sig: observedAt moves to its own column, not evidence',
  (select evidence ? 'observedAt' from signals where key = 'last5:pts'), false);
-- integrity
select t_err('sig: table rejects a duplicate directly',
  $q$insert into signals (source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id)
     select source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id from signals where key = 'last5:pts'$q$,
  '%signals_one_per_day%');
select t_err('sig: needs exactly one subject',
  $q$insert into signals (source, kind, slate_date, key, summary, evidence, observed_at, trust, run_id)
     values ('espn', 'stat', storyline_today(), 'k', 's', '{"url":"u"}', now(), 'verified', 930001)$q$, '%signals_check%');
select t_err('sig: unknown subject player is rejected',
  format($q$select store_signals(930001, 'espn', storyline_today(), %L::jsonb)$q$,
    jsonb_build_array(jsonb_set(sig('x', 's', '2026-11-17T10:00:00Z'), '{subject,id}', '"a9300000-0000-0000-0000-0000000000ff"'))), '%foreign key%');
select t_err('sig: evidence needs a url or quote',
  format($q$select store_signals(930001, 'espn', storyline_today(), %L::jsonb)$q$,
    jsonb_build_array(jsonb_set(sig('y', 's', '2026-11-17T10:00:00Z'), '{evidence}', '{"observedAt":"2026-11-17T10:00:00Z"}'))), '%signals_evidence_check%');
select t_err('sig: bad trust level is rejected',
  format($q$select store_signals(930001, 'espn', storyline_today(), %L::jsonb)$q$, jsonb_build_array(sig('z', 's', '2026-11-17T10:00:00Z', 'certain'))), '%signal_trust%');
select t_eq('sig: a rejected batch stores nothing from it', (select count(*)::int from signals where key in ('x', 'y', 'z')), 0);

-- ------------------------------------------------ can't do it: app roles
select t_eq('sig priv: no privilege of any kind on signals for anon/authenticated/PUBLIC',
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'signals' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('sig priv: no column grants on signals for app roles',
  (select count(*)::int from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'signals' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('sig priv: signals has RLS and no policies',
  (select relrowsecurity and not exists (select 1 from pg_policies where tablename = 'signals') from pg_class where oid = 'public.signals'::regclass), true);
select t_eq('sig priv: store_signals only for service_role',
  (select array[has_function_privilege('anon', 'public.store_signals(bigint,text,date,jsonb)', 'execute'),
                has_function_privilege('authenticated', 'public.store_signals(bigint,text,date,jsonb)', 'execute'),
                has_function_privilege('service_role', 'public.store_signals(bigint,text,date,jsonb)', 'execute')]), array[false, false, true]);
set role anon;
select t_err('sig priv: anon can''t read signals', $q$select * from signals$q$, 'permission denied%');
select t_err('sig priv: anon can''t write signals', $q$delete from signals$q$, 'permission denied%');
select t_err('sig priv: anon can''t call store_signals', $q$select store_signals(930001, 'espn', storyline_today(), '[]')$q$, 'permission denied%');
reset role;
set role authenticated;
select as_user('a9300000-0000-0000-0000-0000000000f1');
select t_err('sig priv: authenticated can''t read signals', $q$select * from signals$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t insert signals', $q$insert into signals (source) values ('x')$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t update signals', $q$update signals set summary = 'x'$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t delete signals', $q$delete from signals$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t truncate signals', $q$truncate signals$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t call store_signals', $q$select store_signals(930001, 'espn', storyline_today(), '[]')$q$, 'permission denied%');
reset role;
