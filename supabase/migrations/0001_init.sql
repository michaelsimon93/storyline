-- =============================================================================
-- Storyline v1: initial schema (rev 2: hardened for future features)
-- Supabase (Postgres). The worker writes with the service role; the web app reads
-- as an anonymous-auth user and can only act through RLS policies + functions.
-- Money is integer cents everywhere. Prices are integer cents (1-99) = percent.
-- Play money only. There will never be real money (product decision, Nov 13).
--
-- Future-proofing decisions baked in here:
--   * league on everything            -> NFL without collisions (MIN vs MIN)
--   * cards/markets about player|team|game -> team & matchup storylines
--   * wallets                          -> contests with separate bankrolls
--   * pick_credits                     -> "free $20 trade" style bonuses
--   * card.locks_at                    -> cards dropped any time (news), in-game later
--   * one pick per card per wallet     -> one line per player, even with adjustable lines
-- Deliberately NOT modeled yet (additive later, no rework): combos/parlays,
-- follows (+ friends seeing picks before lock), contests table, cash-out.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type league        as enum ('nba', 'nfl');
create type subject_type  as enum ('player', 'team', 'game');
create type market_kind   as enum ('player_stat', 'team_stat', 'game_winner', 'spread', 'total');
create type pick_side     as enum ('yes', 'no');
create type pick_status   as enum ('open', 'won', 'lost', 'void');
create type game_status   as enum ('scheduled', 'in_progress', 'final', 'postponed', 'canceled');
create type wallet_kind   as enum ('main', 'contest');
create type ledger_type   as enum ('signup_grant', 'daily_grant', 'bonus_grant',
                                   'pick_stake', 'pick_payout', 'pick_refund', 'adjustment');
create type card_state    as enum ('open', 'out', 'locked', 'live', 'settled');

-- -----------------------------------------------------------------------------
-- "Today" for Storyline: the slate day rolls over at 03:00 America/New_York.
-- -----------------------------------------------------------------------------
-- The ONE definition of this rule. The worker and app ask the database rather
-- than re-implementing it, so the rule can't drift between languages.
-- Wall-clock arithmetic in America/New_York, so DST transitions are handled.
create or replace function storyline_day(ts timestamptz) returns date
language sql immutable as $$
  select ((ts at time zone 'America/New_York') - interval '3 hours')::date
$$;

create or replace function storyline_today() returns date
language sql stable as $$ select storyline_day(now()) $$;

-- =============================================================================
-- REFERENCE DATA (written by the worker only)
-- =============================================================================

create table teams (
  id          smallserial primary key,
  league      league not null,
  name        text not null,                 -- "Milwaukee Bucks"
  kalshi_abbr text not null,                 -- "MIL", "NYK", "GSW"
  espn_abbr   text not null,                 -- "MIL", "NY",  "GS"
  espn_id     text not null,
  unique (league, kalshi_abbr),
  unique (league, espn_abbr),
  unique (league, espn_id)
);

-- One row per player = the Kalshi <-> ESPN match, made once and reused.
create table players (
  id                uuid primary key default gen_random_uuid(),
  league            league not null,
  full_name         text not null,
  team_id           smallint references teams(id),
  espn_athlete_id   text,                    -- null until matched
  kalshi_player_id  text,                    -- Kalshi custom_strike player id
  headshot_url      text,
  injury_status     text,                    -- ESPN designation ('Out', 'Doubtful', ...)
  updated_at        timestamptz not null default now(),
  unique (league, espn_athlete_id),
  unique (league, kalshi_player_id)
);

create table games (
  id               uuid primary key default gen_random_uuid(),
  league           league not null,
  espn_event_id    text not null,
  kalshi_game_key  text not null,            -- e.g. '26NOV13MILORL'
  slate_date       date not null,            -- Storyline day (ET, 3am rollover)
  home_team_id     smallint not null references teams(id),
  away_team_id     smallint not null references teams(id),
  tip_off_at       timestamptz not null,     -- tip-off / kickoff (ESPN); moves if postponed
  status           game_status not null default 'scheduled',
  broadcasts       jsonb not null default '[]',  -- groundwork: "where to watch"
  updated_at       timestamptz not null default now(),
  unique (league, espn_event_id),
  unique (league, kalshi_game_key)
);
create index games_slate_idx on games (slate_date);

