-- STO-32: a postponed game replayed on another night is a new game.
-- Before: one ESPN event could be one game row, ever (unique on league + espn_event_id), so a
-- replay could only be stored by moving the original row, which would carry its markets, cards
-- and picks to the new night.
-- After: one game row per ESPN event per slate. The original stays on its night (marked
-- postponed) with its markets and picks, which Kalshi voids and settlement refunds (ADR-004).
-- The replay is a separate game with its own markets, whether ESPN reuses the event ID or
-- issues a new one.
alter table games drop constraint games_league_espn_event_id_key;
alter table games add constraint games_league_espn_event_slate_key unique (league, espn_event_id, slate_date);
