-- STO-77: Claude writes the blurbs for the day's chosen cards.
--
-- 1. curation_attempts gets a `step`: the pick call and the blurb call are separate calls to Claude
--    in one run, and each keeps its own attempts and its own one accepted answer. Existing rows are
--    all 'pick'. The two constraints keep their names (tests and alerts refer to them) and now
--    apply per step.
-- 2. blurb_max_chars (ADR-018): the blurb length limit is a setting, not a number in code. It is
--    bounded by the database's own limit on cards.blurb (200, spec section 3), so it can be
--    lowered but never set to a value the cards table would reject.

alter table curation_attempts
  add column step text not null default 'pick' check (step in ('pick', 'blurb'));

alter table curation_attempts drop constraint curation_attempts_one_per_call;
alter table curation_attempts add constraint curation_attempts_one_per_call unique (run_id, step, attempt);

drop index curation_attempts_one_accepted;
create unique index curation_attempts_one_accepted on curation_attempts (run_id, step) where accepted;

insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values
  ('blurb_max_chars', '200', 'int', 40, 200, false,
   'Longest blurb, in characters. The cards table allows 200, so this can be lowered but not raised');
