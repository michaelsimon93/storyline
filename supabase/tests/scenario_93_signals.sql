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
select t_eq('sig: the re-run is recorded as seeing both signals; the first run still has its sightings',
  (select array[(select count(*)::int from signal_sightings where run_id = 930001), (select count(*)::int from signal_sightings where run_id = 930002)]), array[2, 2]);
-- newer sighting refreshes; older one doesn't
select store_signals(930002, 'espn', storyline_today(), jsonb_build_array(sig('last5:pts', 'v2', '2026-11-17T11:00:00Z'))) \g /dev/null
select t_eq('sig: newer sighting refreshes summary', (select summary from signals where key = 'last5:pts'), 'v2');
select t_eq('sig: ...and observed_at', (select observed_at from signals where key = 'last5:pts'), '2026-11-17T11:00:00Z'::timestamptz);
select store_signals(930002, 'espn', storyline_today(), jsonb_build_array(sig('last5:pts', 'stale', '2026-11-17T09:00:00Z'))) \g /dev/null
select t_eq('sig: older sighting does not overwrite', (select summary from signals where key = 'last5:pts'), 'v2');
-- an older run replayed can't take ownership back
insert into pipeline_runs (id, job, slate_date, status) values (930003, 'context:test', storyline_today(), 'ok');
select store_signals(930001, 'espn', storyline_today(), jsonb_build_array(sig('last5:pts', 'v2', '2026-11-17T11:00:00Z'))) \g /dev/null
select t_eq('sig: replaying an older run changes neither first-storing run_id nor the text',
  (select run_id || '/' || summary from signals where key = 'last5:pts'), '930001/v2');
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
select t_eq('sig priv: signals and signal_sightings have RLS and no policies',
  (select bool_and(relrowsecurity) and not exists (select 1 from pg_policies where tablename in ('signals', 'signal_sightings'))
     from pg_class where oid in ('public.signals'::regclass, 'public.signal_sightings'::regclass)), true);
