-- 0002: pick safety (test-adversary findings, PR A)
--   1. A card stops taking picks when ESPN says its game has started or finished, not only
--      when the clock passes the scheduled tip-off (early starts, stale schedules). Cards with
--      their own lock time (future in-game cards) are unaffected.
--   2. A card is "out" while Kalshi isn't trading its market (kalshi_status <> 'active').
--   3. place_pick share-locks the market so a pick and settlement can't interleave.

create or replace view card_feed
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
    when c.locks_at is null and g.status in ('final', 'canceled')  then 'locked'::card_state
    when now() >= coalesce(c.locks_at, g.tip_off_at)
         and g.status = 'in_progress'                              then 'live'::card_state   -- v1 UI: "Locked"
    when now() >= coalesce(c.locks_at, g.tip_off_at)               then 'locked'::card_state
    when c.is_out or m.kalshi_status <> 'active'                   then 'out'::card_state
    else 'open'::card_state
  end as state
from cards c
join games   g on g.id = c.game_id
join markets m on m.ticker = c.market_ticker;

create or replace function place_pick(
  p_card_id         uuid,
  p_side            pick_side,
  p_max_price_cents smallint default null,
  p_wallet_id       uuid default null
)
returns picks
language plpgsql security definer set search_path = public as $$
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

  -- Resolve + lock the wallet: serializes concurrent picks from the same wallet,
  -- so two fast taps can't both pass the balance check.
  select id into v_wallet from wallets
  where user_id = v_uid
    and (case when p_wallet_id is null then kind = 'main' else id = p_wallet_id end)
  for update;
  if not found then raise exception 'no_wallet'; end if;

  -- Share-lock the card's market BEFORE reading its state. Any write to that market row
  -- (the worker recording the result, a price update) waits until this pick commits, so
  -- settlement can never miss an in-flight pick; and if a result is being written right
  -- now, we wait for it and then see the market as settled. (0002, test-adversary finding)
  perform 1 from markets m join cards c on c.market_ticker = m.ticker
  where c.id = p_card_id for share of m;

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