-- Every Kalshi market we care about: a card's line AND the rest of its ladder.
-- Prices live here so the app can subscribe per ticker via Supabase Realtime.
create table markets (
  ticker               text primary key,     -- 'KXNBAPTS-26NOV13MILORL-ORLABLACK0-25'
  league               league not null,
  game_id              uuid not null references games(id),
  kind                 market_kind not null,
  kalshi_series        text not null,        -- 'KXNBAPTS', 'KXNBAGAME', ...
  title                text not null,        -- Kalshi's title: 'Anthony Black: 25+ points'
  player_id            uuid references players(id),   -- player_stat
  team_id              smallint references teams(id), -- team_stat, game_winner, spread
  stat                 text,                 -- 'points', 'rebounds', 'passing_yards', ...
  strike               numeric(7,1),         -- 25 = "25+"; 6.5 spreads; null for winner
  yes_bid_cents        smallint check (yes_bid_cents between 0 and 100),
  yes_ask_cents        smallint check (yes_ask_cents between 0 and 100),
  no_bid_cents         smallint check (no_bid_cents  between 0 and 100),
  no_ask_cents         smallint check (no_ask_cents  between 0 and 100),
  volume               integer not null default 0,
  kalshi_status        text not null,        -- active / closed / finalized ...
  result               text check (result in ('yes', 'no', 'scalar')),
  prices_updated_at    timestamptz,          -- staleness check for picks
  updated_at           timestamptz not null default now(),
  check (kind <> 'player_stat' or (player_id is not null and stat is not null)),
  check (kind <> 'team_stat'   or (team_id   is not null and stat is not null))
);
create index markets_ladder_idx on markets (game_id, player_id, stat);

-- Price history, for line-movement storylines ("38% → 61% since the injury news")
-- and for checking whether curated markets are the ones that move.
create table market_price_snapshots (
  ticker         text not null references markets(ticker) on delete cascade,
  captured_at    timestamptz not null default now(),
  yes_bid_cents  smallint,
  yes_ask_cents  smallint,
  no_bid_cents   smallint,
  no_ask_cents   smallint,
  volume         integer,
  primary key (ticker, captured_at)
);

-- Snapshot every freshly observed market whose price changed since its last
-- snapshot, or whose last snapshot is older than p_min_interval. Called by ingest and the price poller.
-- Returns the number of snapshots written.
create or replace function snapshot_prices(p_min_interval interval default interval '15 minutes')
returns integer
language sql security definer set search_path = public as $$
  with latest as (
    select distinct on (ticker) ticker, captured_at, yes_bid_cents, yes_ask_cents, no_bid_cents, no_ask_cents
    from market_price_snapshots
    order by ticker, captured_at desc
  ), ins as (
    insert into market_price_snapshots (ticker, yes_bid_cents, yes_ask_cents, no_bid_cents, no_ask_cents, volume)
    select m.ticker, m.yes_bid_cents, m.yes_ask_cents, m.no_bid_cents, m.no_ask_cents, m.volume
    from markets m
    left join latest l on l.ticker = m.ticker
    where m.result is null
      and m.prices_updated_at is not null
      -- Only markets with a NEW observation since their last snapshot; markets nobody
      -- is polling anymore must not be re-snapshotted forever (review fix, PR #1).
      and (l.ticker is null or m.prices_updated_at > l.captured_at)
      and (l.ticker is null
           or l.captured_at < now() - p_min_interval
           or (l.yes_bid_cents, l.yes_ask_cents, l.no_bid_cents, l.no_ask_cents)
              is distinct from (m.yes_bid_cents, m.yes_ask_cents, m.no_bid_cents, m.no_ask_cents))
    returning 1
  )
  select count(*)::int from ins
$$;

-- =============================================================================
-- CURATION
-- =============================================================================

-- Every worker job run, with its inputs and outputs. For curation this is how
-- feedback on a blurb traces back to exactly what the model saw.
create table pipeline_runs (
  id           bigserial primary key,
  job          text not null,                -- 'curation' | 'news_drop' | 'price_poll' | 'settlement' | ...
  slate_date   date,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'ok', 'failed')),
  inputs       jsonb,
  outputs      jsonb,
  error        text
);

