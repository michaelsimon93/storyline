-- QA attacks on STO-109 (PR #43, delta 17a8e1b): the composite market foreign key and the game-consistency trigger on
-- story_shortlist. Every path that could store a row that contradicts its game, market or player. A FAIL here is a finding.
\set QUIET on
\pset tuples_only on
\pset format unaligned
reset role;

-- e1: 29 (home) vs 30 (away), tonight+73. e2: 29 vs 28 on another night. Markets: b1's in e1, b1's in e2, b2's in e1,
-- and a game_winner market (no player) in e1.
insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at, status) values
  ('a99b0000-0000-0000-0000-0000000000e1', 'nba', storyline_today() + 73, 29, 30, now() + interval '1 day', 'scheduled'),
  ('a99b0000-0000-0000-0000-0000000000e2', 'nba', storyline_today() + 74, 29, 28, now() + interval '2 days', 'scheduled');
insert into players (id, league, full_name, team_id) values
  ('a99b0000-0000-0000-0000-0000000000b1', 'nba', 'QA109 One', 29),
  ('a99b0000-0000-0000-0000-0000000000b2', 'nba', 'QA109 Two', 30),
  ('a99b0000-0000-0000-0000-0000000000b3', 'nba', 'QA109 Three', 29);
insert into markets (id, league, game_id, kind, title, player_id, stat, strike, status) values
  ('a99b0000-0000-0000-0000-0000000000f1', 'nba', 'a99b0000-0000-0000-0000-0000000000e1', 'player_stat', 'QA109 One: 20+', 'a99b0000-0000-0000-0000-0000000000b1', 'points', 20, 'open'),
  ('a99b0000-0000-0000-0000-0000000000f2', 'nba', 'a99b0000-0000-0000-0000-0000000000e2', 'player_stat', 'QA109 One: 20+ (other night)', 'a99b0000-0000-0000-0000-0000000000b1', 'points', 20, 'open'),
  ('a99b0000-0000-0000-0000-0000000000f3', 'nba', 'a99b0000-0000-0000-0000-0000000000e1', 'player_stat', 'QA109 Two: 20+', 'a99b0000-0000-0000-0000-0000000000b2', 'points', 20, 'open');
insert into markets (id, league, game_id, kind, title, status) values
  ('a99b0000-0000-0000-0000-0000000000f9', 'nba', 'a99b0000-0000-0000-0000-0000000000e1', 'game_winner', 'QA109 winner', 'open');
insert into pipeline_runs (id, job, slate_date, status) values (991091, 'story', storyline_today() + 73, 'ok');

-- One valid row for b1 in e1, as the job writes it; each attack edits one value.
create function q109(pos int default 1, pid text default 'a99b0000-0000-0000-0000-0000000000b1',
                     gid text default 'a99b0000-0000-0000-0000-0000000000e1', mid text default 'a99b0000-0000-0000-0000-0000000000f1',
                     team text default '29', day text default 'storyline_today() + 73', lg text default 'nba')
returns text language sql as $$
  select format($q$insert into story_shortlist (run_id, slate_date, league, team_id, position, player_id, game_id, angle, stat, score, summary, market_id, slot_kind)
    values (991091, %s, %L, %s, %s, %L, %L, 'hot_streak', 'pts', 50, 'x', %L, 'quota')$q$, day, lg, team, pos, pid, gid, mid) $$;
create function ok109(q text) returns text language plpgsql as $$ begin execute q; return 'ok'; exception when others then return sqlerrm; end $$;

-- attack (missing game): `select into` would give an all-NULL row and `team_id not in (NULL, NULL)` is NULL, which would
-- let the row through; the trigger raises for a missing game explicitly (the foreign keys would also refuse it).
select t_err('sl109: a game that does not exist is rejected by the trigger itself, not left to the foreign keys',
  q109(gid => 'a99b0000-0000-0000-0000-0000000000ee'), '%does not exist%');
-- attack (wrong league): team and day match, league doesn't. Only the trigger can catch this.
select t_err('sl109: a league that is not the game''s is rejected', q109(lg => 'nfl'), '%league nfl is not the game''s%');
-- attack (player-less market): a game_winner market has player_id NULL; MATCH SIMPLE only skips the check when the
-- REFERENCING columns are null, and they're all NOT NULL, so this must be refused.
select t_err('sl109: a game_winner market (no player) is rejected', q109(mid => 'a99b0000-0000-0000-0000-0000000000f9'), '%story_shortlist_market_matches%');
-- attack (right player, wrong game): b1's market from another night, with tonight's game.
select t_err('sl109: the player''s own market from another game is rejected', q109(mid => 'a99b0000-0000-0000-0000-0000000000f2'), '%story_shortlist_market_matches%');
-- attack (row consistent with its market, wrong day): e2's market and game, but tonight's slate date.
select t_err('sl109: a row pointing at another night''s game is rejected on slate_date',
  q109(gid => 'a99b0000-0000-0000-0000-0000000000e2', mid => 'a99b0000-0000-0000-0000-0000000000f2'), '%is not the game''s%');
