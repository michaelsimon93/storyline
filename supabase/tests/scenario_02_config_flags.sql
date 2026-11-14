-- Configurable settings (app_config) and feature flags (ADR-018).
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- ---------------------------------------------------------------- config: defaults + validation
select t_eq('config: stake default is 500', config_int('pick_stake_cents'), 500);
select t_eq('config: cards_per_day default is 10', config_int('cards_per_day'), 10);
select t_eq('config: price band default 25-75', config_int('price_band_min') || '-' || config_int('price_band_max'), '25-75');
select t_err('config: int setting rejects text',
  $q$update app_config set value = '"ten"' where key = 'cards_per_day'$q$, '%invalid config%');
select t_err('config: int setting rejects out-of-range',
  $q$update app_config set value = '0' where key = 'cards_per_day'$q$, '%invalid config%');
select t_err('config: reading an unknown key fails loudly', $q$select config_int('no_such_key')$q$, '%unknown config%');
-- Regressions (review PR #2)
select t_err('config: int setting rejects a decimal',
  $q$update app_config set value = '10.5' where key = 'cards_per_day'$q$, '%invalid config%');
select t_err('config: int setting must fit a 32-bit integer, even with no max',
  $q$update app_config set max_value = null, value = '3000000000' where key = 'signup_grant_cents'$q$, '%invalid config%');
select t_err('config: numeric settings must keep a min and max',
  $q$update app_config set max_value = null where key = 'cards_per_day'$q$, '%invalid config%');
select t_err('config: price band min must stay below max',
  $q$update app_config set value = '80' where key = 'price_band_min'$q$, '%price_band_min%');
select t_eq('config: max price age is configurable', config_int('max_price_age_seconds'), 120);
select t_eq('config: ingest schedule is configurable (cron, ET)', config_value('ingest_schedule_et') #>> '{}', '0 8-22/2 * * *');
select t_err('config: a schedule with a seconds field is rejected (would run every second)',
  $q$update app_config set value = '"* * * * * *"' where key = 'ingest_schedule_et'$q$, '%5-field cron%');
select t_err('config: a schedule that is not cron is rejected',
  $q$update app_config set value = '"every morning"' where key = 'ingest_schedule_et'$q$, '%5-field cron%');
select t_err('config: a schedule must stay a string',
  $q$update app_config set value = '8', value_type = 'int', min_value = 0, max_value = 23 where key = 'ingest_schedule_et'$q$, '%5-field cron%');
update app_config set value = '"30 9 * * 1-5"' where key = 'ingest_schedule_et';
select t_eq('config: a valid schedule change is accepted', config_value('ingest_schedule_et') #>> '{}', '30 9 * * 1-5');
update app_config set value = '"0 8-22/2 * * *"' where key = 'ingest_schedule_et';
select t_eq('config: price poll interval is configurable', config_int('poller_interval_seconds'), 30);
select t_err('config: price poll interval can''t exceed 50s (prices must stay under a minute old)',
  $q$update app_config set value = '60' where key = 'poller_interval_seconds'$q$, '%poller_interval_seconds%');

-- ---------------------------------------------------------------- config: audit history
update app_config set value = '12' where key = 'cards_per_day';
select t_eq('config: every change is recorded with old -> new',
  (select (old_value->>'value') || '->' || (new_value->>'value') from config_audit
   where key = 'cards_per_day' order by id desc limit 1), '10->12');
update app_config set is_public = true where key = 'cards_per_day';
select t_eq('config: visibility changes are audited too (not just the value)',
  (select (old_value->>'is_public') || '->' || (new_value->>'is_public') from config_audit
   where key = 'cards_per_day' order by id desc limit 1), 'false->true');
update app_config set is_public = false where key = 'cards_per_day';
update app_config set value = '10' where key = 'cards_per_day';

-- ---------------------------------------------------------------- config: money reads from config
insert into players (id, league, full_name, team_id, kalshi_player_id)
  values ('00000000-0000-0000-0000-0000000000a5', 'nba', 'Config Tester', 2, 'k5');
insert into markets (ticker, league, game_id, kind, kalshi_series, title, player_id, stat, strike,
                     yes_ask_cents, no_ask_cents, status, prices_updated_at)
  values ('CFG-10', 'nba', '00000000-0000-0000-0000-0000000000b1', 'player_stat', 'KXNBAPTS',
          'Config Tester: 10+ points', '00000000-0000-0000-0000-0000000000a5', 'points', 10, 50, 51, 'open', now());
insert into cards (id, slate_date, sort_key, game_id, subject, player_id, team_id, market_ticker, blurb)
  values ('00000000-0000-0000-0000-0000000000c5', storyline_today(), 5, '00000000-0000-0000-0000-0000000000b1',
          'player', '00000000-0000-0000-0000-0000000000a5', 2, 'CFG-10', 'config test');
update app_config set value = '300' where key = 'pick_stake_cents';
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('config: stake comes from config ($3)',
  (select stake_cents from place_pick('00000000-0000-0000-0000-0000000000c5', 'yes')), 300);
reset role;
update app_config set value = '500' where key = 'pick_stake_cents';

update app_config set value = '5000' where key = 'signup_grant_cents';
insert into auth.users (id) values ('44444444-4444-4444-4444-444444444444');
set role authenticated; select as_user('44444444-4444-4444-4444-444444444444');
select create_profile('ConfigKid') \g /dev/null
select t_eq('config: signup grant comes from config ($50)', (select balance_cents from wallet_balances), 5000);
reset role;
update app_config set value = '10000' where key = 'signup_grant_cents';

-- ---------------------------------------------------------------- config: access
set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('config: app can read public settings', (select count(*) from app_config where key = 'pick_stake_cents'), 1::bigint);
select t_eq('config: app cannot see internal settings', (select count(*) from app_config where key = 'cards_per_day'), 0::bigint);
select t_err('config: users cannot change settings',
  $q$update app_config set value = '1' where key = 'pick_stake_cents'$q$, 'permission denied%');
select t_err('config: users cannot read the audit log', $q$select * from config_audit$q$, 'permission denied%');
reset role;

-- ---------------------------------------------------------------- flags
insert into feature_flags (key, description, enabled, rollout_percent, allow_user_ids, is_public) values
  ('new_card_design', 'test', true,  0,   array['11111111-1111-1111-1111-111111111111']::uuid[], true),
  ('news_drops',      'test', false, 100, '{}', false),
  ('half',            'test', true,  50,  '{}', true),
  ('other_half',      'test', true,  50,  '{}', true);

select t_eq('flags: unknown flag is off', flag_enabled('no_such_flag', '11111111-1111-1111-1111-111111111111'), false);
select t_eq('flags: disabled flag is off even at 100%', flag_enabled('news_drops', '22222222-2222-2222-2222-222222222222'), false);
select t_eq('flags: allowlist wins at 0% rollout', flag_enabled('new_card_design', '11111111-1111-1111-1111-111111111111'), true);
select t_eq('flags: 0% rollout is off for everyone else', flag_enabled('new_card_design', '22222222-2222-2222-2222-222222222222'), false);

create temp table sample_users as select gen_random_uuid() as id from generate_series(1, 2000);
select t_eq('flags: same user always gets the same answer',
  (select count(*) from sample_users where flag_enabled('half', id) <> flag_enabled('half', id)), 0::bigint);
select t_eq('flags: 50% rollout lands near 50% (40-60%)',
  (select count(*) filter (where flag_enabled('half', id)) between 800 and 1200 from sample_users), true);
update feature_flags set rollout_percent = 20 where key = 'half';
create temp table at20 as select id from sample_users where flag_enabled('half', id);
update feature_flags set rollout_percent = 50 where key = 'half';
select t_eq('flags: raising rollout never drops users already in',
  (select count(*) from at20 where not flag_enabled('half', id)), 0::bigint);
select t_eq('flags: different flags bucket users independently',
  (select count(*) filter (where flag_enabled('half', id) = flag_enabled('other_half', id)) between 800 and 1200 from sample_users), true);
select t_eq('flags: changes are audited',
  (select count(*) >= 2 from config_audit where key = 'half'), true);

set role authenticated; select as_user('11111111-1111-1111-1111-111111111111');
select t_eq('flags: my_flags() returns only public flags, evaluated for me',
  (select string_agg(key || '=' || enabled, ',' order by key) from my_flags()
   where key in ('new_card_design', 'news_drops')), 'new_card_design=true');
select t_err('flags: users cannot change flags',
  $q$update feature_flags set rollout_percent = 100$q$, 'permission denied%');
select t_err('flags: users cannot read the flag table directly', $q$select * from feature_flags$q$, 'permission denied%');
select t_err('flags: users cannot evaluate flags for someone else',
  $q$select flag_enabled('half', '22222222-2222-2222-2222-222222222222')$q$, 'permission denied%');
reset role;
