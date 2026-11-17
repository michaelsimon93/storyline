-- STO-10 part 2 / ADR-024 rule 2: a signal is a fact with a source. Context sources (ESPN today)
-- return signals; the curator's blurbs cite their IDs (ADR-014), so an ID must never change or be
-- reused. Internal to the worker: no policy, no grant to app roles (ADR-016).
--
-- Choices (Michael, Nov 17):
-- * Subject: one nullable FK column per kind, exactly one set (like external_ids). The database,
--   not worker code, guarantees a signal is about a real player, team or game.
-- * Re-runs: one signal per (source, subject, slate day, key). Seeing it again keeps its ID,
--   refreshes the text only if the new sighting is newer, and re-stamps run_id.
-- * ESPN-down fallback (part 3): "last successful pull" = the signals owned by the newest ok
--   pipeline_runs row of that source. run_id is re-stamped on every sighting so a re-run that
--   inserts nothing still owns what it saw. observed_at stays each signal's own date.

create type signal_kind  as enum ('stat', 'news', 'injury', 'buzz', 'story');
create type signal_trust as enum ('verified', 'attributed', 'unreviewed');

create table signals (
  id          bigint generated always as identity primary key,   -- the fact ID blurbs cite
  source      text not null check (source <> ''),                -- a value, never a column (ADR-021)
  kind        signal_kind not null,
  slate_date  date not null,
  player_id   uuid     references players(id),
  team_id     smallint references teams(id),
  game_id     uuid     references games(id),
  key         text not null check (key <> ''),
  summary     text not null check (summary <> ''),
  evidence    jsonb not null check (jsonb_typeof(evidence) = 'object' and (evidence ? 'url' or evidence ? 'quote')),
  observed_at timestamptz not null,                              -- when we saw it; the fallback keeps it
  trust       signal_trust not null,
  run_id      bigint not null references pipeline_runs(id),      -- the run that last stored it
  created_at  timestamptz not null default now(),
  check (num_nonnulls(player_id, team_id, game_id) = 1),
  constraint signals_one_per_day unique nulls not distinct (source, player_id, team_id, game_id, slate_date, key)
);
create index signals_by_run  on signals (run_id);
create index signals_by_slate on signals (slate_date, source);

alter table signals enable row level security;   -- no policies: internal (worker) only

-- Stores one run's signals (SignalDraft JSON: kind, subject {kind,id}, summary, evidence
-- {url?, quote?, observedAt}, trust, key). Safe to re-run and to run concurrently: the unique
-- constraint is the arbiter, so no duplicates. Existing signals keep their ID; summary, evidence,
-- trust and observed_at move only to a newer sighting; run_id moves to the newer run.
-- Returns how many distinct signals the batch covered. Worker-only; a plain function (not
-- security definer) because the worker already connects privileged.
create function store_signals(p_run_id bigint, p_source text, p_slate_date date, p_signals jsonb)
returns integer language plpgsql as $$
declare v_n integer;
begin
  with drafts as (
    select distinct on (s.subj_kind, s.subj_id, s.key)    -- same fact twice in one batch: newest wins
           s.kind, s.subj_kind, s.subj_id, s.key, s.summary, s.evidence, s.observed_at, s.trust
      from jsonb_to_recordset(p_signals) as d(kind text, subject jsonb, summary text, evidence jsonb, trust text, key text),
      lateral (select d.kind::signal_kind as kind, d.subject->>'kind' as subj_kind, d.subject->>'id' as subj_id,
                      d.key, d.summary, d.evidence - 'observedAt' as evidence,
                      (d.evidence->>'observedAt')::timestamptz as observed_at, d.trust::signal_trust as trust) s
     order by s.subj_kind, s.subj_id, s.key, s.observed_at desc
  ), ins as (
    insert into signals (source, kind, slate_date, player_id, team_id, game_id, key, summary, evidence, observed_at, trust, run_id)
    select p_source, kind, p_slate_date,
           case when subj_kind = 'player' then subj_id::uuid end,
           case when subj_kind = 'team'   then subj_id::smallint end,
           case when subj_kind = 'game'   then subj_id::uuid end,
           key, summary, evidence, observed_at, trust, p_run_id
      from drafts
    on conflict on constraint signals_one_per_day do update set
      summary     = case when excluded.observed_at > signals.observed_at then excluded.summary     else signals.summary     end,
      evidence    = case when excluded.observed_at > signals.observed_at then excluded.evidence    else signals.evidence    end,
      trust       = case when excluded.observed_at > signals.observed_at then excluded.trust       else signals.trust       end,
      observed_at = greatest(excluded.observed_at, signals.observed_at),
      run_id      = excluded.run_id
     where excluded.run_id >= signals.run_id              -- an older run replayed can't claim it back
    returning 1
  )
  select count(*) into v_n from drafts;
  return v_n;
end $$;
revoke all on function store_signals(bigint, text, date, jsonb) from public, anon, authenticated;
grant execute on function store_signals(bigint, text, date, jsonb) to service_role;
