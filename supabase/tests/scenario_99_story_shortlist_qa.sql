-- QA attacks on the story shortlist tables (STO-76, PR #43): app roles can't reach them by any route (ADR-016),
-- and the table refuses rows that contradict themselves. A FAIL here is a finding.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9900000-0000-0000-0000-0000000000e1', 'nba', storyline_today() + 72, 29, 30, now() + interval '1 day', 'scheduled');
insert into players (id, league, full_name, team_id) values
  ('a9900000-0000-0000-0000-0000000000b1', 'nba', 'QA One', 29),
  ('a9900000-0000-0000-0000-0000000000b2', 'nba', 'QA Two', 30);
insert into markets (id, league, game_id, kind, title, player_id, stat, strike, status) values
  ('a9900000-0000-0000-0000-0000000000f1', 'nba', 'a9900000-0000-0000-0000-0000000000e1', 'player_stat', 'QA One: 20+', 'a9900000-0000-0000-0000-0000000000b1', 'points', 20, 'open'),
  ('a9900000-0000-0000-0000-0000000000f2', 'nba', 'a9900000-0000-0000-0000-0000000000e1', 'player_stat', 'QA Two: 20+', 'a9900000-0000-0000-0000-0000000000b2', 'points', 20, 'open');
insert into pipeline_runs (id, job, slate_date, status) values (990001, 'story', storyline_today() + 72, 'ok');

create function qa_sl(pos int, pid text, mid text, score int default 50, summ text default 'x', st text default 'pts')
returns text language sql as $$
  select format($q$insert into story_shortlist (run_id, slate_date, league, team_id, position, player_id, game_id, angle, stat, score, summary, market_id, slot_kind)
    values (990001, storyline_today() + 72, 'nba', 29, %s, %L, 'a9900000-0000-0000-0000-0000000000e1', 'hot_streak', %L, %s, %L, %L, 'quota')$q$, pos, pid, st, score, summ, mid) $$;
create function qa_ok(q text) returns text language plpgsql as $$ begin execute q; return 'ok'; exception when others then return sqlerrm; end $$;

-- coverage: the remaining column checks
select t_err('sl qa: a negative score is rejected', qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f1', -1), '%check%');
select t_err('sl qa: an empty summary is rejected', qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f1', 50, ''), '%check%');
select t_err('sl qa: an empty stat is rejected',    qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f1', 50, 'x', ''), '%check%');
select t_err('sl qa: a run that does not exist is rejected',
  replace(qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f1'), '990001', '990999'), '%foreign key%');

-- attack (integrity, qa finding F2, fixed in STO-109): a row whose market is another player's market.
select t_err('sl qa: a story whose market belongs to another player is rejected',
  qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f2'), '%story_shortlist_market_matches%');
delete from story_shortlist where run_id = 990001;

-- coverage: RLS on, no policies, no grants of any kind to app roles (tables and the identity sequence)
select t_eq('sl qa priv: RLS is on for both tables',
  (select count(*)::int from pg_class where relname in ('story_shortlist', 'story_shortlist_signals') and relrowsecurity), 2);
select t_eq('sl qa priv: no policies on either table',
  (select count(*)::int from pg_policies where tablename in ('story_shortlist', 'story_shortlist_signals')), 0);
select t_eq('sl qa priv: no table privileges for anon/authenticated',
  (select count(*)::int from information_schema.role_table_grants
    where table_name in ('story_shortlist', 'story_shortlist_signals') and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('sl qa priv: no privileges on story_shortlist_id_seq for app roles',
  (select count(*)::int from information_schema.usage_privileges
    where object_name = 'story_shortlist_id_seq' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);

insert into story_shortlist (run_id, slate_date, league, team_id, position, player_id, game_id, angle, stat, score, summary, market_id, slot_kind)
  values (990001, storyline_today() + 72, 'nba', 29, 1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000e1', 'hot_streak', 'pts', 50, 'x', 'a9900000-0000-0000-0000-0000000000f1', 'quota');

-- hostile user: every write path, not just select/insert
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_err('sl qa: users cannot update the shortlist', $q$update story_shortlist set score = 100$q$, 'permission denied%');
select t_err('sl qa: users cannot delete the shortlist', $q$delete from story_shortlist$q$, 'permission denied%');
select t_err('sl qa: users cannot truncate the shortlist', $q$truncate story_shortlist cascade$q$, 'permission denied%');
select t_err('sl qa: users cannot link signals', $q$insert into story_shortlist_signals (shortlist_id, signal_id) values (1, 1)$q$, 'permission denied%');
select t_err('sl qa: users cannot burn shortlist ids', $q$select nextval('story_shortlist_id_seq')$q$, 'permission denied%');
reset role;
set role anon;
select t_err('sl qa: anon cannot write the shortlist', $q$delete from story_shortlist$q$, 'permission denied%');
select t_err('sl qa: anon cannot read signal links', $q$select * from story_shortlist_signals$q$, 'permission denied%');
reset role;
select t_eq('sl qa: the row survived every hostile attempt', (select count(*)::int from story_shortlist where run_id = 990001), 1);
delete from story_shortlist where run_id = 990001;
