-- QA for STO-10 part 2 (PR #32): hostile inputs to store_signals, ownership for the ESPN-down
-- fallback, and integrity of the signals table. FAILs here are findings for the author.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

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
select t_eq('sig qa: fallback still finds the last ok run''s signal after a later run stored it then failed',
  (select count(*)::int from signal_sightings ss join signals sg on sg.id = ss.signal_id
    where sg.source = 'qa-own'
      and ss.run_id = (select max(id) from pipeline_runs where job = 'context:qa' and status = 'ok' and id in (940001, 940010))), 1);

-- ------------------------------------------------ in-batch dedup is on raw text, the constraint is on typed ids
-- attacks: the same player uuid in upper and lower case in one batch; distinct-on sees two drafts, the
-- unique constraint sees one row, so ON CONFLICT hits the same row twice and the whole batch errors.
select t_eq('sig qa: same subject uuid in different case in one batch stores one signal (no error)',
  qok(qstore(940002, 'qa-case', jsonb_build_array(
     qsig('case:k', 'lower', '2026-11-17T10:00:00Z'),
     qsig('case:k', 'upper', '2026-11-17T11:00:00Z', 'A9400000-0000-0000-0000-0000000000B1')))), 'ok');
-- attacks: the same across two runs is fine (typed constraint), proving it's only the in-batch dedup
select store_signals(940002, 'qa-case2', storyline_today(), jsonb_build_array(qsig('case:k', 'lower', '2026-11-17T10:00:00Z'))) \g /dev/null
select store_signals(940003, 'qa-case2', storyline_today(), jsonb_build_array(qsig('case:k', 'upper', '2026-11-17T11:00:00Z', 'A9400000-0000-0000-0000-0000000000B1'))) \g /dev/null
select t_eq('sig qa: differently-cased uuid across runs is the same signal (coverage)',
  (select count(*)::int || '/' || min(summary) from signals where source = 'qa-case2'), '1/upper');

-- ------------------------------------------------ newer sighting vs. run-id guard
-- attacks: the run_id guard (excluded.run_id >= signals.run_id) gates the WHOLE update, so a newer sighting
-- from a lower-numbered (overlapping) run is dropped, contradicting "text moves only to a newer sighting".
select store_signals(940003, 'qa-order', storyline_today(), jsonb_build_array(qsig('order:k', 'older-text', '2026-11-17T10:00:00Z'))) \g /dev/null
select store_signals(940002, 'qa-order', storyline_today(), jsonb_build_array(qsig('order:k', 'newer-text', '2026-11-17T12:00:00Z'))) \g /dev/null
select t_eq('sig qa: a newer sighting refreshes text even if its run id is lower (first-storing run_id is kept)',
  (select summary || '/' || run_id from signals where source = 'qa-order'), 'newer-text/940003');

-- ------------------------------------------------ observedAt formats
-- attacks: 'infinity' is a valid timestamptz; stored, it blocks every future refresh of that signal.
select t_err('sig qa: observedAt ''infinity'' is rejected',
  qstore(940002, 'qa-ts', jsonb_build_array(qsig('ts:inf', 's', 'infinity'))), '%');
select t_eq('sig qa: ...and no infinity row was stored', (select count(*)::int from signals where source = 'qa-ts' and key = 'ts:inf'), 0);
-- attacks: an observedAt with no offset is read in the session TimeZone, silently shifting the signal's date.
set timezone = 'America/New_York';
select t_err('sig qa: observedAt without a UTC offset is rejected (not read in session time zone)',
  qstore(940002, 'qa-ts', jsonb_build_array(qsig('ts:naive', 's', '2026-11-17T10:00:00'))), '%');
reset timezone;
-- coverage: a missing observedAt is rejected (not null)
select t_err('sig qa: missing observedAt is rejected',
  qstore(940002, 'qa-ts', jsonb_build_array(qsig('ts:none', 's', null))), '%observed_at%');
-- coverage: garbage observedAt is rejected
select t_err('sig qa: garbage observedAt is rejected',
  qstore(940002, 'qa-ts', jsonb_build_array(qsig('ts:junk', 's', 'yesterday-ish'))), '%timestamp%');

-- ------------------------------------------------ evidence
-- attacks: evidence ? 'url' is true for {"url": null}, so a signal with no url and no quote gets in.
select t_err('sig qa: evidence {"url": null} is rejected (no real url or quote)',
  qstore(940002, 'qa-ev', jsonb_build_array(jsonb_set(qsig('ev:null', 's', '2026-11-17T10:00:00Z'), '{evidence}',
    '{"url": null, "observedAt": "2026-11-17T10:00:00Z"}'))), '%');
-- coverage: evidence that is not an object is rejected
select t_err('sig qa: evidence as a string is rejected',
  qstore(940002, 'qa-ev', jsonb_build_array(jsonb_set(qsig('ev:str', 's', '2026-11-17T10:00:00Z'), '{evidence}', '"https://x.test"'))), '%');

-- ------------------------------------------------ subjects (coverage)
select t_err('sig qa: missing subject is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(qsig('s:none', 's', '2026-11-17T10:00:00Z') - 'subject')), '%signals_check%');
select t_err('sig qa: unknown subject kind is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_set(qsig('s:coach', 's', '2026-11-17T10:00:00Z'), '{subject,kind}', '"coach"'))), '%signals_check%');
select t_err('sig qa: subject kind team with a player uuid is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_set(qsig('s:mis', 's', '2026-11-17T10:00:00Z'), '{subject,kind}', '"team"'))), '%smallint%');
select t_err('sig qa: subject kind game with a player uuid is rejected (FK)',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_set(qsig('s:mis2', 's', '2026-11-17T10:00:00Z'), '{subject,kind}', '"game"'))), '%foreign key%');
select t_err('sig qa: subject id null is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_set(qsig('s:nullid', 's', '2026-11-17T10:00:00Z'), '{subject,id}', 'null'))), '%signals_check%');
select t_err('sig qa: unknown team id is rejected',
  qstore(940002, 'qa-subj', jsonb_build_array(jsonb_build_object('kind', 'stat', 'subject', jsonb_build_object('kind', 'team', 'id', 9999),
    'summary', 's', 'evidence', jsonb_build_object('url', 'u', 'observedAt', '2026-11-17T10:00:00Z'), 'trust', 'verified', 'key', 's:t'))), '%foreign key%');
select store_signals(940002, 'qa-subj', storyline_today(), jsonb_build_array(jsonb_build_object('kind', 'injury',
  'subject', jsonb_build_object('kind', 'team', 'id', 29),
  'summary', 'team sig', 'evidence', jsonb_build_object('url', 'u', 'observedAt', '2026-11-17T10:00:00Z'), 'trust', 'unreviewed', 'key', 's:team'))) \g /dev/null
select t_eq('sig qa: a team subject (numeric JSON id) is stored on team_id only',
  (select count(*)::int from signals where source = 'qa-subj' and team_id = 29 and player_id is null and game_id is null), 1);
select t_eq('sig qa: only the valid team signal from the subject attacks was stored',
  (select count(*)::int from signals where source = 'qa-subj'), 1);

-- ------------------------------------------------ other fields and batch shapes (coverage)
select t_err('sig qa: missing key is rejected', qstore(940002, 'qa-f', jsonb_build_array(qsig('k', 's', '2026-11-17T10:00:00Z') - 'key')), '%key%');
select t_err('sig qa: empty key is rejected', qstore(940002, 'qa-f', jsonb_build_array(qsig('', 's', '2026-11-17T10:00:00Z'))), '%signals_key_check%');
select t_err('sig qa: empty summary is rejected', qstore(940002, 'qa-f', jsonb_build_array(qsig('k', '', '2026-11-17T10:00:00Z'))), '%signals_summary_check%');
select t_err('sig qa: unknown kind is rejected',
  qstore(940002, 'qa-f', jsonb_build_array(jsonb_set(qsig('k', 's', '2026-11-17T10:00:00Z'), '{kind}', '"rumor"'))), '%signal_kind%');
select t_err('sig qa: empty source is rejected', qstore(940002, '', jsonb_build_array(qsig('k', 's', '2026-11-17T10:00:00Z'))), '%signals_source_check%');
select t_err('sig qa: a run_id that does not exist is rejected',
  qstore(949999, 'qa-f', jsonb_build_array(qsig('k', 's', '2026-11-17T10:00:00Z'))), '%foreign key%');
select t_err('sig qa: a batch that is an object, not an array, is rejected',
  format('select store_signals(940002, %L, storyline_today(), %L::jsonb)', 'qa-f', qsig('k', 's', '2026-11-17T10:00:00Z')), '%');
select t_eq('sig qa: empty batch stores nothing and returns 0',
  (select store_signals(940002, 'qa-f', storyline_today(), '[]'::jsonb)), 0);
select t_eq('sig qa: null batch stores nothing and returns 0',
  (select store_signals(940002, 'qa-f', storyline_today(), null)), 0);
select t_eq('sig qa: none of the rejected field attacks stored a row', (select count(*)::int from signals where source in ('qa-f', '')), 0);

-- ------------------------------------------------ deletes and immutability of cited IDs (coverage)
-- attacks: deleting a player/game/run that signals cite would orphan blurb fact IDs; FKs must block it.
select store_signals(940002, 'qa-del', storyline_today(), jsonb_build_array(qsig('del:p', 's', '2026-11-17T10:00:00Z'),
  jsonb_set(jsonb_set(qsig('del:g', 's', '2026-11-17T10:00:00Z'), '{subject,kind}', '"game"'), '{subject,id}', '"a9400000-0000-0000-0000-0000000000e1"'))) \g /dev/null
select t_err('sig qa: deleting a player with signals is blocked',
  $q$delete from players where id = 'a9400000-0000-0000-0000-0000000000b1'$q$, '%foreign key%');
select t_err('sig qa: deleting a game with signals is blocked',
  $q$delete from games where id = 'a9400000-0000-0000-0000-0000000000e1'$q$, '%foreign key%');
select t_err('sig qa: deleting a pipeline run that owns signals is blocked',
  $q$delete from pipeline_runs where id = 940002$q$, '%foreign key%');
select t_err('sig qa: signal id cannot be set by hand (generated always)',
  $q$insert into signals (id, source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id)
     values (1, 'qa-del', 'stat', storyline_today(), 'a9400000-0000-0000-0000-0000000000b1', 'manual', 's', '{"url":"u"}', now(), 'verified', 940002)$q$,
  '%non-DEFAULT%');

-- ------------------------------------------------ privileges (coverage)
-- coverage: the worker's role path works: service_role can call store_signals (needs table rights; it is not security definer)
set role service_role;
select t_eq('sig qa priv: service_role can store signals',
  (select store_signals(940002, 'qa-sr', storyline_today(), jsonb_build_array(qsig('sr:k', 's', '2026-11-17T10:00:00Z')))), 1);
reset role;
-- attacks: anon/authenticated can't reach signals through the identity sequence either
select t_eq('sig qa priv: no sequence privileges on signals_id_seq for app roles',
  (select count(*)::int from information_schema.usage_privileges
    where object_name = 'signals_id_seq' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('sig qa priv: store_signals is not security definer',
  (select prosecdef from pg_proc where proname = 'store_signals'), false);

drop function qsig(text, text, text, text);
drop function qstore(bigint, text, jsonb);
drop function qok(text);
