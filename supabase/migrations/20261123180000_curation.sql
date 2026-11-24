-- STO-11: Claude ranks the stories and picks the day's cards.
--
-- 1. Settings (ADR-018): every number and the model name is a typed, bounded app_config row, so tuning is an update,
--    not a deploy. Private: the app never sees them. Starting values are guesses to tune from the #testing output.
-- 2. curation_attempts (Michael's call, Nov 23: a table, not a column on pipeline_runs): one row per call to Claude,
--    with exactly what it was shown, what it answered and why that was rejected. Rejected answers are the data prompt
--    tuning needs, and as rows they can be queried instead of dug out of one JSON blob. Internal to the worker:
--    no policy and no grant to app roles (ADR-016).

insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values
  ('curation_model', '"claude-opus-5-5"', 'string', null, null, false,
   'Claude model that ranks the stories and picks the cards'),
  ('curation_effort', '"high"', 'string', null, null, false,
   'Claude thinking effort for curation: low, medium, high, xhigh or max'),
  ('curation_max_tokens', '16000', 'int', 1024, 64000, false,
   'Most tokens Claude may use in one curation answer (an answer cut off at this limit is rejected and retried)'),
  ('curation_max_attempts', '3', 'int', 1, 10, false,
   'Calls to Claude before curation gives up, alerts, and publishes nothing'),
  ('curation_max_per_game', '3', 'int', 1, 30, false,
   'Most cards in one day''s deck that may come from the same game'),
  ('curation_max_per_stat', '4', 'int', 1, 30, false,
   'Most cards in one day''s deck that may be about the same stat (points, rebounds, ...)');

create table curation_attempts (
  id          bigint generated always as identity primary key,
  run_id      bigint not null references pipeline_runs(id),
  attempt     integer not null check (attempt >= 1),
  request     jsonb not null check (jsonb_typeof(request) = 'object'),   -- what the curator was given: stories as shown (ladders already in the band), rules, retry feedback
  output      jsonb,                                                      -- its raw answer; null if the call itself failed
  violations  jsonb not null default '[]' check (jsonb_typeof(violations) = 'array'),
  error       text,                                                       -- set when the call failed (overload, refusal, cut off) rather than breaking a rule
  accepted    boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint curation_attempts_one_per_call unique (run_id, attempt),
  -- Accepted means it answered and broke nothing.
  constraint curation_attempts_accepted_is_clean check (not accepted or (output is not null and error is null and violations = '[]'::jsonb))
);
-- A run publishes at most one answer.
create unique index curation_attempts_one_accepted on curation_attempts (run_id) where accepted;

alter table curation_attempts enable row level security;   -- no policies: internal (worker) only
revoke all on curation_attempts from anon, authenticated;
