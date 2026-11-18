-- STO-76 part 1b: the story detectors' settings (ADR-018). They exist, typed and bounded, read through
-- config_int(); bad values are rejected; the app can neither see nor change them.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

select t_eq('story cfg: all eleven settings are private int rows with explicit bounds',
  (select count(*)::int from app_config where key like 'story\_%' and value_type = 'int' and min_value is not null and max_value is not null and not is_public), 11);
select t_eq('story cfg: starting values, read through config_int()',
  (select array[config_int('story_min_minutes'), config_int('story_baseline_min_games'), config_int('story_hot_streak_min_games'),
                config_int('story_hot_streak_margin_pct'), config_int('story_min_stat_avg_tenths'), config_int('story_return_min_missed_games'),
                config_int('story_backup_max_min'), config_int('story_backup_out_min_minutes'), config_int('story_backup_out_recent_games'), config_int('story_score_max'), config_int('story_score_return')]),
  array[10, 5, 3, 20, 10, 3, 24, 28, 3, 100, 60]);

-- out of range is rejected
select t_err('story cfg: a 1-game "streak" is rejected',            $q$update app_config set value = '1'   where key = 'story_hot_streak_min_games'$q$, '%invalid config%');
select t_err('story cfg: a 0% margin is rejected (everything would be hot)', $q$update app_config set value = '0' where key = 'story_hot_streak_margin_pct'$q$, '%invalid config%');
select t_err('story cfg: a 501% margin is rejected',                $q$update app_config set value = '501' where key = 'story_hot_streak_margin_pct'$q$, '%invalid config%');
select t_err('story cfg: 0 minutes is rejected',                    $q$update app_config set value = '0'   where key = 'story_min_minutes'$q$, '%invalid config%');
select t_err('story cfg: more than 48 minutes is rejected',         $q$update app_config set value = '49'  where key = 'story_backup_max_min'$q$, '%invalid config%');
select t_err('story cfg: a baseline of 0 games is rejected',        $q$update app_config set value = '0'   where key = 'story_baseline_min_games'$q$, '%invalid config%');
select t_err('story cfg: a negative stat floor is rejected',        $q$update app_config set value = '-1'  where key = 'story_min_stat_avg_tenths'$q$, '%invalid config%');
select t_err('story cfg: a recent-games window of 0 is rejected (no star would ever count)', $q$update app_config set value = '0' where key = 'story_backup_out_recent_games'$q$, '%invalid config%');
select t_err('story cfg: a recent-games window past 20 is rejected', $q$update app_config set value = '21' where key = 'story_backup_out_recent_games'$q$, '%invalid config%');
select t_err('story cfg: a score cap of 0 is rejected',             $q$update app_config set value = '0'   where key = 'story_score_max'$q$, '%invalid config%');
select t_err('story cfg: a fractional value is rejected',           $q$update app_config set value = '2.5' where key = 'story_return_min_missed_games'$q$, '%invalid config%');
select t_err('story cfg: a text value is rejected',                 $q$update app_config set value = '"three"' where key = 'story_hot_streak_min_games'$q$, '%invalid config%');
select t_err('story cfg: the bounds themselves cannot be removed',  $q$update app_config set max_value = null where key = 'story_score_max'$q$, '%invalid config%');
select t_eq('story cfg: nothing above changed a value', (select array[config_int('story_hot_streak_min_games'), config_int('story_hot_streak_margin_pct')]), array[3, 20]);
-- the edges are allowed
update app_config set value = '2' where key = 'story_hot_streak_min_games';
update app_config set value = '1' where key = 'story_hot_streak_margin_pct';
update app_config set value = '0' where key = 'story_min_stat_avg_tenths';
select t_eq('story cfg: the lowest valid values are accepted',
  (select array[config_int('story_hot_streak_min_games'), config_int('story_hot_streak_margin_pct'), config_int('story_min_stat_avg_tenths')]), array[2, 1, 0]);
update app_config set value = '3'  where key = 'story_hot_streak_min_games';
update app_config set value = '20' where key = 'story_hot_streak_margin_pct';
update app_config set value = '10' where key = 'story_min_stat_avg_tenths';

-- users can't see or change them
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('story cfg: the app cannot see the settings', (select count(*) from app_config where key like 'story\_%'), 0::bigint);
select t_err('story cfg: users cannot change a setting', $q$update app_config set value = '1' where key = 'story_score_max'$q$, 'permission denied%');
reset role;
