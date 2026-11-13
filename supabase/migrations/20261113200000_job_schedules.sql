-- STO-8: job schedules are configuration, not code (ADR-018).
-- Cron patterns are evaluated in America/New_York by the worker, which also refuses to start
-- on a pattern croner can't parse. The database rejects bad shapes at write time, so a typo
-- can't stop every job on the next deploy, and a 6-field pattern (croner reads the first
-- field as seconds) can't make a job run every second.

-- Any app_config key ending in _schedule_et must be a 5-field cron pattern using only
-- digits, *, commas, ranges and steps (no names, no seconds field).
create or replace function validate_schedule_config() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.key like '%\_schedule\_et' and (
       new.value_type <> 'string'
       or (new.value #>> '{}') !~ '^[0-9*,/-]+( [0-9*,/-]+){4}$') then
    raise exception 'invalid config %: % (expected a 5-field cron pattern, e.g. "0 8-22/2 * * *")',
      new.key, new.value;
  end if;
  return new;
end $$;
revoke all on function validate_schedule_config() from public, anon, authenticated;

create trigger app_config_schedule_validate before insert or update on app_config
  for each row execute function validate_schedule_config();

insert into app_config (key, value, value_type, is_public, description) values
  ('ingest_schedule_et', '"0 8-22/2 * * *"', 'string', false,
   'When ingest runs (cron, ET): every 2 hours from 8am to 10pm, to pick up tip-off and injury changes');
