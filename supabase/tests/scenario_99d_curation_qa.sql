-- qa (STO-11, PR #44): more "can't do it" attacks on curation_attempts (ADR-016), and the worker's path. Coverage unless marked.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into pipeline_runs (job, slate_date, status) values ('sto11_qa_a', storyline_today(), 'ok');

-- attacks: TRUNCATE skips row-level checks; app roles must not be able to wipe the trace of what the model saw.
set role anon;
select t_err('curation qa priv: anon can''t truncate attempts',          $q$truncate curation_attempts$q$, 'permission denied%');
select t_err('curation qa priv: anon can''t update attempts',            $q$update curation_attempts set accepted = true$q$, 'permission denied%');
select t_err('curation qa priv: anon can''t delete attempts',            $q$delete from curation_attempts$q$, 'permission denied%');
select t_err('curation qa priv: anon can''t draw ids from its sequence', $q$select nextval('curation_attempts_id_seq')$q$, 'permission denied%');
reset role;
set role authenticated;
select as_user('a9800000-0000-0000-0000-0000000000f2');
select t_err('curation qa priv: authenticated can''t truncate attempts',          $q$truncate curation_attempts$q$, 'permission denied%');
select t_err('curation qa priv: authenticated can''t draw ids from its sequence', $q$select nextval('curation_attempts_id_seq')$q$, 'permission denied%');
select t_err('curation qa priv: authenticated can''t reach it through a CTE',     $q$with x as (select count(*) from curation_attempts) select * from x$q$, 'permission denied%');
reset role;

-- attacks: privileges on the identity sequence (Supabase default privileges grant sequences to app roles).
select t_eq('curation qa priv: no sequence privileges on curation_attempts_id_seq for app roles',
  (select count(*)::int from information_schema.usage_privileges
    where object_name = 'curation_attempts_id_seq' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);

-- attacks: no function exposed to app roles reads or writes the table (no security definer back door).
select t_eq('curation qa priv: no function in public mentions curation_attempts',
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc ilike '%curation_attempts%'), 0);

-- coverage: the worker's role path works (service_role bypasses RLS, like story_shortlist).
set role service_role;
insert into curation_attempts (run_id, attempt, request) values ((select id from pipeline_runs where job = 'sto11_qa_a'), 1, '{}');
select t_eq('curation qa priv: service_role can store and read back an attempt',
  (select count(*)::int from curation_attempts where run_id = (select id from pipeline_runs where job = 'sto11_qa_a')), 1);
reset role;

-- coverage: a run with stored attempts can't be deleted out from under them (no cascade loses the trace).
select t_err('curation qa: a pipeline run with attempts can''t be deleted',
  $q$delete from pipeline_runs where job = 'sto11_qa_a'$q$, '%foreign key%');

-- coverage: violations is always a list, so "accepted means no violations" can't be dodged with an empty object.
select t_err('curation qa: violations must be an array, not an object',
  $q$insert into curation_attempts (run_id, attempt, request, violations) values ((select id from pipeline_runs where job = 'sto11_qa_a'), 2, '{}', '{}')$q$, '%check%');