-- attack (null team): team_id is NOT NULL, so `null not in (...)` never gets the chance to pass silently.
select t_err('sl109: a NULL team is rejected', q109(team => 'null'), '%null value%');
-- coverage: the control row is accepted, and the opposing team (away) is accepted for a valid market.
select t_eq('sl109: the valid row is stored', ok109(q109()), 'ok');
select t_eq('sl109: the away team with its own player''s market is stored',
  ok109(q109(2, 'a99b0000-0000-0000-0000-0000000000b2', mid => 'a99b0000-0000-0000-0000-0000000000f3', team => '30')), 'ok');

-- UPDATE paths: every column the checks depend on, changed on a stored row.
select t_err('sl109 upd: switching market_id to another player''s market is rejected',
  $q$update story_shortlist set market_id = 'a99b0000-0000-0000-0000-0000000000f3' where run_id = 991091 and position = 1$q$, '%story_shortlist_market_matches%');
select t_err('sl109 upd: switching player_id away from the market''s player is rejected',
  $q$update story_shortlist set player_id = 'a99b0000-0000-0000-0000-0000000000b3' where run_id = 991091 and position = 1$q$, '%story_shortlist_market_matches%');
select t_err('sl109 upd: switching game_id alone is rejected (trigger catches the day before the FK runs)',
  $q$update story_shortlist set game_id = 'a99b0000-0000-0000-0000-0000000000e2' where run_id = 991091 and position = 1$q$, '%is not the game''s%');
select t_err('sl109 upd: switching game_id and market_id together to another night is rejected on slate_date',
  $q$update story_shortlist set game_id = 'a99b0000-0000-0000-0000-0000000000e2', market_id = 'a99b0000-0000-0000-0000-0000000000f2' where run_id = 991091 and position = 1$q$, '%is not the game''s%');
select t_err('sl109 upd: moving slate_date is rejected',
  $q$update story_shortlist set slate_date = slate_date + 1 where run_id = 991091 and position = 1$q$, '%is not the game''s%');
select t_err('sl109 upd: changing league is rejected',
  $q$update story_shortlist set league = 'nfl' where run_id = 991091 and position = 1$q$, '%is not the game''s%');
select t_eq('sl109 upd: an update that touches none of them (score) still works',
  ok109($q$update story_shortlist set score = 51 where run_id = 991091 and position = 1$q$), 'ok');

-- The referenced market changing under a stored row.
select t_err('sl109 mkt: deleting a shortlisted market is rejected',
  $q$delete from markets where id = 'a99b0000-0000-0000-0000-0000000000f1'$q$, '%story_shortlist_market_matches%');
select t_err('sl109 mkt: re-pointing a shortlisted market at another player is rejected',
  $q$update markets set player_id = 'a99b0000-0000-0000-0000-0000000000b3' where id = 'a99b0000-0000-0000-0000-0000000000f1'$q$, '%story_shortlist_market_matches%');
-- coverage (poller/ingest path): a price/status refresh on a shortlisted market is not a key update and still works.
select t_eq('sl109 mkt: a price and status refresh of a shortlisted market still works',
  ok109($q$update markets set yes_bid_cents = 40, yes_ask_cents = 42, status = 'paused', updated_at = now() where id = 'a99b0000-0000-0000-0000-0000000000f1'$q$), 'ok');
-- coverage: the new unique key on markets can't reject a market row (id is already unique), even a player-less one.
select t_eq('sl109 mkt: a second player-less market in the same game is still allowed',
  ok109($q$insert into markets (id, league, game_id, kind, title, team_id, status) values ('a99b0000-0000-0000-0000-0000000000fa', 'nba', 'a99b0000-0000-0000-0000-0000000000e1', 'game_winner', 'QA109 winner 2', 29, 'open')$q$), 'ok');

-- Not covered (qa finding F1, low): a game's teams corrected after the row is stored (ingest does this in place) aren't
-- re-checked. STO-113 tracks it and will add the test back.

-- The trigger function: not security definer (it needs no extra rights), not callable by app roles or PUBLIC.
select t_eq('sl109 fn: the trigger function is not security definer',
  (select prosecdef from pg_proc where proname = 'story_shortlist_matches_game'), false);
select t_eq('sl109 fn: PUBLIC cannot execute the trigger function',
  (select count(*)::int from information_schema.routine_privileges
    where routine_name = 'story_shortlist_matches_game' and grantee in ('PUBLIC', 'anon', 'authenticated')), 0);

delete from story_shortlist where run_id = 991091;
