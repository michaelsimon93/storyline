-- STO-112 / STO-117: the story, curate and publish steps run once a day, after the ESPN context pull (9:30).
-- Each schedule is its own row (ADR-018), validated by the _schedule_et trigger from STO-8, and each is read by
-- its own tolerant loader (worker/src/lib/jobSchedules.ts), NOT by the startup config: a missing or mistyped row
-- skips only that job and alerts, instead of crash-looping the worker (STO-106).
-- Daily order, ET: 9:30 ESPN context -> 9:45 story -> 10:00 curate -> 10:15 publish.
insert into app_config (key, value, value_type, is_public, description) values
  ('story_schedule_et', '"45 9 * * *"', 'string', false,
   'When the story step runs (cron, ET): once a day, after the ESPN context pull (9:30) and before curation'),
  ('curate_schedule_et', '"0 10 * * *"', 'string', false,
   'When curation runs (cron, ET): once a day, after the story step; it refuses to run unless today''s story run succeeded'),
  ('publish_schedule_et', '"15 10 * * *"', 'string', false,
   'When the day''s cards are published (cron, ET): once a day, after curation');
