-- STO-76: the story shortlist tables and settings. Internal to the worker (ADR-016): the app can't read or write them.
-- A story is on the list once a day, a position is used once a day, and the list's rules are enforced by the table.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a9800000-0000-0000-0000-0000000000e1', 'nba', storyline_today() + 71, 29, 30, now() + interval '1 day', 'scheduled');
insert into players (id, league, full_name, team_id) values
  ('a9800000-0000-0000-0000-0000000000b1', 'nba', 'Shortlist One', 29),
  ('a9800000-0000-0000-0000-0000000000b2', 'nba', 'Shortlist Two', 30);
insert into markets (id, league, game_id, kind, title, player_id, stat, strike, status) values
  ('a9800000-0000-0000-0000-0000000000f1', 'nba', 'a9800000-0000-0000-0000-0000000000e1', 'player_stat', 'Shortlist One: 20+', 'a9800000-0000-0000-0000-0000000000b1', 'points', 20, 'open');
insert into markets (id, league, game_id, kind, title, player_id, stat, strike, status) values
  ('a9800000-0000-0000-0000-0000000000f3', 'nba', 'a9800000-0000-0000-0000-0000000000e1', 'player_stat', 'Shortlist Two: 20+', 'a9800000-0000-0000-0000-0000000000b2', 'points', 20, 'open');
insert into pipeline_runs (id, job, slate_date, status) values (980001, 'story', storyline_today() + 71, 'ok');
insert into signals (id, source, kind, slate_date, player_id, key, summary, evidence, observed_at, trust, run_id) overriding system value values
  (98001, 'espn', 'stat', storyline_today() + 71, 'a9800000-0000-0000-0000-0000000000b1', 'form:pts', 's', '{"quote":"q"}', now(), 'verified', 980001);

create function sl(pos int, pid text default 'a9800000-0000-0000-0000-0000000000b1', ang text default 'hot_streak', st text default 'pts', kind text default 'quota')
returns text language sql as $$
  select format($q$insert into story_shortlist (run_id, slate_date, league, team_id, position, player_id, game_id, angle, stat, score, summary, market_id, slot_kind)
    values (980001, storyline_today() + 71, 'nba', 29, %s, %L, 'a9800000-0000-0000-0000-0000000000e1', %L, %L, 50, 'x', case when %L = 'a9800000-0000-0000-0000-0000000000b2' then 'a9800000-0000-0000-0000-0000000000f3'::uuid else 'a9800000-0000-0000-0000-0000000000f1'::uuid end, %L)$q$, pos, pid, ang, st, pid, kind) $$;
create function sl_ok(q text) returns text language plpgsql as $$ begin execute q; return 'ok'; exception when others then return sqlerrm; end $$;

select t_eq('shortlist: a story can be stored', sl_ok(sl(1)), 'ok');
select t_err('shortlist: the same story twice on one day is rejected', sl(2), '%story_shortlist_one_story%');
select t_err('shortlist: a position used twice on one day is rejected', sl(1, 'a9800000-0000-0000-0000-0000000000b2'), '%story_shortlist_one_position%');
select t_eq('shortlist: the same player with another angle is a different story', sl_ok(sl(2, ang => 'back_from_injury', kind => 'fill')), 'ok');
select t_eq('shortlist: a new angle needs no migration (text, not an enum)', sl_ok(sl(3, ang => 'revenge', kind => 'fill')), 'ok');
select t_err('shortlist: position 0 is rejected',        sl(0, 'a9800000-0000-0000-0000-0000000000b2'), '%check%');
select t_err('shortlist: an empty angle is rejected',    sl(4, 'a9800000-0000-0000-0000-0000000000b2', ''), '%check%');
select t_err('shortlist: an unknown slot kind is rejected', sl(4, 'a9800000-0000-0000-0000-0000000000b2', kind => 'bonus'), '%check%');
select t_err('shortlist: a team that does not exist is rejected',
  replace(sl(4, 'a9800000-0000-0000-0000-0000000000b2'), $$'nba', 29,$$, $$'nba', 32000,$$), '%is not playing in game%');
select t_err('shortlist: a league that does not exist is rejected',
  replace(sl(4, 'a9800000-0000-0000-0000-0000000000b2'), $$'nba', 29,$$, $$'xyz', 29,$$), '%invalid input value%');