-- A card is a storyline about a player, a team, or a game, pinned to one market (its line).
create table cards (
  id               uuid primary key default gen_random_uuid(),  -- stable public id (share links)
  slate_date       date not null,
  sort_key         numeric not null,         -- deck order; news drops can slot in anywhere
  game_id          uuid not null references games(id),
  subject          subject_type not null,
  player_id        uuid references players(id),
  team_id          smallint references teams(id),
  market_ticker    text not null references markets(ticker),     -- the LOCKED line
  blurb            text not null check (char_length(blurb) <= 200),
  blurb_facts      jsonb,                    -- the facts the blurb cites
  -- The kind of "why" behind the card, set by curation. Lets us measure which
  -- storylines get read and picked. Plain text + check so the list can evolve.
  storyline_type   text not null default 'other' check (storyline_type in (
                     'hot_streak', 'cold_streak', 'revenge', 'milestone', 'injury_opportunity',
                     'matchup', 'rivalry', 'team_streak', 'clinch', 'news', 'other')),
  is_out           boolean not null default false,  -- set by worker from ESPN / Kalshi pause
  locks_at         timestamptz,              -- null = game start. Set for in-game cards later.
  curation_run_id  bigint references pipeline_runs(id),
  published_at     timestamptz not null default now(),
  check (subject <> 'player' or player_id is not null),
  check (subject <> 'team'   or (team_id is not null and player_id is null)),
  check (subject <> 'game'   or (team_id is null     and player_id is null))
);
create index cards_slate_idx on cards (slate_date, sort_key);
-- One card per player per game, one per team per game (any number of game cards).
create unique index cards_one_per_player on cards (game_id, player_id) where subject = 'player';
create unique index cards_one_per_team   on cards (game_id, team_id)   where subject = 'team';

-- =============================================================================
-- USERS, WALLETS, PICKS, MONEY
-- =============================================================================

create table profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 2 and 20),
  referrer_id   uuid references profiles(user_id),   -- groundwork: referrals
  created_at    timestamptz not null default now()
);
create unique index profiles_display_name_uniq on profiles (lower(display_name));

-- A bankroll. Every user has exactly one 'main' wallet; contests get their own later.
create table wallets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(user_id) on delete cascade,
  kind        wallet_kind not null default 'main',
  contest_id  uuid,                          -- FK added when the contests table exists
  created_at  timestamptz not null default now(),
  check ((kind = 'main') = (contest_id is null))
);
create unique index wallets_one_main on wallets (user_id) where kind = 'main';
create unique index wallets_one_per_contest on wallets (user_id, contest_id) where kind = 'contest';

-- Bonus "free trade" credits (e.g. a free $20 pick). Granted by admin/promo,
-- spent by one pick. A credit-funded pick takes no cash stake and, if it wins,
-- pays WINNINGS ONLY (not the stake). A void reissues the credit. See settle_market.
create table pick_credits (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references wallets(id),
  amount_cents  integer not null check (amount_cents > 0),
  reason        text not null,               -- 'referral', 'promo', 'apology', ...
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table picks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles(user_id),  -- denormalized for RLS + queries
  wallet_id      uuid not null references wallets(id),
  card_id        uuid not null references cards(id),
  market_ticker  text not null references markets(ticker),   -- may differ from card's line once lines are adjustable
  side           pick_side not null,
  price_cents    smallint not null check (price_cents between 1 and 99),  -- ask at pick time
  stake_cents    integer not null check (stake_cents > 0),
  contracts      numeric(12,4) not null,     -- stake / price; needed for future cash-out
  credit_id      uuid unique references pick_credits(id),     -- set if funded by a free credit
  status         pick_status not null default 'open',
  payout_cents   integer,
  created_at     timestamptz not null default now(),
  settled_at     timestamptz,
  unique (wallet_id, card_id)                -- one line per player (per card) per wallet
);
create index picks_user_idx on picks (user_id, created_at desc);
create index picks_open_market_idx on picks (market_ticker) where status = 'open';

