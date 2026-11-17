-- STO-10 part 3b: the ESPN context runner's settings and flag (ADR-018). Range checks, the schedule's
-- cron check, the flag shipping off, and that users can't read or change any of it.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- ---------------------------------------------------------------- the rows exist, typed, as seeded
select t_eq('espn cfg: the five numeric settings are int rows with explicit bounds',
  (select count(*)::int from app_config where key in ('espn_form_window_games', 'espn_pause_ms', 'espn_max_consecutive_failures',
     'espn_degraded_failed_players', 'espn_fallback_max_age_days') and value_type = 'int' and min_value is not null and max_value is not null and not is_public), 5);
select t_eq('espn cfg: readable through config_int() like every other setting',
  (select array[config_int('espn_form_window_games'), config_int('espn_pause_ms'), config_int('espn_max_consecutive_failures'),
                config_int('espn_degraded_failed_players'), config_int('espn_fallback_max_age_days')]), array[5, 250, 5, 5, 2]);
select t_eq('espn cfg: the pull has a schedule', (select value #>> '{}' from app_config where key = 'context_espn_schedule_et'), '30 9 * * *');

-- ---------------------------------------------------------------- out-of-range values are rejected
select t_err('espn cfg: a form window of 0 games is rejected',  $q$update app_config set value = '0'  where key = 'espn_form_window_games'$q$, '%invalid config%');
select t_err('espn cfg: a form window past 15 is rejected',     $q$update app_config set value = '16' where key = 'espn_form_window_games'$q$, '%invalid config%');
select t_err('espn cfg: a negative pause is rejected',          $q$update app_config set value = '-1' where key = 'espn_pause_ms'$q$, '%invalid config%');
select t_err('espn cfg: a pause over 5s is rejected',           $q$update app_config set value = '5001' where key = 'espn_pause_ms'$q$, '%invalid config%');
select t_err('espn cfg: 0 consecutive failures is rejected (it would call every pull down)', $q$update app_config set value = '0' where key = 'espn_max_consecutive_failures'$q$, '%invalid config%');
select t_err('espn cfg: over 50 consecutive failures is rejected', $q$update app_config set value = '51' where key = 'espn_max_consecutive_failures'$q$, '%invalid config%');
select t_err('espn cfg: a negative failed-player threshold is rejected', $q$update app_config set value = '-1' where key = 'espn_degraded_failed_players'$q$, '%invalid config%');
select t_err('espn cfg: a fallback older than 14 days is rejected', $q$update app_config set value = '15' where key = 'espn_fallback_max_age_days'$q$, '%invalid config%');
select t_err('espn cfg: a negative fallback age is rejected',   $q$update app_config set value = '-1' where key = 'espn_fallback_max_age_days'$q$, '%invalid config%');
select t_err('espn cfg: a fractional value is rejected',        $q$update app_config set value = '2.5' where key = 'espn_fallback_max_age_days'$q$, '%invalid config%');
select t_err('espn cfg: a text value is rejected',              $q$update app_config set value = '"five"' where key = 'espn_form_window_games'$q$, '%invalid config%');
select t_err('espn cfg: the bounds themselves cannot be removed', $q$update app_config set max_value = null where key = 'espn_pause_ms'$q$, '%invalid config%');
select t_err('espn cfg: a six-field schedule is rejected',      $q$update app_config set value = '"* * * * * *"' where key = 'context_espn_schedule_et'$q$, '%5-field cron%');
select t_eq('espn cfg: nothing above changed a value', (select array[config_int('espn_form_window_games'), config_int('espn_pause_ms')]), array[5, 250]);
-- the edges are allowed
update app_config set value = '1' where key = 'espn_form_window_games';
update app_config set value = '0' where key = 'espn_pause_ms';
update app_config set value = '0' where key = 'espn_degraded_failed_players';
update app_config set value = '0' where key = 'espn_fallback_max_age_days';
select t_eq('espn cfg: the lowest valid values are accepted',
  (select array[config_int('espn_form_window_games'), config_int('espn_pause_ms'), config_int('espn_degraded_failed_players'), config_int('espn_fallback_max_age_days')]), array[1, 0, 0, 0]);
update app_config set value = '5' where key = 'espn_form_window_games';
update app_config set value = '250' where key = 'espn_pause_ms';
update app_config set value = '5' where key = 'espn_degraded_failed_players';
update app_config set value = '2' where key = 'espn_fallback_max_age_days';

-- ---------------------------------------------------------------- the flag ships off and private
select t_eq('espn flag: exists, off, not public',
  (select array[enabled::text, is_public::text, rollout_percent::text] from feature_flags where key = 'context_espn'), array['false', 'false', '0']);
select t_eq('espn flag: no user sees it as on', flag_enabled('context_espn', '11111111-1111-1111-1111-111111111111'), false);

-- ---------------------------------------------------------------- users can't see or change any of it
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('espn cfg: the app cannot see the settings',
  (select count(*) from app_config where key like 'espn\_%' or key = 'context_espn_schedule_et'), 0::bigint);
select t_err('espn cfg: users cannot change a setting', $q$update app_config set value = '1' where key = 'espn_pause_ms'$q$, 'permission denied%');
select t_err('espn flag: users cannot turn the source on', $q$update feature_flags set enabled = true where key = 'context_espn'$q$, 'permission denied%');
select t_err('espn flag: users cannot read the flag table', $q$select * from feature_flags where key = 'context_espn'$q$, 'permission denied%');
select t_eq('espn flag: my_flags() doesn''t list it', (select count(*) from my_flags() where key = 'context_espn'), 0::bigint);
reset role;