select t_eq('sig priv: no privilege of any kind on signal_sightings for app roles',
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'signal_sightings' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('sig priv: store_signals only for service_role',
  (select array[has_function_privilege('anon', 'public.store_signals(bigint,text,date,jsonb)', 'execute'),
                has_function_privilege('authenticated', 'public.store_signals(bigint,text,date,jsonb)', 'execute'),
                has_function_privilege('service_role', 'public.store_signals(bigint,text,date,jsonb)', 'execute')]), array[false, false, true]);
set role anon;
select t_err('sig priv: anon can''t read signals', $q$select * from signals$q$, 'permission denied%');
select t_err('sig priv: anon can''t write signals', $q$delete from signals$q$, 'permission denied%');
select t_err('sig priv: anon can''t read signal_sightings', $q$select * from signal_sightings$q$, 'permission denied%');
select t_err('sig priv: anon can''t call store_signals', $q$select store_signals(930001, 'espn', storyline_today(), '[]')$q$, 'permission denied%');
reset role;
set role authenticated;
select as_user('a9300000-0000-0000-0000-0000000000f1');
select t_err('sig priv: authenticated can''t read signals', $q$select * from signals$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t insert signals', $q$insert into signals (source) values ('x')$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t update signals', $q$update signals set summary = 'x'$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t delete signals', $q$delete from signals$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t read signal_sightings', $q$select * from signal_sightings$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t write signal_sightings', $q$insert into signal_sightings values (1, 1)$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t truncate signals', $q$truncate signals$q$, 'permission denied%');
select t_err('sig priv: authenticated can''t call store_signals', $q$select store_signals(930001, 'espn', storyline_today(), '[]')$q$, 'permission denied%');
reset role;

-- ---------------------------------------------------------------- store_signals under hostile input, run ownership for the ESPN-down fallback, and integrity of signals (STO-10 part 2)
insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9400000-0000-0000-0000-0000000000e1', 'nba', storyline_today() + 61, 29, 30, now() + interval '1 day', 'scheduled');
insert into players (id, league, full_name, team_id) values ('a9400000-0000-0000-0000-0000000000b1', 'nba', 'QA Sig Player', 29);
insert into pipeline_runs (id, job, slate_date, status) values
  (940001, 'context:qa', storyline_today(), 'ok'),
  (940002, 'context:qa', storyline_today(), 'ok'),
  (940003, 'context:qa', storyline_today(), 'ok');

create function qsig(k text, summ text, at text, pid text default 'a9400000-0000-0000-0000-0000000000b1') returns jsonb language sql as $$
  select jsonb_build_object('kind', 'stat', 'subject', jsonb_build_object('kind', 'player', 'id', pid),
    'summary', summ, 'evidence', jsonb_build_object('url', 'https://x.test/' || k, 'observedAt', at), 'trust', 'verified', 'key', k) $$;
create function qstore(run bigint, src text, sigs jsonb) returns text language sql as $$
  select format('select store_signals(%s, %L, storyline_today(), %L::jsonb)', run, src, sigs) $$;
create function qok(q text) returns text language plpgsql as $$
begin execute q; return 'ok'; exception when others then return sqlerrm; end $$;

-- ------------------------------------------------ ESPN-down fallback: ownership (designed-for, part 3)
-- attacks: a run that stores signals then FAILS (withRun is not a transaction, store_signals autocommits)
-- re-stamps run_id to a failed run, so "signals of the newest ok run" loses them.
select store_signals(940001, 'qa-own', storyline_today(), jsonb_build_array(qsig('own:a', 'ok-run', '2026-11-17T10:00:00Z'))) \g /dev/null
insert into pipeline_runs (id, job, slate_date, status) values (940010, 'context:qa', storyline_today(), 'running');
select store_signals(940010, 'qa-own', storyline_today(), jsonb_build_array(qsig('own:a', 'ok-run', '2026-11-17T10:00:00Z'))) \g /dev/null
update pipeline_runs set status = 'failed' where id = 940010;
select t_eq('sig: fallback still finds the last ok run''s signal after a later run stored it then failed',
  (select count(*)::int from signal_sightings ss join signals sg on sg.id = ss.signal_id
    where sg.source = 'qa-own'
      and ss.run_id = (select max(id) from pipeline_runs where job = 'context:qa' and status = 'ok' and id in (940001, 940010))), 1);

-- ------------------------------------------------ in-batch dedup is on raw text, the constraint is on typed ids
-- attacks: the same player uuid in upper and lower case in one batch; distinct-on sees two drafts, the
-- unique constraint sees one row, so ON CONFLICT hits the same row twice and the whole batch errors.
select t_eq('sig: same subject uuid in different case in one batch stores one signal (no error)',
  qok(qstore(940002, 'qa-case', jsonb_build_array(
     qsig('case:k', 'lower', '2026-11-17T10:00:00Z'),
     qsig('case:k', 'upper', '2026-11-17T11:00:00Z', 'A9400000-0000-0000-0000-0000000000B1')))), 'ok');
-- attacks: the same across two runs is fine (typed constraint), proving it's only the in-batch dedup
select store_signals(940002, 'qa-case2', storyline_today(), jsonb_build_array(qsig('case:k', 'lower', '2026-11-17T10:00:00Z'))) \g /dev/null
select store_signals(940003, 'qa-case2', storyline_today(), jsonb_build_array(qsig('case:k', 'upper', '2026-11-17T11:00:00Z', 'A9400000-0000-0000-0000-0000000000B1'))) \g /dev/null
select t_eq('sig: differently-cased uuid across runs is the same signal (coverage)',
  (select count(*)::int || '/' || min(summary) from signals where source = 'qa-case2'), '1/upper');

-- ------------------------------------------------ newer sighting vs. run-id guard
-- attacks: the run_id guard (excluded.run_id >= signals.run_id) gates the WHOLE update, so a newer sighting
-- from a lower-numbered (overlapping) run is dropped, contradicting "text moves only to a newer sighting".
select store_signals(940003, 'qa-order', storyline_today(), jsonb_build_array(qsig('order:k', 'older-text', '2026-11-17T10:00:00Z'))) \g /dev/null
select store_signals(940002, 'qa-order', storyline_today(), jsonb_build_array(qsig('order:k', 'newer-text', '2026-11-17T12:00:00Z'))) \g /dev/null
select t_eq('sig: a newer sighting refreshes text even if its run id is lower (first-storing run_id is kept)',
  (select summary || '/' || run_id from signals where source = 'qa-order'), 'newer-text/940003');

-- ------------------------------------------------ observedAt formats
-- attacks: 'infinity' is a valid timestamptz; stored, it blocks every future refresh of that signal.
select t_err('sig: observedAt ''infinity'' is rejected',
  qstore(940002, 'qa-ts', jsonb_build_array(qsig('ts:inf', 's', 'infinity'))), '%');
select t_eq('sig: ...and no infinity row was stored', (select count(*)::int from signals where source = 'qa-ts' and key = 'ts:inf'), 0);
-- attacks: an observedAt with no offset is read in the session TimeZone, silently shifting the signal's date.
set timezone = 'America/New_York';
select t_err('sig: observedAt without a UTC offset is rejected (not read in session time zone)',
  qstore(940002, 'qa-ts', jsonb_build_array(qsig('ts:naive', 's', '2026-11-17T10:00:00'))), '%');
reset timezone;
-- coverage: a missing observedAt is rejected (not null)
select t_err('sig: missing observedAt is rejected',
  qstore(940002, 'qa-ts', jsonb_build_array(qsig('ts:none', 's', null))), '%observed_at%');
-- coverage: garbage observedAt is rejected
select t_err('sig: garbage observedAt is rejected',
  qstore(940002, 'qa-ts', jsonb_build_array(qsig('ts:junk', 's', 'yesterday-ish'))), '%timestamp%');

-- ------------------------------------------------ evidence
-- attacks: evidence ? 'url' is true for {"url": null}, so a signal with no url and no quote gets in.
select t_err('sig: evidence {"url": null} is rejected (no real url or quote)',
  qstore(940002, 'qa-ev', jsonb_build_array(jsonb_set(qsig('ev:null', 's', '2026-11-17T10:00:00Z'), '{evidence}',
    '{"url": null, "observedAt": "2026-11-17T10:00:00Z"}'))), '%');
-- coverage: evidence that is not an object is rejected
select t_err('sig: evidence as a string is rejected',
  qstore(940002, 'qa-ev', jsonb_build_array(jsonb_set(qsig('ev:str', 's', '2026-11-17T10:00:00Z'), '{evidence}', '"https://x.test"'))), '%');

-- ------------------------------------------------ subjects (coverage)
select t_err('sig: missing subject is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(qsig('s:none', 's', '2026-11-17T10:00:00Z') - 'subject')), '%signals_check%');
select t_err('sig: unknown subject kind is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_set(qsig('s:coach', 's', '2026-11-17T10:00:00Z'), '{subject,kind}', '"coach"'))), '%signals_check%');
select t_err('sig: subject kind team with a player uuid is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_set(qsig('s:mis', 's', '2026-11-17T10:00:00Z'), '{subject,kind}', '"team"'))), '%smallint%');
select t_err('sig: subject kind game with a player uuid is rejected (FK)',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_set(qsig('s:mis2', 's', '2026-11-17T10:00:00Z'), '{subject,kind}', '"game"'))), '%foreign key%');
select t_err('sig: subject id null is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_set(qsig('s:nullid', 's', '2026-11-17T10:00:00Z'), '{subject,id}', 'null'))), '%signals_check%');
select t_err('sig: unknown team id is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_build_object('kind', 'stat', 'subject', jsonb_build_object('kind', 'team', 'id', 9999),
    'summary', 's', 'evidence', jsonb_build_object('url', 'u', 'observedAt', '2026-11-17T10:00:00Z'), 'trust', 'verified', 'key', 's:t'))), '%foreign key%');
