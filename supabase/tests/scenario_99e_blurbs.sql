-- STO-77: blurb settings (ADR-018) and the per-step curation_attempts constraints.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

select t_eq('blurb cfg: blurb_max_chars is a private bounded int starting at the spec''s 200',
  (select array[config_int('blurb_max_chars'), min_value::int, max_value::int] from app_config where key = 'blurb_max_chars' and not is_public and value_type = 'int'),
  array[200, 40, 200]);
select t_err('blurb cfg: 201 is rejected (cards.blurb would refuse the blurb)', $q$update app_config set value = '201' where key = 'blurb_max_chars'$q$, '%invalid config%');
select t_err('blurb cfg: 39 is rejected (no blurb could fit)',                   $q$update app_config set value = '39' where key = 'blurb_max_chars'$q$, '%invalid config%');
select t_err('blurb cfg: a string is rejected',                                  $q$update app_config set value = '"long"' where key = 'blurb_max_chars'$q$, '%invalid config%');

insert into pipeline_runs (job, slate_date, status) values ('sto77_scn_a', storyline_today(), 'ok');
insert into curation_attempts (run_id, step, attempt, request, output, accepted)
  values ((select id from pipeline_runs where job = 'sto77_scn_a'), 'pick',  1, '{}', '{"ranking": [], "picks": []}', true);
-- the same attempt number and a second accepted answer are fine in the OTHER step
insert into curation_attempts (run_id, step, attempt, request, output, accepted)
  values ((select id from pipeline_runs where job = 'sto77_scn_a'), 'blurb', 1, '{}', '{"blurbs": []}', true);
select t_eq('blurb attempts: the pick step and the blurb step each keep their own accepted answer',
  (select array[count(*), count(*) filter (where step = 'pick'), count(*) filter (where step = 'blurb' and accepted)]::int[]
     from curation_attempts where run_id = (select id from pipeline_runs where job = 'sto77_scn_a')), array[2, 1, 1]);
select t_eq('blurb attempts: rows from before the step column are picks', (select column_default from information_schema.columns where table_name = 'curation_attempts' and column_name = 'step'), '''pick''::text');

select t_err('blurb attempts: a step can''t have two accepted answers (never two sets of blurbs)',
  $q$insert into curation_attempts (run_id, step, attempt, request, output, accepted) values ((select id from pipeline_runs where job = 'sto77_scn_a'), 'blurb', 2, '{}', '{}', true)$q$, '%curation_attempts_one_accepted%');
select t_err('blurb attempts: the same blurb call can''t be stored twice',
  $q$insert into curation_attempts (run_id, step, attempt, request) values ((select id from pipeline_runs where job = 'sto77_scn_a'), 'blurb', 1, '{}')$q$, '%curation_attempts_one_per_call%');
select t_err('blurb attempts: only known steps',
  $q$insert into curation_attempts (run_id, step, attempt, request) values ((select id from pipeline_runs where job = 'sto77_scn_a'), 'rewrite', 1, '{}')$q$, '%step%');

-- ADR-016: nothing changed about who can touch the table
set role anon;
select t_err('blurb attempts: anon still can''t read the table', $q$select * from curation_attempts$q$, 'permission denied%');
reset role;
