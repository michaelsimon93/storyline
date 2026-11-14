-- STO-37 / ADR-021: market status in Storyline's own words, not Kalshi's.
-- Before: markets.kalshi_status held Kalshi's raw string, and card_feed compared it to 'active'.
-- After: markets.status is one of four fixed values. Each provider's adapter in the worker
-- maps its own vocabulary to these, so rules like "a card is out unless its market is open"
-- never depend on a provider's words.
--
--   open     trading
--   paused   not trading right now, but not closed (not yet open, or halted)
--   closed   no more trading; the result is not final (may still be disputed or amended)
--   settled  result final and paid out by the exchange

create type market_status as enum ('open', 'paused', 'closed', 'settled');

alter table markets add column status market_status;
-- Existing rows (pre-deploy test data only) carry Kalshi's words; same mapping as the adapter.
update markets set status = case kalshi_status
  when 'active'      then 'open'
  when 'initialized' then 'paused'
  when 'inactive'    then 'paused'
  when 'closed'      then 'closed'
  when 'determined'  then 'closed'
  when 'disputed'    then 'closed'
  when 'amended'     then 'closed'
  when 'finalized'   then 'settled'
  when 'settled'     then 'settled'
  else 'paused'
end::market_status;
alter table markets alter column status set not null;

-- Same view, same columns; only the "out" rule changes to our vocabulary.
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
    when g.status in ('final', 'canceled')                        then 'locked'::card_state  -- every card, in-game too
    when now() >= coalesce(c.locks_at, g.tip_off_at)
         and g.status = 'in_progress'                              then 'live'::card_state   -- v1 UI: "Locked"
    when now() >= coalesce(c.locks_at, g.tip_off_at)               then 'locked'::card_state
    when c.is_out or m.status <> 'open'                            then 'out'::card_state
    else 'open'::card_state
  end as state
from cards c
join games   g on g.id = c.game_id
join markets m on m.ticker = c.market_ticker;

alter table markets drop column kalshi_status;