select store_signals(940002, 'qa-subj', storyline_today(), jsonb_build_array(jsonb_build_object('kind', 'injury',
  'subject', jsonb_build_object('kind', 'team', 'id', 29),
  'summary', 'team sig', 'evidence', jsonb_build_object('url', 'u', 'observedAt', '2026-11-17T10:00:00Z'), 'trust', 'unreviewed', 'key', 's:team'))) \g /dev/null
select t_eq('sig: a team subject (numeric JSON id) is stored on team_id only',
  (select count(*)::int from signals where source = 'qa-subj' and team_id = 29 and player_id is null and game_id is null), 1);
select t_eq('sig: only the valid team signal from the subject attacks was stored',
  (select count(*)::int from signals where source = 'qa-subj'), 1);

-- ------------------------------------------------ other fields and batch shapes (coverage)
select t_err('sig: missing key is rejected', qstore(940002, 'qa-f', jsonb_build_array(qsig('k', 's', '2026-11-17T10:00:00Z') - 'key')), '%key%');
select t_err('sig: empty key is rejected', qstore(940002, 'qa-f', jsonb_build_array(qsig('', 's', '2026-11-17T10:00:00Z'))), '%signals_key_check%');
select t_err('sig: empty summary is rejected', qstore(940002, 'qa-f', jsonb_build_array(qsig('k', '', '2026-11-17T10:00:00Z'))), '%signals_summary_check%');
select t_err('sig: unknown kind is rejected',
  qstore(940002, 'qa-f', jsonb_build_array(jsonb_set(qsig('k', 's', '2026-11-17T10:00:00Z'), '{kind}', '"rumor"'))), '%signal_kind%');
