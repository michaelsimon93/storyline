// Ingest: load a slate's games (ESPN), its prop + game-winner markets (Kalshi),
// and match every Kalshi player to an ESPN athlete. Safe to re-run: every write
// is an upsert, so a second run refreshes rather than duplicates. Provider IDs are
// rows in external_ids; core tables hold only our own IDs (ADR-021).

import type { Db } from "../lib/db.js";
import { dbNow, withRun } from "../lib/db.js";
import * as espn from "../sources/espn.js";
import * as kalshi from "../sources/kalshi.js";
import type { MarketSource } from "../sources/types.js";
import { abbrFromEspn, kalshiFromEspn } from "../domain/nbaTeams.js";
import { matchPlayer, normalizeName } from "../domain/names.js";
import {
  GAME_WINNER_SERIES, PLAYER_PROP_SERIES, gameKey, kalshiDateCode, parseMarket, splitTicker,
  type ParsedMarket,
} from "../domain/kalshiParse.js";

/** The only league ingest loads today. Every provider ID is scoped to a league (external_ids). */
export const LEAGUE = "nba";

export interface IngestSummary {
  slateDate: string;
  games: number;
  markets: Record<string, number>;
  players: {
    total: number; exact: number; fuzzy: number; unmatched: string[]; ambiguous: string[];
    /** Players whose Kalshi id changed (or who are listed under two ids), as readable notes. */
    reissued: string[];
  };
  outOrDoubtful: string[];
  /** Malformed Kalshi markets left out of this run, as "ticker: reason". */
  skipped: string[];
  /** Games left out of this run (ESPN listed one matchup under two events), as readable notes. */
  skippedGames: string[];
  snapshots: number;
}

/**
 * The Storyline day, from the database's storyline_today() (3am ET rollover).
 * Deliberately not re-implemented here: one definition, no drift (ADR-013 follow-up).
 */
export async function resolveSlateDate(db: Db, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const { rows } = await db.query<{ d: string }>(`select storyline_today()::text as d`);
  return rows[0]!.d;
}

