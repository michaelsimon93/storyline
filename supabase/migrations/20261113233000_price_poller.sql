-- STO-9: how often the price poller refreshes carded markets from Kalshi (ADR-018).
-- The spec promises displayed prices are at most 60 seconds old. A poll takes a second or two,
-- so the interval is capped at 50 seconds: nobody can configure the promise away.
insert into app_config (key, value, value_type, min_value, max_value, is_public, description) values
  ('poller_interval_seconds', '30', 'int', 10, 50, false,
   'Seconds between price polls of carded markets; capped at 50 so prices stay under a minute old');