select t_err('sig: empty source is rejected', qstore(940002, '', jsonb_build_array(qsig('k', 's', '2026-11-17T10:00:00Z'))), '%signals_source_check%');
select t_err('sig: a run_id that does not exist is rejected',
  qstore(949999, 'qa-f', jsonb_build_array(qsig('k', 's', '2026-11-17T10:00:00Z'))), '%foreign key%');
select t_err('sig: a batch that is an object, not an array, is rejected',
  format('select store_signals(940002, %L, storyline_today(), %L::jsonb)', 'qa-f', qsig('k', 's', '2026-11-17T10:00:00Z')), '%');
select t_eq('sig: empty batch stores nothing and returns 0',
  (select store_signals(940002, 'qa-f', storyline_today(), '[]'::jsonb)), 0);
select t_eq('sig: null batch stores nothing and returns 0',
  (select store_signals(940002, 'qa-f', storyline_today(), null)), 0);
select t_eq('sig: none of the rejected field attacks stored a row', (select count(*)::int from signals where source in ('qa-f', '')), 0);

-- ------------------------------------------------ deletes and immutability of cited IDs (coverage)
-- attacks: deleting a player/game/run that signals cite would orphan blurb fact IDs; FKs must block it.
select store_signals(940002, 'qa-del', storyline_today(), jsonb_build_array(qsig('del:p', 's', '2026-11-17T10:00:00Z'),
  jsonb_set(jsonb_set(qsig('del:g', 's', '2026-11-17T10:00:00Z'), '{subject,kind}', '"game"'), '{subject,id}', '"a9400000-0000-0000-0000-0000000000e1"'))) \g /dev/null
select t_err('sig: deleting a player with signals is blocked',
  $q$delete from players where id = 'a9400000-0000-0000-0000-0000000000b1'$q$, '%foreign key%');
select t_err('sig: deleting a game with signals is blocked',
  $q$delete from games where id = 'a9400000-0000-0000-0000-0000000000e1'$q$, '%foreign key%');
select t_err('sig: deleting a pipeline run that owns signals is blocked',
  $q$delete from pipeline_runs where id = 940002$q$, '%foreign key%');
select t_err('sig: signal id cannot be set by hand (generated always)',
  $q$insert into signals (id, source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id)
     values (1, 'qa-del', 'stat', storyline_today(), 'a9400000-0000-0000-0000-0000000000b1', 'manual', 's', '{"url":"u"}', now(), 'verified', 940002)$q$,
  '%non-DEFAULT%');

-- ------------------------------------------------ privileges (coverage)
-- coverage: the worker's role path works: service_role can call store_signals (needs table rights; it is not security definer)
set role service_role;
select t_eq('sig priv: service_role can store signals',
  (select store_signals(940002, 'qa-sr', storyline_today(), jsonb_build_array(qsig('sr:k', 's', '2026-11-17T10:00:00Z')))), 1);
