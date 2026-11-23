-- STO-76: the day's story shortlist (spec §3 steps 1-3, ADR-024). One row per story that has a market, picked by the
-- story job. The Claude ranker (STO-11) reads it; it never writes it. Internal to the worker: no policy, no grant to
-- app roles (ADR-016).
--
-- Choices:
-- * Angle and stat are text, not enums, so a new angle (revenge game STO-93, trending STO-75) is a config row, not a
--   type change (STO-76 design note).
-- * Re-runs: the job replaces the whole day's shortlist in one transaction, keyed by slate_date. A second run for the
--   same day gives the same rows (new ids, same content), never duplicates.
-- * `position` orders the list for display and debugging only. Scores are NOT comparable across angles (STO-103), so it
--   is not a ranking: cross-angle ranking belongs to STO-11.
-- * `slot_kind` says how a story got in: 'quota' (its angle's share) or 'fill' (an unused slot, given out by score).
--   It lets us check the split from the table alone.
-- * Each story's signals are stored with it (ADR-014), so feedback on a blurb traces to what the model saw.

create table story_shortlist (
  id            bigint generated always as identity primary key,
  run_id        bigint not null references pipeline_runs(id),
  slate_date    date not null,
  league        league not null,                                   -- copied from the game, so analytics and filters need no join
  position      integer not null check (position >= 1),
  player_id     uuid not null references players(id),
  game_id       uuid not null references games(id),
  team_id       smallint not null references teams(id),            -- the player's team for this story, kept even if he is traded later
  angle         text not null check (angle <> ''),
  stat          text not null check (stat <> ''),                  -- the detector's key: pts, reb, ast, 3pm
  score         integer not null check (score >= 0),               -- the angle's own scale
  summary       text not null check (summary <> ''),
  market_id     uuid not null references markets(id),               -- the matched, in-band market; STO-11 may pick another strike on the same ladder
  slot_kind     text not null check (slot_kind in ('quota', 'fill')),
  created_at    timestamptz not null default now(),
  constraint story_shortlist_one_story unique (slate_date, player_id, angle, stat),
  constraint story_shortlist_one_position unique (slate_date, position)
);
create index story_shortlist_by_run on story_shortlist (run_id);

create table story_shortlist_signals (
  shortlist_id bigint not null references story_shortlist(id) on delete cascade,
  signal_id    bigint not null references signals(id),
  primary key (shortlist_id, signal_id)
);
create index story_shortlist_signals_by_signal on story_shortlist_signals (signal_id);

alter table story_shortlist         enable row level security;   -- no policies: internal (worker) only
alter table story_shortlist_signals enable row level security;   -- no policies: internal (worker) only
revoke all on story_shortlist, story_shortlist_signals from anon, authenticated;

-- The shortlist's size and the per-angle split (ADR-018). The split is a weight per angle: an angle's quota is
-- floor(size * weight / sum of weights), and slots left over (rounding, or an angle with too few stories) go to the
-- highest-scoring stories left, whatever their angle. All weights equal = an even split. A weight of 0 means the angle
-- gets no quota but can still win a fill slot. A new angle adds a shortlist_split_<angle> row in its own migration.
insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values
  ('shortlist_size', '50', 'int', 1, 500, false,
   'Stories on the daily shortlist the Claude ranker reads'),
  ('shortlist_split_hot_streak', '1', 'int', 0, 100, false,
   'Shortlist split: hot streak''s weight (quota = size x weight / sum of weights; unused slots go to the best scores)'),
  ('shortlist_split_back_from_injury', '1', 'int', 0, 100, false,
   'Shortlist split: back from injury''s weight'),
  ('shortlist_split_backup_steps_in', '1', 'int', 0, 100, false,
   'Shortlist split: backup stepping in''s weight');
