-- STO-10 part 2 / ADR-024 rule 2: a signal is a fact with a source. Context sources (ESPN today)
-- return signals; the curator's blurbs cite their IDs (ADR-014), so an ID must never change or be
-- reused. Internal to the worker: no policy, no grant to app roles (ADR-016).
--
-- Choices (Michael, Nov 17):
-- * Subject: one nullable FK column per kind, exactly one set (like external_ids). The database,
--   not worker code, guarantees a signal is about a real player, team or game.
-- * Re-runs: one signal per (source, subject, slate day, key). Seeing it again keeps its ID and
--   refreshes the text only if the new sighting is newer (kind is set at first sight and kept).
-- * ESPN-down fallback (part 3): "last successful pull" = the signals SEEN by the newest ok
--   pipeline_runs row of that source, through signal_sightings (one row per signal per run).
--   A sighting is added, never moved, so a later run that stores signals and then fails can't
--   take them from the last ok run (found by qa: withRun is not a transaction).
--   signals.run_id stays the run that first stored it. observed_at is each signal's own date.

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
  evidence    jsonb not null check (jsonb_typeof(evidence) = 'object'
                and (nullif(evidence->>'url', '') is not null or nullif(evidence->>'quote', '') is not null)),
  observed_at timestamptz not null,                              -- when we saw it; the fallback keeps it
  trust       signal_trust not null,
  run_id      bigint not null references pipeline_runs(id),      -- the run that first stored it
  created_at  timestamptz not null default now(),
  check (num_nonnulls(player_id, team_id, game_id) = 1),
  constraint signals_one_per_day unique nulls not distinct (source, player_id, team_id, game_id, slate_date, key)
);
create index signals_by_slate on signals (slate_date, source);

-- Every run that saw a signal. "What did run N see?" is the fallback's and the audit trail's question.
create table signal_sightings (
  signal_id bigint not null references signals(id),
  run_id    bigint not null references pipeline_runs(id),
  primary key (run_id, signal_id)
);
create index signal_sightings_by_signal on signal_sightings (signal_id);

alter table signals          enable row level security;   -- no policies: internal (worker) only
alter table signal_sightings enable row level security;   -- no policies: internal (worker) only

-- Stores one run's signals (SignalDraft JSON: kind, subject {kind,id}, summary, evidence
-- {url?, quote?, observedAt}, trust, key). Safe to re-run and to run concurrently: the unique
-- constraint is the arbiter, so no duplicates. Existing signals keep their ID; summary, evidence,
-- trust and observed_at move only to a newer sighting; every call records that p_run_id saw each
-- signal. observedAt must carry a UTC offset (Z or +hh:mm), so a signal's date can't shift with the
-- session time zone. The same fact twice in one batch (same typed subject and key) stores once, the
-- newest sighting winning. A bad draft rejects the whole batch. Returns how many distinct signals
-- the batch covered. Worker-only; a plain function (not security definer) because the worker
-- already connects privileged.
create function store_signals(p_run_id bigint, p_source text, p_slate_date date, p_signals jsonb)
returns integer language plpgsql as $$
declare v_n integer;
begin
  if exists (select 1 from jsonb_array_elements(coalesce(p_signals, '[]')) e
              where coalesce(e->'evidence'->>'observedAt', '') !~ '^\d{4}-\d\d-\d\d[T ][0-9:.]+(Z|[+-]\d\d(:?\d\d)?)$') then
    raise exception 'bad_observed_at: every signal needs evidence.observedAt as an ISO timestamp with a UTC offset';
  end if;
  with drafts as (
    select distinct on (s.player_id, s.team_id, s.game_id, s.key)   -- typed ids: 'A..' and 'a..' are one player
           s.kind, s.player_id, s.team_id, s.game_id, s.key, s.summary, s.evidence, s.observed_at, s.trust
      from jsonb_to_recordset(coalesce(p_signals, '[]')) as d(kind text, subject jsonb, summary text, evidence jsonb, trust text, key text),
      lateral (select d.kind::signal_kind as kind,
                      case when d.subject->>'kind' = 'player' then (d.subject->>'id')::uuid end as player_id,
                      case when d.subject->>'kind' = 'team'   then (d.subject->>'id')::smallint end as team_id,
                      case when d.subject->>'kind' = 'game'   then (d.subject->>'id')::uuid end as game_id,
                      d.key, d.summary, d.evidence - 'observedAt' as evidence,
                      (d.evidence->>'observedAt')::timestamptz as observed_at, d.trust::signal_trust as trust) s
     order by s.player_id, s.team_id, s.game_id, s.key, s.observed_at desc
  ), ins as (
    insert into signals (source, kind, slate_date, player_id, team_id, game_id, key, summary, evidence, observed_at, trust, run_id)
    select p_source, kind, p_slate_date, player_id, team_id, game_id, key, summary, evidence, observed_at, trust, p_run_id
      from drafts
    on conflict on constraint signals_one_per_day do update set
      summary     = case when excluded.observed_at > signals.observed_at then excluded.summary  else signals.summary  end,
      evidence    = case when excluded.observed_at > signals.observed_at then excluded.evidence else signals.evidence end,
      trust       = case when excluded.observed_at > signals.observed_at then excluded.trust    else signals.trust    end,
      observed_at = greatest(excluded.observed_at, signals.observed_at)
    returning id
  ), seen as (
    insert into signal_sightings (signal_id, run_id) select id, p_run_id from ins on conflict do nothing
  )
  select count(*) into v_n from ins;
  return v_n;
end $$;
revoke all on function store_signals(bigint, text, date, jsonb) from public, anon, authenticated;
grant execute on function store_signals(bigint, text, date, jsonb) to service_role;
