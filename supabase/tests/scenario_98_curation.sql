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
insert into pipeline_runs (id, job, slate_date, status) overriding system value values (980001, 'curation', storyline_today(), 'ok'), (980002, 'curation', storyline_today(), 'ok');

insert into curation_attempts (run_id, attempt, request, output, violations) values (980001, 1, '{"stories": []}', '{"picks": []}', '[{"kind": "pick_count"}]');
insert into curation_attempts (run_id, attempt, request, error) values (980001, 2, '{}', 'HTTP 529');
insert into curation_attempts (run_id, attempt, request, output, accepted) values (980001, 3, '{}', '{"ranking": [], "picks": []}', true);
select t_eq('curation attempts: a rejected answer, a failed call and the accepted answer are all kept',
  (select array[count(*), count(*) filter (where accepted), count(*) filter (where error is not null), count(*) filter (where violations <> '[]')]::int[]
     from curation_attempts where run_id = 980001), array[3, 1, 1, 1]);

select t_err('curation attempts: a run can''t have two accepted answers (nothing partial or doubled gets published)',
  $q$insert into curation_attempts (run_id, attempt, request, output, accepted) values (980001, 4, '{}', '{}', true)$q$, '%curation_attempts_one_accepted%');
select t_err('curation attempts: the same call can''t be stored twice',
  $q$insert into curation_attempts (run_id, attempt, request) values (980001, 1, '{}')$q$, '%curation_attempts_one_per_call%');
select t_err('curation attempts: an answer with violations can''t be marked accepted',
  $q$insert into curation_attempts (run_id, attempt, request, output, violations, accepted) values (980002, 1, '{}', '{}', '[{"kind":"x"}]', true)$q$, '%curation_attempts_accepted_is_clean%');
select t_err('curation attempts: a failed call can''t be marked accepted',
  $q$insert into curation_attempts (run_id, attempt, request, error, accepted) values (980002, 1, '{}', 'boom', true)$q$, '%curation_attempts_accepted_is_clean%');
select t_err('curation attempts: an accepted attempt needs an answer',
  $q$insert into curation_attempts (run_id, attempt, request, accepted) values (980002, 1, '{}', true)$q$, '%curation_attempts_accepted_is_clean%');
select t_err('curation attempts: the attempt must belong to a real run',
  $q$insert into curation_attempts (run_id, attempt, request) values (999999, 1, '{}')$q$, '%foreign key%');
select t_err('curation attempts: attempt numbers start at 1',
  $q$insert into curation_attempts (run_id, attempt, request) values (980002, 0, '{}')$q$, '%check%');
select t_err('curation attempts: the request must be a JSON object',
  $q$insert into curation_attempts (run_id, attempt, request) values (980002, 1, '[]')$q$, '%check%');
insert into curation_attempts (run_id, attempt, request, output, accepted) values (980002, 1, '{}', '{}', true);
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
select t_err('curation priv: anon can''t write attempts',          $q$insert into curation_attempts (run_id, attempt, request) values (980001, 9, '{}')$q$, 'permission denied%');
reset role;
set role authenticated;
select as_user('a9800000-0000-0000-0000-0000000000f1');
select t_err('curation priv: authenticated can''t read attempts',    $q$select * from curation_attempts$q$, 'permission denied%');
select t_err('curation priv: authenticated can''t insert attempts',  $q$insert into curation_attempts (run_id, attempt, request) values (980001, 9, '{}')$q$, 'permission denied%');
select t_err('curation priv: authenticated can''t change attempts',  $q$update curation_attempts set accepted = true$q$, 'permission denied%');
select t_err('curation priv: authenticated can''t delete attempts',  $q$delete from curation_attempts$q$, 'permission denied%');
reset role;