-- Append-only. Wallet balance = sum(amount_cents). Never updated, never deleted.
create table ledger_entries (
  id            bigserial primary key,
  user_id       uuid not null references profiles(user_id),  -- denormalized for RLS
  wallet_id     uuid not null references wallets(id),
  type          ledger_type not null,
  amount_cents  integer not null,
  pick_id       uuid references picks(id),
  grant_date    date,                        -- for daily_grant (v1.1)
  memo          text,
  created_at    timestamptz not null default now(),
  check (type not in ('pick_stake', 'pick_payout', 'pick_refund') or pick_id is not null),
  check (type <> 'daily_grant' or grant_date is not null),
  check (type <> 'pick_stake' or amount_cents < 0)
);
create index ledger_wallet_idx on ledger_entries (wallet_id);

-- Idempotency guarantees, enforced by the database itself:
create unique index ledger_one_signup    on ledger_entries (user_id)             where type = 'signup_grant';
create unique index ledger_one_daily     on ledger_entries (user_id, grant_date) where type = 'daily_grant';
create unique index ledger_one_per_pick  on ledger_entries (pick_id, type)
  where type in ('pick_stake', 'pick_payout', 'pick_refund');  -- settlement can't pay twice

create view wallet_balances
with (security_invoker = true) as
  select w.id as wallet_id, w.user_id, w.kind,
         coalesce(sum(l.amount_cents), 0)::integer as balance_cents
  from wallets w
  left join ledger_entries l on l.wallet_id = w.id
  group by w.id;

