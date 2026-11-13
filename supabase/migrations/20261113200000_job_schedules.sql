-- STO-8: job schedules are configuration, not code (ADR-018).
-- Cron patterns are evaluated in America/New_York by the worker, which validates them at
-- startup and refuses to start on an invalid pattern (cron syntax isn't checked in SQL).
-- Migrations are now named with a timestamp prefix so parallel branches don't collide
-- on the next sequence number (0001/0002 keep their names; they still sort first).
insert into app_config (key, value, value_type, is_public, description) values
  ('ingest_schedule_et', '"0 8-22/2 * * *"', 'string', false,
   'When ingest runs (cron, ET): every 2 hours from 8am to 10pm, to pick up tip-off and injury changes');
