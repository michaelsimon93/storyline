-- STO-76 part 1b: the story detectors' thresholds (ADR-018). Every number is a typed, range-checked
-- app_config row so tuning is an update, not a deploy, and a typo (margin 0, minimum games 1) is rejected at
-- write time. No defaults in code. Values are starting points: tune them by reading the #testing output.
-- Not public: the app never sees them.

insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values
  ('story_min_minutes', '10', 'int', 1, 48, false,
   'A game counts toward a player''s averages and streaks only if he played at least this many minutes'),
  ('story_baseline_min_games', '5', 'int', 1, 82, false,
   'Fewest counted games before we trust a player''s average enough to call anything hot, or a teammate''s minutes enough to call him a starter'),
  ('story_hot_streak_min_games', '3', 'int', 2, 15, false,
   'Hot streak: fewest straight team games at or above his average'),
  ('story_hot_streak_margin_pct', '20', 'int', 1, 500, false,
   'Hot streak: the streak''s average must beat his season average by at least this percent'),
  ('story_min_stat_avg_tenths', '10', 'int', 0, 500, false,
   'Ignore a stat he averages under this many tenths per game (10 = 1.0), so "1 three after 0.2 a game" isn''t a streak'),
  ('story_return_min_missed_games', '3', 'int', 1, 30, false,
   'Back from injury: fewest straight team games he missed'),
  ('story_backup_max_min', '24', 'int', 1, 48, false,
   'Backup stepping in: a player averaging this many minutes or more is not a backup'),
  ('story_backup_out_min_minutes', '28', 'int', 1, 48, false,
   'Backup stepping in: a teammate who is out must average at least this many minutes to matter'),
  ('story_backup_out_recent_games', '3', 'int', 1, 20, false,
   'Backup stepping in: the out teammate must have played in one of the team''s last this-many games, so a star out for weeks isn''t news tonight'),
  ('story_score_max', '100', 'int', 1, 1000, false,
   'Top of the story score scale; every score is capped here'),
  ('story_score_return', '60', 'int', 0, 1000, false,
   'Back from injury: base score (each missed game adds 1), capped at story_score_max');
