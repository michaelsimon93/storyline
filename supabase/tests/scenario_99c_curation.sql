-- STO-11: curation's settings (ADR-018) and the curation_attempts table (ADR-016: internal, locked down).
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- ------------------------------------------------ settings
select t_eq('curation cfg: six private rows (two strings, four bounded ints)',
  (select count(*)::int from app_config where not is_public
     and key in ('curation_model', 'curation_effort', 'curation_max_tokens', 'curation_max_attempts', 'curation_max_per_game', 'curation_max_per_stat')
     and (value_type = 'string' or (value_type = 'int' and min_value is not null and max_value is not null))), 6);
select t_eq('curation cfg: starting values',
  (select array[config_int('curation_max_tokens'), config_int('curation_max_attempts'), config_int('curation_max_per_game'), config_int('curation_max_per_stat')]),
  array[16000, 3, 3, 4]);
select t_eq('curation cfg: model and effort are strings', (select array[value #>> '{}'] from app_config where key = 'curation_effort'), array['high']);

select t_err('curation cfg: 0 attempts is rejected (curation could never run)', $q$update app_config set value = '0' where key = 'curation_max_attempts'$q$, '%invalid config%');
select t_err('curation cfg: 11 attempts is rejected (a runaway API bill)',      $q$update app_config set value = '11' where key = 'curation_max_attempts'$q$, '%invalid config%');
select t_err('curation cfg: 0 cards per game is rejected',                       $q$update app_config set value = '0' where key = 'curation_max_per_game'$q$, '%invalid config%');
select t_err('curation cfg: 0 cards per stat is rejected',                       $q$update app_config set value = '0' where key = 'curation_max_per_stat'$q$, '%invalid config%');
select t_err('curation cfg: too few tokens is rejected (every answer would be cut off)', $q$update app_config set value = '1023' where key = 'curation_max_tokens'$q$, '%invalid config%');
select t_err('curation cfg: a model name must be a string',                      $q$update app_config set value = '5' where key = 'curation_model'$q$, '%invalid config%');

-- ------------------------------------------------ the table
-- No fixed ids: other scenarios insert runs too. These two are found again by their own job names.
insert into pipeline_runs (job, slate_date, status) values ('sto11_scn_a', storyline_today(), 'ok'), ('sto11_scn_b', storyline_today(), 'ok');

insert into curation_attempts (run_id, attempt, request, output, violations) values ((select id from pipeline_runs where job = 'sto11_scn_a'), 1, '{"stories": []}', '{"picks": []}', '[{"kind": "pick_count"}]');
insert into curation_attempts (run_id, attempt, request, error) values ((select id from pipeline_runs where job = 'sto11_scn_a'), 2, '{}', 'HTTP 529');
insert into curation_attempts (run_id, attempt, request, output, accepted) values ((select id from pipeline_runs where job = 'sto11_scn_a'), 3, '{}', '{"ranking": [], "picks": []}', true);
select t_eq('curation attempts: a rejected answer, a failed call and the accepted answer are all kept',
  (select array[count(*), count(*) filter (where accepted), count(*) filter (where error is not null), count(*) filter (where violations <> '[]')]::int[]
     from curation_attempts where run_id = (select id from pipeline_runs where job = 'sto11_scn_a')), array[3, 1, 1, 1]);

select t_err('curation attempts: a run can''t have two accepted answers (nothing partial or doubled gets published)',
  $q$insert into curation_attempts (run_id, attempt, request, output, accepted) values ((select id from pipeline_runs where job = 'sto11_scn_a'), 4, '{}', '{}', true)$q$, '%curation_attempts_one_accepted%');
select t_err('curation attempts: the same call can''t be stored twice',
  $q$insert into curation_attempts (run_id, attempt, request) values ((select id from pipeline_runs where job = 'sto11_scn_a'), 1, '{}')$q$, '%curation_attempts_one_per_call%');
select t_err('curation attempts: an answer with violations can''t be marked accepted',
  $q$insert into curation_attempts (run_id, attempt, request, output, violations, accepted) values ((select id from pipeline_runs where job = 'sto11_scn_b'), 1, '{}', '{}', '[{"kind":"x"}]', true)$q$, '%curation_attempts_accepted_is_clean%');
select t_err('curation attempts: a failed call can''t be marked accepted',
  $q$insert into curation_attempts (run_id, attempt, request, error, accepted) values ((select id from pipeline_runs where job = 'sto11_scn_b'), 1, '{}', 'boom', true)$q$, '%curation_attempts_accepted_is_clean%');
select t_err('curation attempts: an accepted attempt needs an answer',
  $q$insert into curation_attempts (run_id, attempt, request, accepted) values ((select id from pipeline_runs where job = 'sto11_scn_b'), 1, '{}', true)$q$, '%curation_attempts_accepted_is_clean%');
select t_err('curation attempts: the attempt must belong to a real run',
  $q$insert into curation_attempts (run_id, attempt, request) values (999999, 1, '{}')$q$, '%foreign key%');
select t_err('curation attempts: attempt numbers start at 1',
  $q$insert into curation_attempts (run_id, attempt, request) values ((select id from pipeline_runs where job = 'sto11_scn_b'), 0, '{}')$q$, '%check%');
select t_err('curation attempts: the request must be a JSON object',
  $q$insert into curation_attempts (run_id, attempt, request) values ((select id from pipeline_runs where job = 'sto11_scn_b'), 1, '[]')$q$, '%check%');
insert into curation_attempts (run_id, attempt, request, output, accepted) values ((select id from pipeline_runs where job = 'sto11_scn_b'), 1, '{}', '{}', true);
select t_eq('curation attempts: a different run has its own accepted answer',
  (select count(*)::int from curation_attempts where accepted), 2);

-- ------------------------------------------------ can't do it: app roles
select t_eq('curation priv: no privilege of any kind on curation_attempts for anon/authenticated/PUBLIC',
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'curation_attempts' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('curation priv: RLS is on and there are no policies',
  (select relrowsecurity and not exists (select 1 from pg_policies where tablename = 'curation_attempts')
     from pg_class where oid = 'public.curation_attempts'::regclass), true);
set role anon;
select t_err('curation priv: anon can''t read what the model saw', $q$select * from curation_attempts$q$, 'permission denied%');
select t_err('curation priv: anon can''t write attempts',          $q$insert into curation_attempts (run_id, attempt, request) values ((select id from pipeline_runs where job = 'sto11_scn_a'), 9, '{}')$q$, 'permission denied%');
reset role;
set role authenticated;
select as_user('a9800000-0000-0000-0000-0000000000f1');
select t_err('curation priv: authenticated can''t read attempts',    $q$select * from curation_attempts$q$, 'permission denied%');
select t_err('curation priv: authenticated can''t insert attempts',  $q$insert into curation_attempts (run_id, attempt, request) values ((select id from pipeline_runs where job = 'sto11_scn_a'), 9, '{}')$q$, 'permission denied%');
select t_err('curation priv: authenticated can''t change attempts',  $q$update curation_attempts set accepted = true$q$, 'permission denied%');
select t_err('curation priv: authenticated can''t delete attempts',  $q$delete from curation_attempts$q$, 'permission denied%');
reset role;

-- ---------------------------------------------------------------- more "can't do it" attacks on curation_attempts (ADR-016), and the worker's path (STO-11)
insert into pipeline_runs (job, slate_date, status) values ('sto11_qa_a', storyline_today(), 'ok');

-- attacks: TRUNCATE skips row-level checks; app roles must not be able to wipe the trace of what the model saw.
set role anon;
select t_err('curation priv: anon can''t truncate attempts',          $q$truncate curation_attempts$q$, 'permission denied%');
select t_err('curation priv: anon can''t update attempts',            $q$update curation_attempts set accepted = true$q$, 'permission denied%');
select t_err('curation priv: anon can''t delete attempts',            $q$delete from curation_attempts$q$, 'permission denied%');
select t_err('curation priv: anon can''t draw ids from its sequence', $q$select nextval('curation_attempts_id_seq')$q$, 'permission denied%');
reset role;
set role authenticated;
select as_user('a9800000-0000-0000-0000-0000000000f2');
select t_err('curation priv: authenticated can''t truncate attempts',          $q$truncate curation_attempts$q$, 'permission denied%');
select t_err('curation priv: authenticated can''t draw ids from its sequence', $q$select nextval('curation_attempts_id_seq')$q$, 'permission denied%');
select t_err('curation priv: authenticated can''t reach it through a CTE',     $q$with x as (select count(*) from curation_attempts) select * from x$q$, 'permission denied%');
reset role;

-- attacks: privileges on the identity sequence (Supabase default privileges grant sequences to app roles).
select t_eq('curation priv: no sequence privileges on curation_attempts_id_seq for app roles',
  (select count(*)::int from information_schema.usage_privileges
    where object_name = 'curation_attempts_id_seq' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);

-- attacks: no function exposed to app roles reads or writes the table (no security definer back door).
select t_eq('curation priv: no function in public mentions curation_attempts',
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc ilike '%curation_attempts%'), 0);

-- coverage: the worker's role path works (service_role bypasses RLS, like story_shortlist).
set role service_role;
insert into curation_attempts (run_id, attempt, request) values ((select id from pipeline_runs where job = 'sto11_qa_a'), 1, '{}');
select t_eq('curation priv: service_role can store and read back an attempt',
  (select count(*)::int from curation_attempts where run_id = (select id from pipeline_runs where job = 'sto11_qa_a')), 1);
reset role;

-- coverage: a run with stored attempts can't be deleted out from under them (no cascade loses the trace).
select t_err('curation attempts: a pipeline run with attempts can''t be deleted',
  $q$delete from pipeline_runs where job = 'sto11_qa_a'$q$, '%foreign key%');

-- coverage: violations is always a list, so "accepted means no violations" can't be dodged with an empty object.
select t_err('curation attempts: violations must be an array, not an object',
  $q$insert into curation_attempts (run_id, attempt, request, violations) values ((select id from pipeline_runs where job = 'sto11_qa_a'), 2, '{}', '{}')$q$, '%check%');
