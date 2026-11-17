-- STO-10 part 3b: the settings and the switch for the ESPN context runner (ADR-018, ADR-024 rule 5).
-- Every number the runner uses is a row here, typed and range-checked by the app_config trigger, so a
-- typo (window 0, pause -5) is rejected at write time instead of surfacing mid-pull. No defaults in code.

insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values
  ('espn_form_window_games', '5', 'int', 1, 15, false,
   'How many recent games the ESPN form signals (points, rebounds, assists, threes) cover'),
  ('espn_pause_ms', '250', 'int', 0, 5000, false,
   'Minimum gap between ESPN calls, in ms; a slate is ~150-200 calls, so this paces a pull to about a minute'),
  ('espn_max_consecutive_failures', '5', 'int', 1, 50, false,
   'Stop and call ESPN down after this many failed calls in a row, so an outage fails in minutes'),
  ('espn_degraded_failed_players', '5', 'int', 0, 1000, false,
   'Alert that a pull is degraded when MORE than this many players had no game log (0 = alert on any)'),
  ('espn_fallback_max_age_days', '1', 'int', 0, 14, false,
   'When ESPN is down, STAT signals (form, home/road, series) from pulls up to this many slate days old may stand in, dated; injuries and news only ever from today (0 = today only)');

-- When the ESPN pull runs (cron, ET; validated by the _schedule_et trigger). After the 8am ingest, before curation.
insert into app_config (key, value, value_type, is_public, description) values
  ('context_espn_schedule_et', '"30 9 * * *"', 'string', false,
   'When the ESPN context pull runs (cron, ET): once a day, after the morning ingest and before curation');

-- Off until Michael turns it on: the first real pull should be watched (ESPN's limits are unmeasured).
-- Not public: the app never sees it, and curation output doesn't change until a later issue reads signals,
-- so there is no flag_exposure to log.
insert into feature_flags (key, description, enabled, is_public) values
  ('context_espn', 'Pull ESPN signals (form, home/road, series, injuries, news) for the slate (STO-10)', false, false);
