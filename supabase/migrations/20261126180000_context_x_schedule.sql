-- STO-145: the X search (context:x) runs once a day, after the ESPN context pull (9:30) and before the story step (9:45).
-- Its own row (ADR-018), read by its own tolerant loader (worker/src/lib/jobSchedules.ts), NOT by the startup config: a missing
-- or mistyped row skips only this job and alerts, instead of crash-looping the worker (STO-106).
-- Whether it spends anything is still the context_x flag, checked on every run: off = no Grok call.
-- Daily order, ET: 9:30 ESPN context -> 9:35 X -> 9:45 story -> 10:00 curate -> 10:15 publish.
insert into app_config (key, value, value_type, is_public, description) values
  ('context_x_schedule_et', '"35 9 * * *"', 'string', false,
   'When the X search runs (cron, ET): once a day, after the ESPN context pull (9:30) and before the story step (9:45). The context_x flag decides whether it does anything');
