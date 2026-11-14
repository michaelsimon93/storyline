-- Provider IDs live in external_ids, never in core tables (ADR-021, STO-38).
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

insert into games (id, league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a5500000-0000-0000-0000-0000000000e1', 'nba', 'x55', 'X55', storyline_today(), 1, 2, now() + interval '1 day', 'scheduled');
insert into markets (id, league, game_id, kind, title, team_id, status) values
  (mid('X5-A'), 'nba', 'a5500000-0000-0000-0000-0000000000e1', 'game_winner', 'A wins', 1, 'open'),
  (mid('X5-B'), 'nba', 'a5500000-0000-0000-0000-0000000000e1', 'game_winner', 'B wins', 2, 'open');
insert into external_ids (source, kind, external_id, market_id) values
  ('kalshi', 'market', 'KXNBAGAME-X55-A', mid('X5-A'));

select t_eq('external ids: a market is found by its provider id',
  (select market_id from external_ids where source = 'kalshi' and kind = 'market' and external_id = 'KXNBAGAME-X55-A'),
  mid('X5-A'));
select t_err('external ids: two markets can''t claim the same provider id',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('kalshi', 'market', 'KXNBAGAME-X55-A', mid('X5-B'))$q$,
  '%external_ids_pkey%');
select t_err('external ids: a market can''t have two ids from one provider',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('kalshi', 'market', 'KXNBAGAME-X55-A2', mid('X5-A'))$q$,
  '%external_ids_one_per_market%');
insert into external_ids (source, kind, external_id, market_id) values
  ('otherx', 'market', 'KXNBAGAME-X55-A', mid('X5-B'));
select t_eq('external ids: another provider may use the same id string for its own market',
  (select market_id from external_ids where source = 'otherx' and external_id = 'KXNBAGAME-X55-A'), mid('X5-B'));
select t_err('external ids: a market row must point at a market',
  $q$insert into external_ids (source, kind, external_id) values ('kalshi', 'market', 'orphan')$q$,
  '%external_ids_check%');
select t_err('external ids: provider names are lowercase identifiers',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('Kalshi API', 'market', 'z', mid('X5-B'))$q$,
  '%external_ids_source_check%');
delete from markets where id = mid('X5-B');
select t_eq('external ids: deleting a market removes its provider ids',
  (select count(*)::int from external_ids where market_id = mid('X5-B')), 0);
select t_eq('markets: no provider-named columns remain',
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name in ('markets', 'cards', 'picks', 'market_price_snapshots')
     and column_name ~ '(kalshi|espn|ticker)'), 0);

set role authenticated;
select as_user('a4000000-0000-0000-0000-0000000000f1');
select t_err('external ids: users can''t read the provider cross-reference',
  $q$select * from external_ids$q$, 'permission denied%');
select t_err('external ids: users can''t write it',
  $q$insert into external_ids (source, kind, external_id, market_id) values ('kalshi', 'market', 'x', mid('X5-A'))$q$,
  'permission denied%');
reset role;
