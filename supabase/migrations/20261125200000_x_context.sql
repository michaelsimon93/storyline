-- STO-75 part 1 / ADR-024: X (via Grok search) as a context source. This migration adds the account list that decides
-- who may be quoted, the two switches, and the settings the run reads. Internal to the worker (ADR-016).
--
-- x_accounts: one row per X handle we have pulled a post from. Status is the trust decision (ADR-024 rule 2): a post from an
-- 'approved' handle becomes an `attributed` signal; anything else is `unreviewed` and can never appear in a blurb. Rows start
-- 'unreviewed'; the worker only ever inserts or refreshes them. Approving or rejecting is a hand-run SQL update for now
-- (the admin dashboard later), so no role but the worker's can change status. Michael's call, Nov 25: no follower threshold.
--
-- A single X-specific table, not a generic source_accounts (decided with Michael, Nov 25): the second source that needs one
-- is the time to generalise (ADR-021 rule 6).

create type x_account_status as enum ('unreviewed', 'approved', 'rejected');

create table x_accounts (
  handle          text primary key check (handle ~ '^[a-z0-9_]{1,15}$'),   -- lower case, no @: X handles are case-insensitive
  status          x_account_status not null default 'unreviewed',
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  sample_url      text,                                                       -- the newest post we pulled, shown for review
  sample_excerpt  text,
  reviewed_at     timestamptz,
  constraint x_accounts_review_is_dated check ((status = 'unreviewed') = (reviewed_at is null))
);
-- Status is the only thing a person decides. Keep the review date honest: stamped when a row is created reviewed or its status
-- changes, cleared when it goes back to unreviewed. (The check above still stops a plain update from clearing a reviewed date.)
create function x_accounts_stamp_review() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.reviewed_at := case when new.status = 'unreviewed' then null else coalesce(case when tg_op = 'INSERT' then new.reviewed_at end, now()) end;
  end if;
  return new;
end $$;
create trigger x_accounts_stamp_review before insert or update on x_accounts for each row execute function x_accounts_stamp_review();

alter table x_accounts enable row level security;   -- no policies: internal (worker) only
revoke all on x_accounts from anon, authenticated;

-- Settings (ADR-018): typed and range-checked, no defaults in code.
insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values
  ('x_model', '"grok-4"', 'string', null, null, false,
   'The xAI model that runs the X search (Responses API, x_search tool)'),
  ('x_timeout_ms', '120000', 'int', 5000, 600000, false,
   'How long to wait for one Grok search before calling it failed. A search runs several tool calls, so it takes tens of seconds'),
  ('x_max_stories', '8', 'int', 1, 30, false,
   'The most stories the slate-wide search is asked for (and kept)'),
  ('x_max_posts_per_run', '25', 'int', 1, 500, false,
   'Hard cap on posts kept from one run. Posts past it are dropped and counted in the run summary');

-- Two switches, both off to start. `context_x` runs the source. While `context_x_report_only` is on, the run still searches and
-- lists the accounts it pulled from in #testing, but stores no signals, so nothing X says reaches curation. Turn report-only off
-- once enough accounts are approved. Not public: the app never sees them (a card's content is the exposure, logged elsewhere).
insert into feature_flags (key, description, enabled, is_public) values
  ('context_x', 'Search X via Grok for stories and buzz (STO-75). Off: no run, no spend', false, false),
  ('context_x_report_only', 'With context_x on: collect and list accounts only; store no signals, so X changes nothing on a card (STO-75)', true, false);