reset role;
-- attacks: anon/authenticated can't reach signals through the identity sequence either
select t_eq('sig priv: no sequence privileges on signals_id_seq for app roles',
  (select count(*)::int from information_schema.usage_privileges
    where object_name = 'signals_id_seq' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('sig priv: store_signals is not security definer',
  (select prosecdef from pg_proc where proname = 'store_signals'), false);

drop function qsig(text, text, text, text);
drop function qstore(bigint, text, jsonb);
drop function qok(text);

-- ---------------------------------------------------------------- signal_sightings, the observedAt format and evidence checks (STO-10 part 2 fix)
insert into players (id, league, full_name, team_id) values ('a9500000-0000-0000-0000-0000000000b1', 'nba', 'QA Sighting Player', 29);
insert into pipeline_runs (id, job, slate_date, status) values
  (950001, 'context:qa95', storyline_today(), 'ok'),
  (950002, 'context:qa95', storyline_today(), 'ok'),
  (950003, 'context:qa95', storyline_today(), 'ok'),
  (950004, 'context:qa95', storyline_today(), 'ok');

create function s95(k text, summ text, at text, pid text default 'a9500000-0000-0000-0000-0000000000b1') returns jsonb language sql as $$
  select jsonb_build_object('kind', 'stat', 'subject', jsonb_build_object('kind', 'player', 'id', pid),
    'summary', summ, 'evidence', jsonb_build_object('url', 'https://x.test/' || k, 'observedAt', at), 'trust', 'verified', 'key', k) $$;
create function q95(run bigint, src text, sigs jsonb) returns text language sql as $$
  select format('select store_signals(%s, %L, storyline_today(), %L::jsonb)', run, src, sigs) $$;
create function seen95(run bigint, src text) returns int language sql as $$
  select count(*)::int from signal_sightings ss join signals s on s.id = ss.signal_id where ss.run_id = run and s.source = src $$;
-- observedAt probe: stores one signal with this observedAt under its own key; 'ok' or the error text
create function ts95(k text, at text) returns text language plpgsql as $$
begin perform store_signals(950004, 'qa95-ts', storyline_today(), jsonb_build_array(s95(k, 's', at))); return 'ok';
exception when others then return sqlerrm; end $$;
-- evidence probe: stores one signal with this evidence (observedAt added); 'ok' or the error text
create function ev95(k text, ev jsonb) returns text language plpgsql as $$
begin perform store_signals(950004, 'qa95-ev', storyline_today(),
        jsonb_build_array(jsonb_set(s95(k, 's', '2026-11-17T10:00:00Z'), '{evidence}', ev || '{"observedAt":"2026-11-17T10:00:00Z"}')));
      return 'ok';
exception when others then return sqlerrm; end $$;

-- ------------------------------------------------ sightings: one run, many sightings of one signal
-- attacks: a run seeing the same signal twice in one batch (exact duplicate) records one sighting, no PK error
select t_eq('sig sightings: exact duplicate in one batch -> 1 signal, 1 sighting',
  (select store_signals(950001, 'qa95-dup', storyline_today(), jsonb_build_array(s95('d:k', 'a', '2026-11-17T10:00:00Z'), s95('d:k', 'a', '2026-11-17T10:00:00Z'))))
    || '/' || seen95(950001, 'qa95-dup'), '1/1');
-- attacks: same subject in different uuid case in one batch -> one sighting (typed distinct)
select t_eq('sig sightings: case-variant uuid in one batch -> 1 signal, 1 sighting',
  (select store_signals(950001, 'qa95-case', storyline_today(), jsonb_build_array(s95('c:k', 'a', '2026-11-17T10:00:00Z'),
     s95('c:k', 'b', '2026-11-17T11:00:00Z', 'A9500000-0000-0000-0000-0000000000B1'))))
    || '/' || seen95(950001, 'qa95-case'), '1/1');
select t_eq('sig sightings: ...and the newer case-variant draft wins the text', (select summary from signals where source = 'qa95-case'), 'b');
-- attacks: the same run calling store_signals twice (replay / retry) adds no second sighting and no error
select store_signals(950001, 'qa95-dup', storyline_today(), jsonb_build_array(s95('d:k', 'a', '2026-11-17T10:00:00Z'))) \g /dev/null
select t_eq('sig sightings: replaying the same run is a no-op for sightings',
  (select count(*)::int from signal_sightings ss join signals s on s.id = ss.signal_id where s.source = 'qa95-dup'), 1);
-- attacks: an OLDER sighting from a later run doesn't refresh text but must still count as "seen" by that run
select store_signals(950002, 'qa95-dup', storyline_today(), jsonb_build_array(s95('d:k', 'stale', '2026-11-17T09:00:00Z'))) \g /dev/null
select t_eq('sig sightings: an older sighting keeps the text but is still recorded for the run that saw it',
  (select summary from signals where source = 'qa95-dup') || '/' || seen95(950002, 'qa95-dup'), 'a/1');
select t_eq('sig sightings: signals.run_id stays the first-storing run after later sightings',
  (select run_id from signals where source = 'qa95-dup'), 950001::bigint);

-- ------------------------------------------------ sightings: atomicity
-- attacks: a batch rejected by a bad draft (after a good one) leaves no sighting behind for the good one
select t_err('sig sightings: batch with a bad draft is rejected',
  q95(950003, 'qa95-atom', jsonb_build_array(s95('a:good', 's', '2026-11-17T10:00:00Z'),
    jsonb_set(s95('a:bad', 's', '2026-11-17T10:00:00Z'), '{subject,id}', '"a9500000-0000-0000-0000-0000000000ff"'))), '%foreign key%');
select t_eq('sig sightings: ...and leaves no signals and no sightings', (select count(*)::int from signals where source = 'qa95-atom')
  + (select count(*)::int from signal_sightings where run_id = 950003), 0);
-- attacks: a bad batch that re-sees an existing signal must not record a sighting for it either
select t_err('sig sightings: re-sighting batch with a bad observedAt is rejected',
  q95(950003, 'qa95-dup', jsonb_build_array(s95('d:k', 'a', '2026-11-17T10:00:00Z'), s95('d:k2', 'a', '2026-11-17 10:00'))), 'bad_observed_at%');
select t_eq('sig sightings: ...and records no sighting for the existing signal', seen95(950003, 'qa95-dup'), 0);

-- ------------------------------------------------ sightings: integrity
-- attacks: sightings can't point at a missing signal or run
select t_err('sig sightings: sighting of a missing signal is rejected', $q$insert into signal_sightings values (-1, 950001)$q$, '%foreign key%');
select t_err('sig sightings: sighting by a missing run is rejected',
  $q$insert into signal_sightings select id, -1 from signals where source = 'qa95-dup'$q$, '%foreign key%');
-- attacks: deleting a run that only SAW signals (didn't first-store any) would drop fallback history; must be blocked
select t_err('sig sightings: deleting a run with only sightings is blocked', $q$delete from pipeline_runs where id = 950002$q$, '%signal_sightings%');
-- attacks: deleting a cited signal that has sightings must be blocked (no cascade erases a fact ID)
select t_err('sig sightings: deleting a signal that has sightings is blocked',
  $q$delete from signals where source = 'qa95-dup'$q$, '%signal_sightings%');
select t_eq('sig sightings: sightings table has no sequence/identity (nothing to grant)',
  (select count(*)::int from pg_depend d join pg_class c on c.oid = d.objid and c.relkind = 'S'
    where d.refobjid = 'public.signal_sightings'::regclass), 0);

-- ------------------------------------------------ sightings: privileges (can't do it)
select t_eq('sig sightings priv: no table privilege of any kind on signal_sightings for anon/authenticated',
  (select array_agg(has_table_privilege(r, 'public.signal_sightings', p) order by r, p)
     from unnest(array['anon', 'authenticated']) r, unnest(array['select','insert','update','delete','truncate','references','trigger']) p),
  array_fill(false, array[14]));
set role anon;
select t_err('sig sightings priv: anon can''t insert sightings', $q$insert into signal_sightings values (1, 950001)$q$, 'permission denied%');
select t_err('sig sightings priv: anon can''t delete sightings', $q$delete from signal_sightings$q$, 'permission denied%');
select t_err('sig sightings priv: anon can''t truncate sightings', $q$truncate signal_sightings$q$, 'permission denied%');
reset role;
set role authenticated;
select t_err('sig sightings priv: authenticated can''t update sightings', $q$update signal_sightings set run_id = run_id$q$, 'permission denied%');
select t_err('sig sightings priv: authenticated can''t delete sightings', $q$delete from signal_sightings$q$, 'permission denied%');
select t_err('sig sightings priv: authenticated can''t truncate sightings', $q$truncate signal_sightings$q$, 'permission denied%');
reset role;
-- coverage: the worker's role (service_role) reads sightings for the fallback query
set role service_role;
select t_eq('sig sightings priv: service_role can read sightings', (select count(*) > 0 from signal_sightings where run_id = 950001), true);
reset role;

-- ------------------------------------------------ observedAt regex (session in a non-UTC zone throughout)
set timezone = 'America/New_York';
-- coverage: accepted ISO forms, each read as the instant its offset says (not the session zone)
select t_eq('sig observedAt: Z', ts95('t:z', '2026-11-17T10:00:00Z'), 'ok');
select t_eq('sig observedAt: fractional seconds', ts95('t:frac', '2026-11-17T10:00:00.123456Z'), 'ok');
select t_eq('sig observedAt: nanoseconds (rounded, not rejected)', ts95('t:nano', '2026-11-17T10:00:00.123456789Z'), 'ok');
select t_eq('sig observedAt: +hh:mm', ts95('t:hhmm', '2026-11-17T10:00:00+05:30'), 'ok');
select t_eq('sig observedAt: +hhmm', ts95('t:hhmm2', '2026-11-17T10:00:00+0530'), 'ok');
select t_eq('sig observedAt: -hh', ts95('t:hh', '2026-11-17T10:00:00-05'), 'ok');
select t_eq('sig observedAt: space instead of T', ts95('t:space', '2026-11-17 10:00:00Z'), 'ok');
select t_eq('sig observedAt: stored instants are offset-correct (UTC)',
  (select string_agg(key || '=' || to_char(observed_at at time zone 'UTC', 'HH24:MI:SS.US'), ',' order by key) from signals where source = 'qa95-ts'),
  't:frac=10:00:00.123456,t:hh=15:00:00.000000,t:hhmm=04:30:00.000000,t:hhmm2=04:30:00.000000,t:nano=10:00:00.123457,t:space=10:00:00.000000,t:z=10:00:00.000000');
-- coverage: rejected forms all fail with bad_observed_at (no offset / not anchored / named zone)
select t_eq('sig observedAt: rejected forms get bad_observed_at',
  (select string_agg(left(ts95('t:r' || i, v), 15), '|' order by i) from unnest(array[
     '2026-11-17T10:00:00',          -- no offset
     '2026-11-17',                   -- date only
     ' 2026-11-17T10:00:00Z',        -- leading space
     '2026-11-17T10:00:00Z ',        -- trailing space
     '2026-11-17T10:00:00Z' || chr(10), -- trailing newline
     '2026-11-17T10:00:00 Z',        -- space before Z
     '2026-11-17T10:00:00UTC',       -- named zone
     '2026-11-17T10:00:00 EST',      -- abbreviation
     '2026-11-17T10:00:00+05:3',     -- truncated offset
     'infinity', 'now', 'today',
     '2026-11-17t10:00:00Z'          -- lowercase t
   ]) with ordinality u(v, i)),
  array_to_string(array_fill('bad_observed_at'::text, array[13]), '|'));
-- coverage: strings the regex lets through but Postgres can't parse still reject the whole batch (raw cast error)
select t_eq('sig observedAt: regex-passing garbage is still rejected',
  (select string_agg(case when ts95('t:g' || i, v) = 'ok' then v else 'rejected' end, '|' order by i) from unnest(array[
     '2026-11-17T::Z', '2026-11-17T10Z', '2026-11-17T25:00:00Z', '2026-02-30T10:00:00Z', '2026-11-17T10:00:00+99:99'
   ]) with ordinality u(v, i)),
  'rejected|rejected|rejected|rejected|rejected');
select t_eq('sig observedAt: none of the rejected observedAt probes stored a row',
  (select count(*)::int from signals where source = 'qa95-ts' and (key like 't:r%' or key like 't:g%')), 0);
reset timezone;

-- ------------------------------------------------ evidence variants
-- coverage: url only, quote only, both
select t_eq('sig evidence: url only / quote only / both are accepted',
  ev95('e:u', '{"url":"https://x.test"}') || ev95('e:q', '{"quote":"he said"}') || ev95('e:b', '{"url":"https://x.test","quote":"q"}'), 'okokok');
-- attacks: null/empty url or quote, or neither, must be rejected
select t_eq('sig evidence: empty / null / missing url and quote are rejected',
  (select string_agg(case when ev95('e:x' || i, v::jsonb) = 'ok' then v else 'rejected' end, '|' order by i) from unnest(array[
     '{"url":null}', '{"url":""}', '{"quote":""}', '{"url":null,"quote":null}', '{"url":"","quote":""}', '{}', '{"source":"espn"}'
   ]) with ordinality u(v, i)),
  'rejected|rejected|rejected|rejected|rejected|rejected|rejected');
-- coverage: an empty url is fine when a quote carries the evidence
select t_eq('sig evidence: empty url with a real quote is accepted', ev95('e:uq', '{"url":"","quote":"q"}'), 'ok');
-- coverage: observedAt is stripped from stored evidence (it lives in observed_at)
select t_eq('sig evidence: stored evidence has no observedAt key',
  (select count(*)::int from signals where source = 'qa95-ev' and evidence ? 'observedAt'), 0);

drop function s95(text, text, text, text);
drop function q95(bigint, text, jsonb);
drop function seen95(bigint, text);
drop function ts95(text, text);
drop function ev95(text, jsonb);
