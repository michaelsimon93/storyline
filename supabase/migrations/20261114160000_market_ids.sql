-- STO-38 / ADR-021: markets get Storyline's own IDs.
-- Before: markets.ticker (Kalshi's market ticker) was the primary key, and cards, picks and
-- price history all pointed at it; markets.kalshi_series held Kalshi's series code.
-- After: markets.id (uuid) is the key everything references. Provider IDs live in
-- external_ids, one row per (source, kind, external ID). A second market source adds rows
-- there, never columns here. kalshi_series is dropped: it's the first part of Kalshi's
-- ticker, and the market's own kind and stat already say what it measures.
--
-- Function bodies below are the current definitions (pg_get_functiondef) with only the key
-- changed, so nothing else in them moves.

-- ---------------------------------------------------------------- cross-reference table
create table external_ids (
  source       text not null check (source ~ '^[a-z][a-z0-9_]*$'),   -- 'kalshi', 'espn', ...
  kind         text not null check (kind in ('market')),              -- STO-39 adds team/player/game
  external_id  text not null,
  market_id    uuid,
  created_at   timestamptz not null default now(),
  primary key (source, kind, external_id),
  -- Exactly the column for its kind is set.
  check ((kind = 'market') = (market_id is not null))
);
-- One ID per market per source: a Kalshi market has exactly one ticker.
create unique index external_ids_one_per_market on external_ids (source, market_id) where kind = 'market';
alter table external_ids enable row level security;   -- no policies: internal (worker) only
revoke all on external_ids from anon, authenticated;

-- ---------------------------------------------------------------- markets get their own id
alter table markets add column id uuid not null default gen_random_uuid();
alter table markets add constraint markets_id_key unique (id);

insert into external_ids (source, kind, external_id, market_id)
select 'kalshi', 'market', ticker, id from markets;

-- Point everything at the new id (pre-deploy: test data only, but keep it correct).
alter table cards                  add column market_id uuid;
alter table picks                  add column market_id uuid;
alter table market_price_snapshots add column market_id uuid;
update cards c                  set market_id = m.id from markets m where m.ticker = c.market_ticker;
update picks p                  set market_id = m.id from markets m where m.ticker = p.market_ticker;
update market_price_snapshots s set market_id = m.id from markets m where m.ticker = s.ticker;
alter table cards                  alter column market_id set not null;
alter table picks                  alter column market_id set not null;
alter table market_price_snapshots alter column market_id set not null;

-- Views select through the old key; drop them before the columns go, recreate below.
drop view card_feed;
drop view user_affinities;

alter table market_price_snapshots drop constraint market_price_snapshots_pkey;
alter table market_price_snapshots drop column ticker;
alter table cards drop column market_ticker;
drop index picks_open_market_idx;
alter table picks drop column market_ticker;

alter table markets drop constraint markets_pkey;
alter table markets drop constraint markets_id_key;
alter table markets add primary key (id);
alter table markets drop column ticker;
alter table markets drop column kalshi_series;

alter table external_ids           add foreign key (market_id) references markets(id) on delete cascade;
alter table market_price_snapshots add primary key (market_id, captured_at);
alter table market_price_snapshots add foreign key (market_id) references markets(id) on delete cascade;
alter table picks add foreign key (market_id) references markets(id);
create index picks_open_market_idx on picks (market_id) where status = 'open';
alter table cards add foreign key (market_id) references markets(id);
create index cards_market_idx on cards (market_id);

-- ---------------------------------------------------------------- views (same definitions, new key)
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
    -- Pre-game cards follow the game: ESPN's status beats the scheduled tip-off time.
    when c.locks_at is null and g.status = 'in_progress'           then 'live'::card_state
    when g.status in ('final', 'canceled')                        then 'locked'::card_state  -- every card, in-game too
    when now() >= coalesce(c.locks_at, g.tip_off_at)
         and g.status = 'in_progress'                              then 'live'::card_state   -- v1 UI: "Locked"
    when now() >= coalesce(c.locks_at, g.tip_off_at)               then 'locked'::card_state
    when c.is_out or m.status <> 'open'                            then 'out'::card_state
    else 'open'::card_state
  end as state
from cards c
join games   g on g.id = c.game_id
join markets m on m.id = c.market_id;

create view user_affinities as
WITH seen AS (
         SELECT DISTINCT events.user_id,
            events.card_id
           FROM events
          WHERE events.event = 'card_view'::text AND events.user_id IS NOT NULL AND events.card_id IS NOT NULL
        ), picked AS (
         SELECT picks.user_id,
            picks.card_id,
            bool_or(picks.status = 'won'::pick_status) AS won
           FROM picks
          GROUP BY picks.user_id, picks.card_id
        ), user_cards AS (
         SELECT COALESCE(s.user_id, p.user_id) AS user_id,
            COALESCE(s.card_id, p.card_id) AS card_id,
            p.card_id IS NOT NULL AS picked,
            COALESCE(p.won, false) AS won
           FROM seen s
             FULL JOIN picked p ON p.user_id = s.user_id AND p.card_id = s.card_id
        )
 SELECT uc.user_id,
    d.dimension,
    d.value,
    count(*)::integer AS cards_viewed,
    count(*) FILTER (WHERE uc.picked)::integer AS picks,
    count(*) FILTER (WHERE uc.won)::integer AS wins,
    round(count(*) FILTER (WHERE uc.picked)::numeric / count(*)::numeric, 3) AS pick_rate
   FROM user_cards uc
     JOIN cards c ON c.id = uc.card_id
     JOIN markets m ON m.id = c.market_id
     CROSS JOIN LATERAL ( VALUES ('team'::text,c.team_id::text), ('player'::text,c.player_id::text), ('stat'::text,m.stat), ('market_kind'::text,m.kind::text), ('subject'::text,c.subject::text), ('storyline_type'::text,c.storyline_type)) d(dimension, value)
  WHERE d.value IS NOT NULL
  GROUP BY uc.user_id, d.dimension, d.value;

revoke all on card_feed, user_affinities from anon, authenticated;
grant select on card_feed to authenticated;                  -- user_affinities stays worker-only

-- ---------------------------------------------------------------- functions (same bodies, new key)
CREATE OR REPLACE FUNCTION public.place_pick(p_card_id uuid, p_side pick_side, p_max_price_cents smallint DEFAULT NULL::smallint, p_wallet_id uuid DEFAULT NULL::uuid)
 RETURNS picks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c_stake   constant integer := config_int('pick_stake_cents');  -- ADR-018
  v_uid     uuid := auth.uid();
  v_wallet  uuid;
  v_card    record;
  v_price   smallint;
  v_balance integer;
  v_pick    picks;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  -- Share-lock the card's market BEFORE reading its state. Any write to that market row
  -- (the worker recording the result, a price update) waits until this pick commits, so
  -- settlement can never miss an in-flight pick; and if a result is being written right
  -- now, we wait for it and then see the market as settled. (0002, test-adversary finding)
  perform 1 from markets m join cards c on c.market_id = m.id
  where c.id = p_card_id for share of m;

  -- Lock order is ALWAYS market, then wallet (ADR-020). Settlement holds market rows and
  -- then touches wallets (ledger entries reference them), so the reverse order deadlocks.
  -- FOR NO KEY UPDATE still serializes two picks from one wallet (no double spend), but
  -- does not block the key-share locks that ledger inserts take on the wallet row.
  select id into v_wallet from wallets
  where user_id = v_uid
    and (case when p_wallet_id is null then kind = 'main' else id = p_wallet_id end)
  for no key update;
  if not found then raise exception 'no_wallet'; end if;

  select * into v_card from card_feed where id = p_card_id;
  if not found                          then raise exception 'card_not_found'; end if;
  if v_card.slate_date <> storyline_today() then raise exception 'card_not_today'; end if;
  if v_card.state <> 'open'             then raise exception 'card_not_open:%', v_card.state; end if;
  if v_card.prices_updated_at is null
     or v_card.prices_updated_at < now() - make_interval(secs => config_int('max_price_age_seconds'))
                                        then raise exception 'prices_stale'; end if;

  v_price := case p_side when 'yes' then v_card.yes_ask_cents else v_card.no_ask_cents end;
  if v_price is null or v_price not between 1 and 99 then raise exception 'no_price'; end if;
  if p_max_price_cents is not null and v_price > p_max_price_cents then
    raise exception 'price_moved:%', v_price;
  end if;

  select coalesce(sum(amount_cents), 0) into v_balance
  from ledger_entries where wallet_id = v_wallet;
  if v_balance < c_stake then raise exception 'insufficient_funds'; end if;

  insert into picks (user_id, wallet_id, card_id, market_id, side,
                     price_cents, stake_cents, contracts)
  values (v_uid, v_wallet, p_card_id, v_card.market_id, p_side,
          v_price, c_stake, round(c_stake::numeric / v_price, 4))
  returning * into v_pick;

  insert into ledger_entries (user_id, wallet_id, type, amount_cents, pick_id)
  values (v_uid, v_wallet, 'pick_stake', -c_stake, v_pick.id);

  return v_pick;
exception
  when unique_violation then raise exception 'already_picked';
end $function$;

CREATE OR REPLACE FUNCTION public.snapshot_prices(p_min_interval interval DEFAULT NULL::interval)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with latest as (
    select distinct on (market_id) market_id, captured_at, yes_bid_cents, yes_ask_cents, no_bid_cents, no_ask_cents
    from market_price_snapshots
    order by market_id, captured_at desc
  ), ins as (
    insert into market_price_snapshots (market_id, yes_bid_cents, yes_ask_cents, no_bid_cents, no_ask_cents, volume)
    select m.id, m.yes_bid_cents, m.yes_ask_cents, m.no_bid_cents, m.no_ask_cents, m.volume
    from markets m
    left join latest l on l.market_id = m.id
    where m.result is null
      and m.prices_updated_at is not null
      -- Only markets with a NEW observation since their last snapshot; markets nobody
      -- is polling anymore must not be re-snapshotted forever (review fix, PR #1).
      and (l.market_id is null or m.prices_updated_at > l.captured_at)
      and (l.market_id is null
           or l.captured_at < now() - coalesce(p_min_interval,
                                                make_interval(mins => config_int('snapshot_interval_minutes')))
           or (l.yes_bid_cents, l.yes_ask_cents, l.no_bid_cents, l.no_ask_cents)
              is distinct from (m.yes_bid_cents, m.yes_ask_cents, m.no_bid_cents, m.no_ask_cents))
    returning 1
  )
  select count(*)::int from ins
$function$;

drop function settle_market(text);
CREATE FUNCTION public.settle_market(p_market_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result text;
  v_pick   picks;
  v_payout integer;
  v_status pick_status;
  v_count  integer := 0;
begin
  select result into v_result from markets where id = p_market_id;
  if v_result is null then return 0; end if;

  for v_pick in
    select * from picks where market_id = p_market_id and status = 'open' for update
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
end $function$;
revoke all on function settle_market(uuid) from public, anon, authenticated;
grant execute on function settle_market(uuid) to service_role;