select t_eq('shortlist: league and team are stored', (select league::text || ':' || team_id from story_shortlist where position = 1), 'nba:29');
select t_err('shortlist: a market that does not exist is rejected',
  replace(sl(4, 'a9800000-0000-0000-0000-0000000000b1', 'x'), 'a9800000-0000-0000-0000-0000000000f1', 'a9800000-0000-0000-0000-0000000000f2'), '%foreign key%');
-- STO-109: the row must agree with its game and its player
select t_err('shortlist: another player''s market is rejected',
  replace(sl(5, 'a9800000-0000-0000-0000-0000000000b2'), 'a9800000-0000-0000-0000-0000000000f3', 'a9800000-0000-0000-0000-0000000000f1'), '%story_shortlist_market_matches%');
select t_err('shortlist: a team that is not playing in the game is rejected',
  replace(sl(5, 'a9800000-0000-0000-0000-0000000000b2'), $$'nba', 29,$$, $$'nba', 1,$$), '%is not playing in game%');
select t_err('shortlist: a slate day that is not the game''s is rejected',
  replace(sl(5, 'a9800000-0000-0000-0000-0000000000b2'), 'storyline_today() + 71', 'storyline_today() + 72'), '%is not the game''s%');
select t_err('shortlist: moving a stored story to the wrong team is rejected',
  $q$update story_shortlist set team_id = 1 where position = 2$q$, '%is not playing in game%');
select t_eq('shortlist: the opposing team of the game is allowed', sl_ok(replace(sl(5, 'a9800000-0000-0000-0000-0000000000b2'), $$'nba', 29,$$, $$'nba', 30,$$)), 'ok');
select t_eq('shortlist: the app roles cannot call the consistency trigger function',
  (select not (has_function_privilege('anon', 'story_shortlist_matches_game()', 'execute') or has_function_privilege('authenticated', 'story_shortlist_matches_game()', 'execute'))), true);
select t_err('shortlist: a signal that does not exist is rejected',
  $q$insert into story_shortlist_signals (shortlist_id, signal_id) select id, 424242 from story_shortlist limit 1$q$, '%foreign key%');

insert into story_shortlist_signals (shortlist_id, signal_id) select id, 98001 from story_shortlist where position = 1;
select t_eq('shortlist: a story''s signals are stored with it', (select count(*)::int from story_shortlist_signals), 1);
delete from story_shortlist where position = 1;
select t_eq('shortlist: replacing a story removes its signal links, not the signal', (select count(*)::int from story_shortlist_signals), 0);
select t_eq('shortlist: the signal itself is kept', (select count(*)::int from signals where id = 98001), 1);

-- settings
select t_eq('shortlist cfg: size and the three angle weights are private int rows with bounds',
  (select count(*)::int from app_config where (key = 'shortlist_size' or key like 'shortlist\_split\_%') and value_type = 'int'
     and min_value is not null and max_value is not null and not is_public), 4);
select t_eq('shortlist cfg: starting values (about 50, an even split)',
  (select array[config_int('shortlist_size'), config_int('shortlist_split_hot_streak'), config_int('shortlist_split_back_from_injury'), config_int('shortlist_split_backup_steps_in')]),
  array[50, 1, 1, 1]);
select t_err('shortlist cfg: a size of 0 is rejected',      $q$update app_config set value = '0'   where key = 'shortlist_size'$q$, '%invalid config%');
select t_err('shortlist cfg: a negative weight is rejected', $q$update app_config set value = '-1' where key = 'shortlist_split_hot_streak'$q$, '%invalid config%');
select t_err('shortlist cfg: a fractional weight is rejected', $q$update app_config set value = '1.5' where key = 'shortlist_split_hot_streak'$q$, '%invalid config%');

-- the app can't do anything with any of it
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_err('shortlist: users cannot read the shortlist',  $q$select * from story_shortlist$q$, 'permission denied%');
select t_err('shortlist: users cannot write the shortlist', sl(9, 'a9800000-0000-0000-0000-0000000000b2'), 'permission denied%');
select t_err('shortlist: users cannot read the stored signals links', $q$select * from story_shortlist_signals$q$, 'permission denied%');
select t_eq('shortlist cfg: the app cannot see the settings', (select count(*) from app_config where key like 'shortlist\_%'), 0::bigint);
reset role;
set role anon;
select t_err('shortlist: anon cannot read the shortlist', $q$select * from story_shortlist$q$, 'permission denied%');
reset role;