export async function ingest(
  db: Db, date?: string, marketSource: MarketSource<kalshi.KalshiMarket> = kalshi.kalshiSource,
): Promise<IngestSummary> {
  const slateDate = await resolveSlateDate(db, date);
  return withRun(db, "ingest", slateDate, async () => {
    const dateCode = kalshiDateCode(slateDate);

    // ---------------------------------------------------------------- games (ESPN)
    const games = await espn.getGames(slateDate);
    const summary: IngestSummary = {
      slateDate, games: games.length, markets: {},
      players: { total: 0, exact: 0, fuzzy: 0, unmatched: [], ambiguous: [], reissued: [] },
      outOrDoubtful: [], skipped: [], skippedGames: [], snapshots: 0,
    };
    if (games.length === 0) return summary;

    // ---------------------------------------------------------------- teams
    // Core tables hold only our IDs; provider IDs are rows in external_ids (ADR-021). A team is
    // found by its ESPN ID, or by its Kalshi abbreviation if that ID was lost. A new one is
    // created in the same statement as its ESPN ID, ID first, so a team never exists without the
    // ID that finds it, and a run that loses a race to another writes nothing.
    const teamsIn = [...new Map(games.flatMap((g) => [g.home, g.away]).map((t) => [t.espnId, t])).values()]
      .map((t) => ({ name: t.name, abbr: abbrFromEspn(t.abbr), espn: t.espnId, kalshi: kalshiFromEspn(t.abbr) }));
    const teamsJson = JSON.stringify(teamsIn);
    await db.query(
      `with i as (select * from jsonb_to_recordset($1) as t(name text, abbr text, espn text, kalshi text)),
       fresh as (
         select nextval(pg_get_serial_sequence('teams', 'id'))::smallint as id, i.* from i
          where not exists (select 1 from external_ids x
                             where x.kind = 'team' and x.league = $3
                               and ((x.source = $2 and x.external_id = i.espn) or (x.source = $4 and x.external_id = i.kalshi)))),
       ids as (
         insert into external_ids (source, kind, league, external_id, team_id)
         select $2, 'team', $3::league, espn, id from fresh
         on conflict do nothing
         returning team_id)
       insert into teams (id, league, name, abbr) select f.id, $3::league, f.name, f.abbr from fresh f join ids on ids.team_id = f.id`,
      [teamsJson, espn.SOURCE, LEAGUE, kalshi.SOURCE],
    );
    // A known team whose ESPN ID went missing gets it back, found by its Kalshi abbreviation.
    await db.query(
      `insert into external_ids (source, kind, league, external_id, team_id)
       select $2, 'team', $4::league, t.espn, k.team_id from jsonb_to_recordset($1) as t(espn text, kalshi text)
         join external_ids k on k.source = $3 and k.kind = 'team' and k.league = $4 and k.external_id = t.kalshi
       on conflict do nothing`,
      [teamsJson, espn.SOURCE, kalshi.SOURCE, LEAGUE],
    );
    // Refresh names and our short codes, and attach each team's Kalshi abbreviation (all from the
    // team map).
    await db.query(
      `with i as (
         select x.team_id, t.name, t.abbr, t.kalshi from jsonb_to_recordset($1) as t(name text, abbr text, espn text, kalshi text)
         join external_ids x on x.source = $2 and x.kind = 'team' and x.league = $4 and x.external_id = t.espn),
       renamed as (update teams set name = i.name, abbr = i.abbr from i
                    where teams.id = i.team_id and (teams.name, teams.abbr) is distinct from (i.name, i.abbr))
       insert into external_ids (source, kind, league, external_id, team_id)
       select $3, 'team', $4::league, kalshi, team_id from i
       on conflict (team_id, source) where kind = 'team' do update set external_id = excluded.external_id
         where external_ids.external_id <> excluded.external_id`,
      [teamsJson, espn.SOURCE, kalshi.SOURCE, LEAGUE],
    );
    const teamIds = await db.query<{ source: string; external_id: string; team_id: number }>(
      `select source, external_id, team_id from external_ids where kind = 'team' and league = $1`, [LEAGUE]);
    const teamIdsFrom = (source: string) =>
      new Map(teamIds.rows.filter((r) => r.source === source).map((r) => [r.external_id, r.team_id]));
    const teamIdByKalshi = teamIdsFrom(kalshi.SOURCE);
    const teamIdByEspn = teamIdsFrom(espn.SOURCE);

    // ---------------------------------------------------------------- games
    const listed = games.map((g) => ({
      label: `${abbrFromEspn(g.away.abbr)} @ ${abbrFromEspn(g.home.abbr)}`,
      espn: g.eventId,
      key: gameKey(dateCode, kalshiFromEspn(g.away.abbr), kalshiFromEspn(g.home.abbr)),
      home: teamIdByEspn.get(g.home.espnId), away: teamIdByEspn.get(g.away.espnId),
      tip: g.startsAt, status: g.status, broadcasts: g.broadcasts,
    }));
    const matchup = (r: { home: unknown; away: unknown }) => `${r.home}@${r.away}`;
    // A game is one matchup per slate. If ESPN lists one matchup under two events we can't tell
    // which is real, so that game is left out tonight and reported; the rest of the slate loads.
    // Its Kalshi markets then match no game and are ignored, like another night's.
    const eventsOf = new Map<string, string[]>();
    for (const r of listed) eventsOf.set(matchup(r), [...(eventsOf.get(matchup(r)) ?? []), r.espn]);
    const gameRows = listed.filter((r) => eventsOf.get(matchup(r))!.length === 1);
    const leftOut = listed.filter((r) => eventsOf.get(matchup(r))!.length > 1 && eventsOf.get(matchup(r))![0] === r.espn);
    // A left-out game that was already loaded keeps its row, markets and cards, but ingest stops
    // updating it, so its start time and status freeze. Say so, so the feed flags it for a look.
    const loaded = new Set((await db.query<{ home: number; away: number }>(
      `select home_team_id as home, away_team_id as away from games g
         join jsonb_to_recordset($1) as r(home smallint, away smallint) on (g.home_team_id, g.away_team_id) = (r.home, r.away)
        where g.league = $3 and g.slate_date = $2::date`,
      [JSON.stringify(leftOut), slateDate, LEAGUE])).rows.map(matchup));
    for (const r of leftOut) {
      const events = eventsOf.get(matchup(r))!;
      summary.skippedGames.push(`${r.label}: ESPN lists it under ${events.length} events (${events.join(", ")}); left out` +
        (loaded.has(matchup(r)) ? " (already loaded tonight: its start time and status are no longer updated)" : ""));
    }
    summary.games = gameRows.length;
    // A game is identified by what it is: league, slate, home and away team (games_identity),
    // like a market. A postponed game replayed on another night is therefore a new game. The
    // original stays on its night with its markets, cards and picks: Kalshi voids those markets
    // and settlement refunds the picks (ADR-004).
    const gamesJson = JSON.stringify(gameRows);
    // One ESPN event is one game per slate (STO-32). If ESPN corrects a game's home and away
    // teams, the game we have for that event tonight takes the corrected matchup, keeping its
    // markets and cards, instead of a second game being created.
    await db.query(
      `update games g set home_team_id = r.home, away_team_id = r.away, updated_at = now()
         from jsonb_to_recordset($1) as r(espn text, home smallint, away smallint)
         join external_ids x on x.source = $3 and x.kind = 'game' and x.league = $4 and x.external_id = r.espn
        where g.id = x.game_id and g.slate_date = $2::date
          and (g.home_team_id, g.away_team_id) <> (r.home, r.away)
          and not exists (select 1 from games o where o.league = $4 and o.slate_date = $2::date
                                                  and o.home_team_id = r.home and o.away_team_id = r.away)`,
      [gamesJson, slateDate, espn.SOURCE, LEAGUE],
    );
    const upserted = await db.query<{ id: string; home: number; away: number }>(
      `insert into games (league, slate_date, home_team_id, away_team_id, tip_off_at, status, broadcasts, updated_at)
       select $3::league, $2::date, g.home, g.away, g.tip, g.status::game_status, g.broadcasts, now()
       from jsonb_to_recordset($1) as g(home smallint, away smallint, tip timestamptz, status text, broadcasts jsonb)
       on conflict (league, slate_date, home_team_id, away_team_id) do update
         set tip_off_at = excluded.tip_off_at, status = excluded.status,
             broadcasts = excluded.broadcasts, updated_at = now()
       returning id, home_team_id as home, away_team_id as away`,
      [gamesJson, slateDate, LEAGUE],
    );
    const gameIdByMatchup = new Map(upserted.rows.map((r) => [matchup(r), r.id]));
    // Attach ESPN's event ID and Kalshi's game key. ESPN may reuse one event ID for the replay
    // of a postponed game, so an event ID can point at one game per slate.
    await db.query(
      `with i as (select * from jsonb_to_recordset($1) as r(id uuid, espn text, key text))
       insert into external_ids (source, kind, league, external_id, game_id)
       select $2, 'game', $4::league, espn, id from i
       union all
       select $3, 'game', $4::league, key, id from i
       on conflict (game_id, source) where kind = 'game' do update set external_id = excluded.external_id
         where external_ids.external_id <> excluded.external_id`,
      [JSON.stringify(gameRows.map((r) => ({ id: gameIdByMatchup.get(matchup(r)), espn: r.espn, key: r.key }))),
       espn.SOURCE, kalshi.SOURCE, LEAGUE],
    );
    // If ESPN reused the event ID, we can tell which earlier game this replaces, and mark it
    // postponed. With a new event ID the original keeps its last status.
    await db.query(
      `update games g set status = 'postponed', updated_at = now()
         from external_ids x
        where x.source = $3 and x.kind = 'game' and x.league = $4 and x.external_id = any($1)
          and g.id = x.game_id and g.slate_date < $2::date
          and g.status not in ('postponed', 'final', 'canceled')`,
      [gameRows.map((r) => r.espn), slateDate, espn.SOURCE, LEAGUE],
    );
    const gameIdByKey = new Map(gameRows.map((r) => [r.key, gameIdByMatchup.get(matchup(r))!]));

    // ---------------------------------------------------------------- markets (Kalshi)
    const seriesList = [...Object.keys(PLAYER_PROP_SERIES), GAME_WINNER_SERIES];
    const tonight: (ParsedMarket & { series: string })[] = [];
    const seenTonight: Record<string, number> = {};   // per series, before any skip
    const skip = (ticker: string | undefined, reason: unknown) =>
      summary.skipped.push(`${ticker ?? "(no ticker)"}: ${reason instanceof Error ? reason.message : String(reason)}`);
    // When we read Kalshi, on the database's clock (the clock the staleness checks use).
    // Market rows are only updated if this is newer than what they hold, so a price poll that
    // lands while ingest is busy with ESPN isn't overwritten (STO-9).
    const kalshiFetchedAt = await dbNow(db);
    for (const series of seriesList) {
      seenTonight[series] = 0;
      summary.markets[series] = 0;
      for (const m of await marketSource.listOpen(series)) {
        // One malformed market is skipped and reported in the run output; it must not cost
        // the rest of the slate (STO-32).
        try {
          if (!gameIdByKey.has(splitTicker(String(m.ticker ?? "")).gameKey)) continue;   // another night
          seenTonight[series]!++;
          const parsed = parseMarket(m, series);
          if (!teamIdByKalshi.has(parsed.team)) throw new Error(`unknown team ${parsed.team}`);
          tonight.push({ ...parsed, series });
          summary.markets[series]!++;
        } catch (e) {
          skip(m.ticker, e);
        }
      }
    }

    // ---------------------------------------------------------------- players (match Kalshi → ESPN)
    const rosters = new Map<string, espn.EspnRosterPlayer[]>(); // keyed by Kalshi team abbr
    for (const g of games) {
      for (const t of [g.home, g.away]) {
        rosters.set(kalshiFromEspn(t.abbr), await espn.getRoster(t.espnId));
      }
    }

    interface PlayerRow {
      kalshi_id: string; name: string; team_id: number | undefined;
      espn_id: string | null; injury: string | null; headshot: string | null;
    }
    // Each Kalshi player on tonight's markets, matched against his team's ESPN roster.
    const claims = new Map<string, { name: string; team: string; match: ReturnType<typeof matchPlayer> }>();
    for (const m of tonight) {
      if (!m.player || claims.has(m.player.kalshiId)) continue;
      claims.set(m.player.kalshiId, { name: m.player.name, team: m.team, match: matchPlayer(m.player.name, rosters.get(m.team) ?? []) });
    }
    const athleteOf = (c: { match: ReturnType<typeof matchPlayer> }) =>
      c.match.kind === "exact" || c.match.kind === "fuzzy" ? (c.match.player as espn.EspnRosterPlayer) : null;

    // Who we already have: the ESPN athlete is the stable identity, Kalshi's id can change.
    const stored = await db.query<{ id: string; full_name: string; espn_athlete_id: string | null; kalshi_player_id: string | null }>(
      `select p.id, p.full_name, e.external_id as espn_athlete_id, k.external_id as kalshi_player_id
         from players p
         left join external_ids e on e.player_id = p.id and e.source = $3 and e.kind = 'player'
         left join external_ids k on k.player_id = p.id and k.source = $4 and k.kind = 'player'
        where p.league = $5 and (e.external_id = any($1) or k.external_id = any($2))`,
      [[...claims.values()].flatMap((c) => athleteOf(c)?.espnId ?? []), [...claims.keys()],
       espn.SOURCE, kalshi.SOURCE, LEAGUE],
    );
    const storedByEspn = new Map(stored.rows.filter((r) => r.espn_athlete_id).map((r) => [r.espn_athlete_id!, r]));
    const storedKalshiIds = new Set(stored.rows.map((r) => r.kalshi_player_id));
    const sameName = (a: string, b: string) => normalizeName(a) === normalizeName(b);

    const players = new Map<string, PlayerRow>();
    const aliasOf = new Map<string, string>();        // a second Kalshi id for a player in this run → his first
    const repoint: { player_id: string; kalshi_id: string }[] = [];
    const claimedBy = new Map<string, { kalshiId: string; name: string }>();   // ESPN athlete → Kalshi player
    for (const [kalshiId, c] of claims) {
      const { name, team } = c;
      const row: PlayerRow = { kalshi_id: kalshiId, name, team_id: teamIdByKalshi.get(team),
                               espn_id: null, injury: null, headshot: null };
      const p = athleteOf(c);
      // Why this Kalshi player can't take the ESPN athlete he matched (he then stays unmatched
      // and is reported, rather than merging two people or failing the run).
      let blocked: string | null = null;
      if (p) {
        const owner = claimedBy.get(p.espnId);
        const holder = storedByEspn.get(p.espnId);
        if (owner && sameName(owner.name, name)) {
          // Same name, same team, same athlete, two Kalshi ids in one run: Kalshi is part-way
          // through re-issuing his id. One player; both ids lead to the same row.
          aliasOf.set(kalshiId, owner.kalshiId);
          summary.players.reissued.push(`${name} (${team}): listed under ${owner.kalshiId} and ${kalshiId}`);
          continue;
        } else if (owner) {
          blocked = `ESPN athlete ${p.espnId} already matched to ${owner.name}`;
        } else if (holder && holder.kalshi_player_id !== kalshiId) {
          if (!sameName(holder.full_name, name)) {
            blocked = `ESPN athlete ${p.espnId} belongs to stored player ${holder.full_name}`;
          } else if (storedKalshiIds.has(kalshiId)) {
            blocked = `two stored rows for ESPN athlete ${p.espnId}; needs a manual merge`;
          } else {
            // Kalshi re-issued his id: the row we have takes the new id and keeps its markets.
            repoint.push({ player_id: holder.id, kalshi_id: kalshiId });
            summary.players.reissued.push(`${name} (${team}): ${holder.kalshi_player_id} -> ${kalshiId}`);
          }
        }
      }
      if (p && !blocked) {
        claimedBy.set(p.espnId, { kalshiId, name });
        summary.players[c.match.kind as "exact" | "fuzzy"]++;
        Object.assign(row, { espn_id: p.espnId, injury: p.injuryStatus, headshot: p.headshotUrl });
        if (p.injuryStatus === "Out" || p.injuryStatus === "Doubtful") {
          summary.outOrDoubtful.push(`${name} (${team}): ${p.injuryStatus}`);
        }
      } else if (blocked) {
        summary.players.ambiguous.push(`${name} (${team}): ${blocked}`);
      } else if (c.match.kind === "ambiguous") {
        summary.players.ambiguous.push(`${name} (${team})`);
      } else {
        summary.players.unmatched.push(`${name} (${team})`);
      }
      players.set(kalshiId, row);
    }
    summary.players.total = players.size;

    // A re-issued Kalshi ID moves to the player we have (a player has one Kalshi ID).
    await db.query(
      `insert into external_ids (source, kind, league, external_id, player_id)
       select $2, 'player', $3::league, r.kalshi_id, r.player_id from jsonb_to_recordset($1) as r(player_id uuid, kalshi_id text)
       on conflict (player_id, source) where kind = 'player' do update set external_id = excluded.external_id`,
      [JSON.stringify(repoint), kalshi.SOURCE, LEAGUE],
    );
    // Players are found by their Kalshi ID. A new one is created with that ID in one statement,
    // ID first (as for teams above).
    const playersJson = JSON.stringify([...players.values()]);
    const incomingPlayers = `jsonb_to_recordset($1) as i(name text, team_id smallint, espn_id text, kalshi_id text,
                                                         injury text, headshot text)`;
    await db.query(
      `with fresh as (
         select gen_random_uuid() as id, i.* from ${incomingPlayers}
          where not exists (select 1 from external_ids x
                             where x.source = $2 and x.kind = 'player' and x.league = $3 and x.external_id = i.kalshi_id)),
       ids as (
         insert into external_ids (source, kind, league, external_id, player_id)
         select $2, 'player', $3::league, kalshi_id, id from fresh
         on conflict do nothing
         returning player_id)
       insert into players (id, league, full_name, team_id) select f.id, $3::league, f.name, f.team_id from fresh f join ids on ids.player_id = f.id`,
      [playersJson, kalshi.SOURCE, LEAGUE],
    );
    await db.query(
      `update players p
          set full_name = i.name, team_id = i.team_id, injury_status = i.injury, headshot_url = i.headshot, updated_at = now()
         from ${incomingPlayers}
         join external_ids x on x.source = $2 and x.kind = 'player' and x.league = $3 and x.external_id = i.kalshi_id
        where p.id = x.player_id`,
      [playersJson, kalshi.SOURCE, LEAGUE],
    );
    // Attach the ESPN athlete a player matched. An unmatched player keeps the athlete he has (or
    // none: a refused match is reported, not stored).
    await db.query(
      `insert into external_ids (source, kind, league, external_id, player_id)
       select $3, 'player', $4::league, i.espn_id, x.player_id from ${incomingPlayers}
         join external_ids x on x.source = $2 and x.kind = 'player' and x.league = $4 and x.external_id = i.kalshi_id
        where i.espn_id is not null
       on conflict (player_id, source) where kind = 'player' do update set external_id = excluded.external_id
         where external_ids.external_id <> excluded.external_id`,
      [playersJson, kalshi.SOURCE, espn.SOURCE, LEAGUE],
    );
    const playerIds = await db.query<{ external_id: string; player_id: string }>(
      `select external_id, player_id from external_ids
        where source = $1 and kind = 'player' and league = $2 and external_id = any($3)`,
      [kalshi.SOURCE, LEAGUE, [...players.keys()]],
    );
    const playerIdByKalshi = new Map(playerIds.rows.map((r) => [r.external_id, r.player_id]));
    for (const [alias, first] of aliasOf) playerIdByKalshi.set(alias, playerIdByKalshi.get(first)!);

    // ---------------------------------------------------------------- write markets
    const marketRows = tonight.map((m) => ({
      ticker: m.ticker,
      game_id: gameIdByKey.get(m.gameKey),
      kind: m.kind,
      title: m.title,
      player_id: m.player ? playerIdByKalshi.get(m.player.kalshiId) : null,
      team_id: m.player ? null : teamIdByKalshi.get(m.team),
      stat: m.stat,
      strike: m.strike,
      ...m.quote,
    }));
    // Markets are keyed by our own id and identified by what they are (game, kind, player or
    // team, stat, line: markets_identity). Kalshi's ticker is attached in external_ids (ADR-021).
    // Every step is idempotent and safe if another run races it: conflicts are no-ops.
    const incoming = `incoming as (
         select * from jsonb_to_recordset($1) as m(ticker text, game_id uuid, kind text, title text,
           player_id uuid, team_id smallint, stat text, strike numeric, yes_bid smallint, yes_ask smallint,
           no_bid smallint, no_ask smallint, volume integer, status market_status))`;
    const rowsJson = JSON.stringify(marketRows);
    // 1. Create markets we've never seen. A ticker we already know keeps the market it is
    //    attached to, and a market that already exists (even if its Kalshi id was lost) is left
    //    alone, so a Kalshi market can never become two Storyline markets.
    await db.query(
      `with ${incoming}
       insert into markets (league, game_id, kind, title, player_id, team_id, stat, strike,
                            yes_bid_cents, yes_ask_cents, no_bid_cents, no_ask_cents, volume, status,
                            prices_updated_at, updated_at)
       select $4::league, game_id, kind::market_kind, title, player_id, team_id, stat, strike,
              yes_bid, yes_ask, no_bid, no_ask, volume, status, $2, now()
       from incoming i
       where not exists (select 1 from external_ids x
                         where x.source = $3 and x.kind = 'market' and x.league = $4 and x.external_id = i.ticker)
       on conflict (game_id, kind, player_id, team_id, stat, strike) do nothing`,
      [rowsJson, kalshiFetchedAt, kalshi.SOURCE, LEAGUE],
    );
    // 2. Attach a Kalshi ticker to each market that has none (new, or one whose id went
    //    missing). A market has one Kalshi ticker: if two are listed for it, one is attached.
    await db.query(
      `with ${incoming}
       insert into external_ids (source, kind, league, external_id, market_id)
       select distinct on (mk.id) $2, 'market', $3::league, i.ticker, mk.id
       from incoming i
       join markets mk on (mk.game_id, mk.kind, mk.player_id, mk.team_id, mk.stat, mk.strike)
                          is not distinct from (i.game_id, i.kind::market_kind, i.player_id, i.team_id, i.stat, i.strike)
       where not exists (select 1 from external_ids y
                         where y.source = $2 and y.kind = 'market' and y.market_id = mk.id)
       order by mk.id, i.ticker
       on conflict (source, kind, league, external_id) where kind <> 'game' do nothing`,
      [rowsJson, kalshi.SOURCE, LEAGUE],
    );
    //    A ticker left unattached is a second listing of a market that already has one (a
    //    duplicate, or Kalshi re-listed it under a new ticker). It's skipped and reported: the
    //    market keeps the ticker it has.
    const unattached = await db.query<{ ticker: string; other: string | null }>(
      `with ${incoming}
       select i.ticker,
              (select y.external_id from markets mk
                 join external_ids y on y.market_id = mk.id and y.source = $2 and y.kind = 'market'
                where (mk.game_id, mk.kind, mk.player_id, mk.team_id, mk.stat, mk.strike)
                      is not distinct from (i.game_id, i.kind::market_kind, i.player_id, i.team_id, i.stat, i.strike)) as other
         from incoming i
        where not exists (select 1 from external_ids x
                          where x.source = $2 and x.kind = 'market' and x.league = $3 and x.external_id = i.ticker)
        order by 1`,
      [rowsJson, kalshi.SOURCE, LEAGUE],
    );
    const seriesOf = new Map(tonight.map((m) => [m.ticker, m.series]));
    for (const u of unattached.rows) {
      skip(u.ticker, `same market as ${u.other ?? "another ticker"}`);
      summary.markets[seriesOf.get(u.ticker)!]!--;
    }
    // 3. Refresh prices and status of markets we know, in market-id order like the price poller
    //    (ADR-020 rule 3); newer data always wins (rule 4). Results are settlement's (ADR-004).
    await db.query(
      `with ${incoming},
       known as (
         select x.market_id, m.* from incoming m
         join external_ids x on x.source = $3 and x.kind = 'market' and x.league = $4 and x.external_id = m.ticker
       ), locked as (
         select mk.id from markets mk join known k on k.market_id = mk.id order by mk.id for no key update of mk
       )
       update markets mk
          set yes_bid_cents = k.yes_bid, yes_ask_cents = k.yes_ask,
              no_bid_cents = k.no_bid,   no_ask_cents = k.no_ask,
              volume = k.volume, status = k.status,
              prices_updated_at = $2, updated_at = now()
         from known k join locked l on l.id = k.market_id
        where mk.id = k.market_id
          -- Never replace newer data (e.g. a poll that ran while ingest was fetching rosters).
          and (mk.prices_updated_at is null or mk.prices_updated_at < $2)`,
      [rowsJson, kalshiFetchedAt, kalshi.SOURCE, LEAGUE],
    );

    // Price history: snapshot anything that moved (rule lives in snapshot_prices()).
    const snap = await db.query<{ n: number }>(`select snapshot_prices() as n`);
    summary.snapshots = snap.rows[0]!.n;

    // An unknown Kalshi status was stored as paused (cards out). Fail loudly after writing:
    // with every market paused there'd be no deck, so the poller would never notice (ADR-021).
    const unknown = marketRows.filter((r) => r.unknown !== undefined)
      .map((r) => `${r.ticker} ("${r.unknown}")`).sort();
    const problems: string[] = [];
    if (unknown.length) {
      problems.push(`unknown Kalshi status for ${unknown.length} market(s), treated as paused: ${unknown.join(", ")}`);
    }
    // Skipping one bad market is fine. A whole series skipped means Kalshi changed its format
    // and there may be no deck tonight: also fail loudly, after writing what did load.
    const lost = seriesList.filter((x) => seenTonight[x]! > 0 && summary.markets[x] === 0);
    if (lost.length) {
      problems.push(`every ${lost.join(", ")} market for tonight was skipped (${summary.skipped.length} skipped in all), e.g. ${summary.skipped[0]}`);
    }
    if (problems.length) throw new Error(problems.join("; "));
    return summary;
  });
}
