-- Teams get Storyline's own short code ("MIL", "NYK", "GSW"), for display ("MIL @ ORL").
-- STO-39 moved the provider-named codes (Kalshi's and ESPN's abbreviations) to external_ids,
-- which users can't read, and left teams with no short code of their own. This one is ours:
-- the league's official abbreviation, set by ingest from the team map (nbaTeams.ts), and
-- independent of what any provider calls the team.
alter table teams add column abbr text;
-- Existing teams: Kalshi's code is the NBA's official one for every team.
update teams t set abbr = x.external_id
  from external_ids x where x.team_id = t.id and x.source = 'kalshi' and x.kind = 'team';
alter table teams alter column abbr set not null;
alter table teams add constraint teams_abbr_format check (abbr ~ '^[A-Z]{2,4}$');
alter table teams add constraint teams_league_abbr_key unique (league, abbr);
