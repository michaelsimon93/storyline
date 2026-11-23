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