-- Analytics, no third-party provider.
create table events (
  id          bigserial primary key,
  user_id     uuid references profiles(user_id),
  event       text not null,
  card_id     uuid references cards(id),
  props       jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index events_created_idx on events (created_at);
create index events_event_idx   on events (event, created_at);

-- =============================================================================
-- CARD STATE: derived, never stored (so it can't go stale)
-- =============================================================================
create view card_feed
with (security_invoker = true) as
select
  c.*,
  coalesce(c.locks_at, g.tip_off_at) as lock_at,
  g.tip_off_at,
  g.status as game_status,
  m.kind as market_kind, m.title as market_title, m.stat, m.strike,
  m.yes_ask_cents, m.no_ask_cents, m.prices_updated_at, m.result,
  case
    when m.result is not null                                      then 'settled'::card_state
    when now() >= coalesce(c.locks_at, g.tip_off_at)
         and g.status = 'in_progress'                              then 'live'::card_state   -- v1 UI: "Locked"
    when now() >= coalesce(c.locks_at, g.tip_off_at)               then 'locked'::card_state
    when c.is_out                                                  then 'out'::card_state
    else 'open'::card_state
  end as state
from cards c
join games   g on g.id = c.game_id
join markets m on m.ticker = c.market_ticker;

-- =============================================================================
-- FUNCTIONS: the only way users change data
-- =============================================================================

-- First visit: profile + main wallet + $100 signup grant, all or nothing.
create or replace function create_profile(p_display_name text, p_referrer uuid default null)
returns profiles
language plpgsql security definer set search_path = public as $$
declare
  v_profile profiles;
  v_wallet  uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  insert into profiles (user_id, display_name, referrer_id)
  values (auth.uid(), trim(p_display_name), p_referrer)
  returning * into v_profile;

  insert into wallets (user_id, kind) values (auth.uid(), 'main') returning id into v_wallet;

  insert into ledger_entries (user_id, wallet_id, type, amount_cents, memo)
  values (auth.uid(), v_wallet, 'signup_grant', 10000, 'Welcome bankroll');

  return v_profile;
exception
  when unique_violation then
    raise exception 'display_name_taken_or_profile_exists';
end $$;

-- Place a pick. Every rule is checked here, inside one transaction.
-- Optional params keep the signature stable as features arrive:
--   p_max_price_cents  v1.1 "price moved" check (v1 clients omit)
--   p_wallet_id        contests (null = the user's main wallet)
-- v1 stake is fixed at $5; user-chosen stakes and credit-funded picks come later.
create or replace function place_pick(
  p_card_id         uuid,
  p_side            pick_side,
  p_max_price_cents smallint default null,
  p_wallet_id       uuid default null
)
returns picks
language plpgsql security definer set search_path = public as $$
declare
  c_stake   constant integer := 500;
  v_uid     uuid := auth.uid();
  v_wallet  uuid;
  v_card    record;
  v_price   smallint;
  v_balance integer;
  v_pick    picks;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  -- Resolve + lock the wallet: serializes concurrent picks from the same wallet,
  -- so two fast taps can't both pass the balance check.
  select id into v_wallet from wallets
  where user_id = v_uid
    and (case when p_wallet_id is null then kind = 'main' else id = p_wallet_id end)
  for update;
  if not found then raise exception 'no_wallet'; end if;

  select * into v_card from card_feed where id = p_card_id;
  if not found                          then raise exception 'card_not_found'; end if;
  if v_card.slate_date <> storyline_today() then raise exception 'card_not_today'; end if;
  if v_card.state <> 'open'             then raise exception 'card_not_open:%', v_card.state; end if;
  if v_card.prices_updated_at is null
     or v_card.prices_updated_at < now() - interval '2 minutes'
                                        then raise exception 'prices_stale'; end if;

  v_price := case p_side when 'yes' then v_card.yes_ask_cents else v_card.no_ask_cents end;
  if v_price is null or v_price not between 1 and 99 then raise exception 'no_price'; end if;
  if p_max_price_cents is not null and v_price > p_max_price_cents then
    raise exception 'price_moved:%', v_price;
  end if;

  select coalesce(sum(amount_cents), 0) into v_balance
  from ledger_entries where wallet_id = v_wallet;
  if v_balance < c_stake then raise exception 'insufficient_funds'; end if;

  insert into picks (user_id, wallet_id, card_id, market_ticker, side,
                     price_cents, stake_cents, contracts)
  values (v_uid, v_wallet, p_card_id, v_card.market_ticker, p_side,
          v_price, c_stake, round(c_stake::numeric / v_price, 4))
  returning * into v_pick;

  insert into ledger_entries (user_id, wallet_id, type, amount_cents, pick_id)
  values (v_uid, v_wallet, 'pick_stake', -c_stake, v_pick.id);

  return v_pick;
exception
  when unique_violation then raise exception 'already_picked';
end $$;

-- Settle every open pick on a market. Called by the worker after it writes the
-- Kalshi result. Safe to call any number of times.
create or replace function settle_market(p_ticker text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_result text;
  v_pick   picks;
  v_payout integer;
  v_status pick_status;
  v_count  integer := 0;
begin
  select result into v_result from markets where ticker = p_ticker;
  if v_result is null then return 0; end if;

  for v_pick in
    select * from picks where market_ticker = p_ticker and status = 'open' for update
  loop
    -- Free-trade picks (funded by a pick credit; no cash stake was taken):
    --   won  -> pays WINNINGS ONLY (gross payout minus the stake), as cash
    --   lost -> nothing
    --   void -> the free trade comes back as a NEW credit (same amount), never as cash
    if v_pick.credit_id is not null then
      if v_result = 'scalar' then
        v_status := 'void';  v_payout := 0;
        insert into pick_credits (wallet_id, amount_cents, reason)
        select v_pick.wallet_id, v_pick.stake_cents, 'reissued: voided free trade ' || v_pick.id
        where not exists (select 1 from pick_credits
                          where reason = 'reissued: voided free trade ' || v_pick.id);
      elsif v_result = v_pick.side::text then
        v_status := 'won';
        v_payout := round(v_pick.stake_cents * 100.0 / v_pick.price_cents)::integer - v_pick.stake_cents;
        insert into ledger_entries (user_id, wallet_id, type, amount_cents, pick_id, memo)
        values (v_pick.user_id, v_pick.wallet_id, 'pick_payout', v_payout, v_pick.id, 'Free trade winnings')
        on conflict do nothing;
      else
        v_status := 'lost';  v_payout := 0;
      end if;

      update picks set status = v_status, payout_cents = v_payout, settled_at = now()
      where id = v_pick.id;
      v_count := v_count + 1;
      continue;
    end if;

    if v_result = 'scalar' then
      v_status := 'void';  v_payout := v_pick.stake_cents;
      insert into ledger_entries (user_id, wallet_id, type, amount_cents, pick_id, memo)
      values (v_pick.user_id, v_pick.wallet_id, 'pick_refund', v_payout, v_pick.id, 'Market voided')
      on conflict do nothing;
    elsif v_result = v_pick.side::text then
      v_status := 'won';
      -- $1 per contract, rounded to the cent: 500 / 43 * 100 = 1163 cents.
      v_payout := round(v_pick.stake_cents * 100.0 / v_pick.price_cents)::integer;
      insert into ledger_entries (user_id, wallet_id, type, amount_cents, pick_id)
      values (v_pick.user_id, v_pick.wallet_id, 'pick_payout', v_payout, v_pick.id)
      on conflict do nothing;
    else
      v_status := 'lost';  v_payout := 0;
    end if;

    update picks set status = v_status, payout_cents = v_payout, settled_at = now()
    where id = v_pick.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;


-- =============================================================================
-- PRIVILEGE LOCKDOWN
-- Supabase grants ALL on every table, function and sequence in public to anon and
-- authenticated by default. RLS alone would then be the only barrier, and an
-- UPDATE/DELETE blocked by RLS "succeeds" silently on zero rows. So: revoke
-- everything, then grant back exactly what the app needs. Defense in depth.
-- =============================================================================
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- The app's entire write surface: two functions. Signed-out visitors get nothing.
grant execute on function place_pick(uuid, pick_side, smallint, uuid) to authenticated;
grant execute on function create_profile(text, uuid)                  to authenticated;
grant execute on function storyline_today()                           to authenticated;
grant execute on function storyline_day(timestamptz)                  to authenticated;  -- storyline_today() calls it
grant execute on function settle_market(text)                          to service_role;
grant execute on function snapshot_prices(interval)                    to service_role;

-- =============================================================================
-- ROW LEVEL SECURITY
-- Default deny. The worker uses the service role, which bypasses RLS.
-- =============================================================================
alter table teams          enable row level security;
alter table players        enable row level security;
alter table games          enable row level security;
alter table markets        enable row level security;
alter table market_price_snapshots enable row level security;
alter table pipeline_runs  enable row level security;   -- no policies: internal only
alter table cards          enable row level security;
alter table profiles       enable row level security;
alter table wallets        enable row level security;
alter table pick_credits   enable row level security;
alter table picks          enable row level security;
alter table ledger_entries enable row level security;
alter table events         enable row level security;

create policy read_teams   on teams   for select to authenticated using (true);
create policy read_players on players for select to authenticated using (true);
create policy read_games   on games   for select to authenticated using (true);
create policy read_markets on markets for select to authenticated using (true);
create policy read_snapshots on market_price_snapshots for select to authenticated using (true);
create policy read_cards   on cards   for select to authenticated using (true);

-- Display names are public (leaderboard, follows). Only your own is editable.
create policy read_profiles   on profiles for select to authenticated using (true);
create policy update_own_name on profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Your wallets, credits, picks, money: read your own only. Writes only via functions.
-- (Follows will add: friends can read your picks, including before lock.)
create policy read_own_wallets on wallets        for select to authenticated using (user_id = auth.uid());
create policy read_own_credits on pick_credits   for select to authenticated
  using (wallet_id in (select id from wallets where user_id = auth.uid()));
create policy read_own_picks   on picks          for select to authenticated using (user_id = auth.uid());
create policy read_own_ledger  on ledger_entries for select to authenticated using (user_id = auth.uid());

create policy insert_own_events on events for insert to authenticated with check (user_id = auth.uid());

grant select on teams, players, games, markets, market_price_snapshots, cards, profiles, wallets,
                pick_credits, picks, ledger_entries to authenticated;
grant select on card_feed, wallet_balances to authenticated;
grant update (display_name) on profiles to authenticated;
grant insert on events to authenticated;
grant usage on sequence events_id_seq to authenticated;

-- =============================================================================
-- REALTIME: push price changes to open cards (each card subscribes to its ticker)
-- =============================================================================
alter publication supabase_realtime add table markets;