-- ---------------------------------------------------------------- app roles can't reach the shortlist by any route, and the table refuses rows that contradict themselves (STO-76)
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
select t_err('shortlist: a negative score is rejected', qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f1', -1), '%check%');
select t_err('shortlist: an empty summary is rejected', qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f1', 50, ''), '%check%');
select t_err('shortlist: an empty stat is rejected',    qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f1', 50, 'x', ''), '%check%');
select t_err('shortlist: a run that does not exist is rejected',
  replace(qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f1'), '990001', '990999'), '%foreign key%');

-- attack (integrity, qa finding F2, fixed in STO-109): a row whose market is another player's market.
select t_err('shortlist: a story whose market belongs to another player is rejected',
  qa_sl(1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000f2'), '%story_shortlist_market_matches%');
delete from story_shortlist where run_id = 990001;

-- coverage: RLS on, no policies, no grants of any kind to app roles (tables and the identity sequence)
select t_eq('shortlist priv: RLS is on for both tables',
  (select count(*)::int from pg_class where relname in ('story_shortlist', 'story_shortlist_signals') and relrowsecurity), 2);
select t_eq('shortlist priv: no policies on either table',
  (select count(*)::int from pg_policies where tablename in ('story_shortlist', 'story_shortlist_signals')), 0);
select t_eq('shortlist priv: no table privileges for anon/authenticated',
  (select count(*)::int from information_schema.role_table_grants
    where table_name in ('story_shortlist', 'story_shortlist_signals') and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);
select t_eq('shortlist priv: no privileges on story_shortlist_id_seq for app roles',
  (select count(*)::int from information_schema.usage_privileges
    where object_name = 'story_shortlist_id_seq' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0);

insert into story_shortlist (run_id, slate_date, league, team_id, position, player_id, game_id, angle, stat, score, summary, market_id, slot_kind)
  values (990001, storyline_today() + 72, 'nba', 29, 1, 'a9900000-0000-0000-0000-0000000000b1', 'a9900000-0000-0000-0000-0000000000e1', 'hot_streak', 'pts', 50, 'x', 'a9900000-0000-0000-0000-0000000000f1', 'quota');

-- hostile user: every write path, not just select/insert
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_err('shortlist: users cannot update the shortlist', $q$update story_shortlist set score = 100$q$, 'permission denied%');
select t_err('shortlist: users cannot delete the shortlist', $q$delete from story_shortlist$q$, 'permission denied%');
select t_err('shortlist: users cannot truncate the shortlist', $q$truncate story_shortlist cascade$q$, 'permission denied%');
select t_err('shortlist: users cannot link signals', $q$insert into story_shortlist_signals (shortlist_id, signal_id) values (1, 1)$q$, 'permission denied%');
select t_err('shortlist: users cannot burn shortlist ids', $q$select nextval('story_shortlist_id_seq')$q$, 'permission denied%');
reset role;
set role anon;
select t_err('shortlist: anon cannot write the shortlist', $q$delete from story_shortlist$q$, 'permission denied%');
select t_err('shortlist: anon cannot read signal links', $q$select * from story_shortlist_signals$q$, 'permission denied%');
reset role;
select t_eq('shortlist: the row survived every hostile attempt', (select count(*)::int from story_shortlist where run_id = 990001), 1);
delete from story_shortlist where run_id = 990001;

-- ---------------------------------------------------------------- the composite market foreign key and the game-consistency trigger (STO-109)
-- e1: 29 (home) vs 30 (away), tonight+73. e2: 29 vs 28 on another night. Markets: b1's in e1, b1's in e2, b2's in e1,
-- and a game_winner market (no player) in e1.
insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a99b0000-0000-0000-0000-0000000000e1', 'nba', storyline_today() + 73, 29, 30, now() + interval '1 day', 'scheduled'),
  ('a99b0000-0000-0000-0000-0000000000e2', 'nba', storyline_today() + 74, 29, 28, now() + interval '2 days', 'scheduled');
insert into players (id, league, full_name, team_id) values
  ('a99b0000-0000-0000-0000-0000000000b1', 'nba', 'QA109 One', 29),
  ('a99b0000-0000-0000-0000-0000000000b2', 'nba', 'QA109 Two', 30),
  ('a99b0000-0000-0000-0000-0000000000b3', 'nba', 'QA109 Three', 29);
insert into markets (id, league, game_id, kind, title, player_id, stat, strike, status) values
  ('a99b0000-0000-0000-0000-0000000000f1', 'nba', 'a99b0000-0000-0000-0000-0000000000e1', 'player_stat', 'QA109 One: 20+', 'a99b0000-0000-0000-0000-0000000000b1', 'points', 20, 'open'),
  ('a99b0000-0000-0000-0000-0000000000f2', 'nba', 'a99b0000-0000-0000-0000-0000000000e2', 'player_stat', 'QA109 One: 20+ (other night)', 'a99b0000-0000-0000-0000-0000000000b1', 'points', 20, 'open'),
  ('a99b0000-0000-0000-0000-0000000000f3', 'nba', 'a99b0000-0000-0000-0000-0000000000e1', 'player_stat', 'QA109 Two: 20+', 'a99b0000-0000-0000-0000-0000000000b2', 'points', 20, 'open');
insert into markets (id, league, game_id, kind, title, status) values
  ('a99b0000-0000-0000-0000-0000000000f9', 'nba', 'a99b0000-0000-0000-0000-0000000000e1', 'game_winner', 'QA109 winner', 'open');
insert into pipeline_runs (id, job, slate_date, status) values (991091, 'story', storyline_today() + 73, 'ok');

-- One valid row for b1 in e1, as the job writes it; each attack edits one value.
create function q109(pos int default 1, pid text default 'a99b0000-0000-0000-0000-0000000000b1',
                     gid text default 'a99b0000-0000-0000-0000-0000000000e1', mid text default 'a99b0000-0000-0000-0000-0000000000f1',
                     team text default '29', day text default 'storyline_today() + 73', lg text default 'nba')
returns text language sql as $$
  select format($q$insert into story_shortlist (run_id, slate_date, league, team_id, position, player_id, game_id, angle, stat, score, summary, market_id, slot_kind)
    values (991091, %s, %L, %s, %s, %L, %L, 'hot_streak', 'pts', 50, 'x', %L, 'quota')$q$, day, lg, team, pos, pid, gid, mid) $$;
create function ok109(q text) returns text language plpgsql as $$ begin execute q; return 'ok'; exception when others then return sqlerrm; end $$;

-- attack (missing game): `select into` would give an all-NULL row and `team_id not in (NULL, NULL)` is NULL, which would
-- let the row through; the trigger raises for a missing game explicitly (the foreign keys would also refuse it).
select t_err('shortlist: a game that does not exist is rejected by the trigger itself, not left to the foreign keys',
  q109(gid => 'a99b0000-0000-0000-0000-0000000000ee'), '%does not exist%');
-- attack (wrong league): team and day match, league doesn't. Only the trigger can catch this.
select t_err('shortlist: a league that is not the game''s is rejected', q109(lg => 'nfl'), '%league nfl is not the game''s%');
-- attack (player-less market): a game_winner market has player_id NULL; MATCH SIMPLE only skips the check when the
-- REFERENCING columns are null, and they're all NOT NULL, so this must be refused.
select t_err('shortlist: a game_winner market (no player) is rejected', q109(mid => 'a99b0000-0000-0000-0000-0000000000f9'), '%story_shortlist_market_matches%');
-- attack (right player, wrong game): b1's market from another night, with tonight's game.
select t_err('shortlist: the player''s own market from another game is rejected', q109(mid => 'a99b0000-0000-0000-0000-0000000000f2'), '%story_shortlist_market_matches%');
-- attack (row consistent with its market, wrong day): e2's market and game, but tonight's slate date.
select t_err('shortlist: a row pointing at another night''s game is rejected on slate_date',
  q109(gid => 'a99b0000-0000-0000-0000-0000000000e2', mid => 'a99b0000-0000-0000-0000-0000000000f2'), '%is not the game''s%');
-- attack (null team): team_id is NOT NULL, so `null not in (...)` never gets the chance to pass silently.
select t_err('shortlist: a NULL team is rejected', q109(team => 'null'), '%null value%');
-- coverage: the control row is accepted, and the opposing team (away) is accepted for a valid market.
select t_eq('shortlist: the valid row is stored', ok109(q109()), 'ok');
select t_eq('shortlist: the away team with its own player''s market is stored',
  ok109(q109(2, 'a99b0000-0000-0000-0000-0000000000b2', mid => 'a99b0000-0000-0000-0000-0000000000f3', team => '30')), 'ok');

-- UPDATE paths: every column the checks depend on, changed on a stored row.
select t_err('shortlist update: switching market_id to another player''s market is rejected',
  $q$update story_shortlist set market_id = 'a99b0000-0000-0000-0000-0000000000f3' where run_id = 991091 and position = 1$q$, '%story_shortlist_market_matches%');
select t_err('shortlist update: switching player_id away from the market''s player is rejected',
  $q$update story_shortlist set player_id = 'a99b0000-0000-0000-0000-0000000000b3' where run_id = 991091 and position = 1$q$, '%story_shortlist_market_matches%');
select t_err('shortlist update: switching game_id alone is rejected (trigger catches the day before the FK runs)',
  $q$update story_shortlist set game_id = 'a99b0000-0000-0000-0000-0000000000e2' where run_id = 991091 and position = 1$q$, '%is not the game''s%');
select t_err('shortlist update: switching game_id and market_id together to another night is rejected on slate_date',
  $q$update story_shortlist set game_id = 'a99b0000-0000-0000-0000-0000000000e2', market_id = 'a99b0000-0000-0000-0000-0000000000f2' where run_id = 991091 and position = 1$q$, '%is not the game''s%');
select t_err('shortlist update: moving slate_date is rejected',
  $q$update story_shortlist set slate_date = slate_date + 1 where run_id = 991091 and position = 1$q$, '%is not the game''s%');
select t_err('shortlist update: changing league is rejected',
  $q$update story_shortlist set league = 'nfl' where run_id = 991091 and position = 1$q$, '%is not the game''s%');
select t_eq('shortlist update: an update that touches none of them (score) still works',
  ok109($q$update story_shortlist set score = 51 where run_id = 991091 and position = 1$q$), 'ok');

-- The referenced market changing under a stored row.
select t_err('shortlist market: deleting a shortlisted market is rejected',
  $q$delete from markets where id = 'a99b0000-0000-0000-0000-0000000000f1'$q$, '%story_shortlist_market_matches%');
select t_err('shortlist market: re-pointing a shortlisted market at another player is rejected',
  $q$update markets set player_id = 'a99b0000-0000-0000-0000-0000000000b3' where id = 'a99b0000-0000-0000-0000-0000000000f1'$q$, '%story_shortlist_market_matches%');
-- coverage (poller/ingest path): a price/status refresh on a shortlisted market is not a key update and still works.
select t_eq('shortlist market: a price and status refresh of a shortlisted market still works',
  ok109($q$update markets set yes_bid_cents = 40, yes_ask_cents = 42, status = 'paused', updated_at = now() where id = 'a99b0000-0000-0000-0000-0000000000f1'$q$), 'ok');
-- coverage: the new unique key on markets can't reject a market row (id is already unique), even a player-less one.
select t_eq('shortlist market: a second player-less market in the same game is still allowed',
  ok109($q$insert into markets (id, league, game_id, kind, title, team_id, status) values ('a99b0000-0000-0000-0000-0000000000fa', 'nba', 'a99b0000-0000-0000-0000-0000000000e1', 'game_winner', 'QA109 winner 2', 29, 'open')$q$), 'ok');

-- Not covered (qa finding F1, low): a game's teams corrected after the row is stored (ingest does this in place) aren't
-- re-checked. STO-113 tracks it and will add the test back.

-- The trigger function: not security definer (it needs no extra rights), not callable by app roles or PUBLIC.
select t_eq('shortlist fn: the trigger function is not security definer',
  (select prosecdef from pg_proc where proname = 'story_shortlist_matches_game'), false);
select t_eq('shortlist fn: PUBLIC cannot execute the trigger function',
  (select count(*)::int from information_schema.routine_privileges
    where routine_name = 'story_shortlist_matches_game' and grantee in ('PUBLIC', 'anon', 'authenticated')), 0);

delete from story_shortlist where run_id = 991091;
