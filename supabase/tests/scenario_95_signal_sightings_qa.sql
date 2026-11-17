-- QA for STO-10 part 2 fix (PR #32, ad689e8): signal_sightings, the observedAt regex and evidence checks.
-- FAILs here are findings for the author.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

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
select t_eq('sight qa: exact duplicate in one batch -> 1 signal, 1 sighting',
  (select store_signals(950001, 'qa95-dup', storyline_today(), jsonb_build_array(s95('d:k', 'a', '2026-11-17T10:00:00Z'), s95('d:k', 'a', '2026-11-17T10:00:00Z'))))
    || '/' || seen95(950001, 'qa95-dup'), '1/1');
-- attacks: same subject in different uuid case in one batch -> one sighting (typed distinct)
select t_eq('sight qa: case-variant uuid in one batch -> 1 signal, 1 sighting',
  (select store_signals(950001, 'qa95-case', storyline_today(), jsonb_build_array(s95('c:k', 'a', '2026-11-17T10:00:00Z'),
     s95('c:k', 'b', '2026-11-17T11:00:00Z', 'A9500000-0000-0000-0000-0000000000B1'))))
    || '/' || seen95(950001, 'qa95-case'), '1/1');
select t_eq('sight qa: ...and the newer case-variant draft wins the text', (select summary from signals where source = 'qa95-case'), 'b');
-- attacks: the same run calling store_signals twice (replay / retry) adds no second sighting and no error
select store_signals(950001, 'qa95-dup', storyline_today(), jsonb_build_array(s95('d:k', 'a', '2026-11-17T10:00:00Z'))) \g /dev/null
select t_eq('sight qa: replaying the same run is a no-op for sightings',
  (select count(*)::int from signal_sightings ss join signals s on s.id = ss.signal_id where s.source = 'qa95-dup'), 1);
-- attacks: an OLDER sighting from a later run doesn't refresh text but must still count as "seen" by that run
select store_signals(950002, 'qa95-dup', storyline_today(), jsonb_build_array(s95('d:k', 'stale', '2026-11-17T09:00:00Z'))) \g /dev/null
select t_eq('sight qa: an older sighting keeps the text but is still recorded for the run that saw it',
  (select summary from signals where source = 'qa95-dup') || '/' || seen95(950002, 'qa95-dup'), 'a/1');
select t_eq('sight qa: signals.run_id stays the first-storing run after later sightings',
  (select run_id from signals where source = 'qa95-dup'), 950001::bigint);

-- ------------------------------------------------ sightings: atomicity
-- attacks: a batch rejected by a bad draft (after a good one) leaves no sighting behind for the good one
select t_err('sight qa: batch with a bad draft is rejected',
  q95(950003, 'qa95-atom', jsonb_build_array(s95('a:good', 's', '2026-11-17T10:00:00Z'),
    jsonb_set(s95('a:bad', 's', '2026-11-17T10:00:00Z'), '{subject,id}', '"a9500000-0000-0000-0000-0000000000ff"'))), '%foreign key%');
select t_eq('sight qa: ...and leaves no signals and no sightings', (select count(*)::int from signals where source = 'qa95-atom')
  + (select count(*)::int from signal_sightings where run_id = 950003), 0);
-- attacks: a bad batch that re-sees an existing signal must not record a sighting for it either
select t_err('sight qa: re-sighting batch with a bad observedAt is rejected',
  q95(950003, 'qa95-dup', jsonb_build_array(s95('d:k', 'a', '2026-11-17T10:00:00Z'), s95('d:k2', 'a', '2026-11-17 10:00'))), 'bad_observed_at%');
select t_eq('sight qa: ...and records no sighting for the existing signal', seen95(950003, 'qa95-dup'), 0);

-- ------------------------------------------------ sightings: integrity
-- attacks: sightings can't point at a missing signal or run
select t_err('sight qa: sighting of a missing signal is rejected', $q$insert into signal_sightings values (-1, 950001)$q$, '%foreign key%');
select t_err('sight qa: sighting by a missing run is rejected',
  $q$insert into signal_sightings select id, -1 from signals where source = 'qa95-dup'$q$, '%foreign key%');
-- attacks: deleting a run that only SAW signals (didn't first-store any) would drop fallback history; must be blocked
select t_err('sight qa: deleting a run with only sightings is blocked', $q$delete from pipeline_runs where id = 950002$q$, '%signal_sightings%');
-- attacks: deleting a cited signal that has sightings must be blocked (no cascade erases a fact ID)
select t_err('sight qa: deleting a signal that has sightings is blocked',
  $q$delete from signals where source = 'qa95-dup'$q$, '%signal_sightings%');
select t_eq('sight qa: sightings table has no sequence/identity (nothing to grant)',
  (select count(*)::int from pg_depend d join pg_class c on c.oid = d.objid and c.relkind = 'S'
    where d.refobjid = 'public.signal_sightings'::regclass), 0);

-- ------------------------------------------------ sightings: privileges (can't do it)
select t_eq('sight qa priv: no table privilege of any kind on signal_sightings for anon/authenticated',
  (select array_agg(has_table_privilege(r, 'public.signal_sightings', p) order by r, p)
     from unnest(array['anon', 'authenticated']) r, unnest(array['select','insert','update','delete','truncate','references','trigger']) p),
  array_fill(false, array[14]));
set role anon;
select t_err('sight qa priv: anon can''t insert sightings', $q$insert into signal_sightings values (1, 950001)$q$, 'permission denied%');
select t_err('sight qa priv: anon can''t delete sightings', $q$delete from signal_sightings$q$, 'permission denied%');
select t_err('sight qa priv: anon can''t truncate sightings', $q$truncate signal_sightings$q$, 'permission denied%');
reset role;
set role authenticated;
select t_err('sight qa priv: authenticated can''t update sightings', $q$update signal_sightings set run_id = run_id$q$, 'permission denied%');
select t_err('sight qa priv: authenticated can''t delete sightings', $q$delete from signal_sightings$q$, 'permission denied%');
select t_err('sight qa priv: authenticated can''t truncate sightings', $q$truncate signal_sightings$q$, 'permission denied%');
reset role;
-- coverage: the worker's role (service_role) reads sightings for the fallback query
set role service_role;
select t_eq('sight qa priv: service_role can read sightings', (select count(*) > 0 from signal_sightings where run_id = 950001), true);
reset role;

-- ------------------------------------------------ observedAt regex (session in a non-UTC zone throughout)
set timezone = 'America/New_York';
-- coverage: accepted ISO forms, each read as the instant its offset says (not the session zone)
select t_eq('ts qa: Z', ts95('t:z', '2026-11-17T10:00:00Z'), 'ok');
select t_eq('ts qa: fractional seconds', ts95('t:frac', '2026-11-17T10:00:00.123456Z'), 'ok');
select t_eq('ts qa: nanoseconds (rounded, not rejected)', ts95('t:nano', '2026-11-17T10:00:00.123456789Z'), 'ok');
select t_eq('ts qa: +hh:mm', ts95('t:hhmm', '2026-11-17T10:00:00+05:30'), 'ok');
select t_eq('ts qa: +hhmm', ts95('t:hhmm2', '2026-11-17T10:00:00+0530'), 'ok');
select t_eq('ts qa: -hh', ts95('t:hh', '2026-11-17T10:00:00-05'), 'ok');
select t_eq('ts qa: space instead of T', ts95('t:space', '2026-11-17 10:00:00Z'), 'ok');
select t_eq('ts qa: stored instants are offset-correct (UTC)',
  (select string_agg(key || '=' || to_char(observed_at at time zone 'UTC', 'HH24:MI:SS.US'), ',' order by key) from signals where source = 'qa95-ts'),
  't:frac=10:00:00.123456,t:hh=15:00:00.000000,t:hhmm=04:30:00.000000,t:hhmm2=04:30:00.000000,t:nano=10:00:00.123457,t:space=10:00:00.000000,t:z=10:00:00.000000');
-- coverage: rejected forms all fail with bad_observed_at (no offset / not anchored / named zone)
select t_eq('ts qa: rejected forms get bad_observed_at',
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
select t_eq('ts qa: regex-passing garbage is still rejected',
  (select string_agg(case when ts95('t:g' || i, v) = 'ok' then v else 'rejected' end, '|' order by i) from unnest(array[
     '2026-11-17T::Z', '2026-11-17T10Z', '2026-11-17T25:00:00Z', '2026-02-30T10:00:00Z', '2026-11-17T10:00:00+99:99'
   ]) with ordinality u(v, i)),
  'rejected|rejected|rejected|rejected|rejected');
select t_eq('ts qa: none of the rejected observedAt probes stored a row',
  (select count(*)::int from signals where source = 'qa95-ts' and (key like 't:r%' or key like 't:g%')), 0);
reset timezone;

-- ------------------------------------------------ evidence variants
-- coverage: url only, quote only, both
select t_eq('ev qa: url only / quote only / both are accepted',
  ev95('e:u', '{"url":"https://x.test"}') || ev95('e:q', '{"quote":"he said"}') || ev95('e:b', '{"url":"https://x.test","quote":"q"}'), 'okokok');
-- attacks: null/empty url or quote, or neither, must be rejected
select t_eq('ev qa: empty / null / missing url and quote are rejected',
  (select string_agg(case when ev95('e:x' || i, v::jsonb) = 'ok' then v else 'rejected' end, '|' order by i) from unnest(array[
     '{"url":null}', '{"url":""}', '{"quote":""}', '{"url":null,"quote":null}', '{"url":"","quote":""}', '{}', '{"source":"espn"}'
   ]) with ordinality u(v, i)),
  'rejected|rejected|rejected|rejected|rejected|rejected|rejected');
-- coverage: an empty url is fine when a quote carries the evidence
select t_eq('ev qa: empty url with a real quote is accepted', ev95('e:uq', '{"url":"","quote":"q"}'), 'ok');
-- coverage: observedAt is stripped from stored evidence (it lives in observed_at)
select t_eq('ev qa: stored evidence has no observedAt key',
  (select count(*)::int from signals where source = 'qa95-ev' and evidence ? 'observedAt'), 0);

drop function s95(text, text, text, text);
drop function q95(bigint, text, jsonb);
drop function seen95(bigint, text);
drop function ts95(text, text);
drop function ev95(text, jsonb);
