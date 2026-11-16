// Ingest: load a slate's games (ESPN), its prop + game-winner markets (Kalshi),
// and match every Kalshi player to an ESPN athlete. Safe to re-run: every write
// is an upsert, so a second run refreshes rather than duplicates.

import type { Db } from "../lib/db.js";
import { dbNow, withRun } from "../lib/db.js";
import * as espn from "../sources/espn.js";
import * as kalshi from "../sources/kalshi.js";
import { kalshiFromEspn } from "../domain/nbaTeams.js";
import { matchPlayer, normalizeName } from "../domain/names.js";
import {
  GAME_WINNER_SERIES, PLAYER_PROP_SERIES, gameKey, kalshiDateCode, parseMarket, splitTicker,
  type ParsedMarket,
} from "../domain/kalshiParse.js";

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

export async function ingest(db: Db, date?: string): Promise<IngestSummary> {
  const slateDate = await resolveSlateDate(db, date);
  return withRun(db, "ingest", slateDate, async () => {
    const dateCode = kalshiDateCode(slateDate);

    // ---------------------------------------------------------------- games (ESPN)
    const games = await espn.getGames(slateDate);
    const summary: IngestSummary = {
      slateDate, games: games.length, markets: {},
      players: { total: 0, exact: 0, fuzzy: 0, unmatched: [], ambiguous: [], reissued: [] },
      outOrDoubtful: [], skipped: [], snapshots: 0,
    };
    if (games.length === 0) return summary;

    const teams = games.flatMap((g) => [g.home, g.away]);
    await db.query(
      `insert into teams (league, name, kalshi_abbr, espn_abbr, espn_id)
       select 'nba', t.name, t.kalshi, t.espn, t.id from jsonb_to_recordset($1)
         as t(name text, kalshi text, espn text, id text)
       on conflict (league, espn_id) do update
         set name = excluded.name, kalshi_abbr = excluded.kalshi_abbr, espn_abbr = excluded.espn_abbr`,
      [JSON.stringify(teams.map((t) => ({ name: t.name, kalshi: kalshiFromEspn(t.abbr), espn: t.abbr, id: t.espnId })))],
    );
    const teamRows = await db.query<{ id: number; kalshi_abbr: string; espn_id: string }>(
      `select id, kalshi_abbr, espn_id from teams where league = 'nba'`,
    );
    const teamIdByKalshi = new Map(teamRows.rows.map((r) => [r.kalshi_abbr, r.id]));
    const teamIdByEspn = new Map(teamRows.rows.map((r) => [r.espn_id, r.id]));

    const gameRows = games.map((g) => ({
      espn_event_id: g.eventId,
      key: gameKey(dateCode, kalshiFromEspn(g.away.abbr), kalshiFromEspn(g.home.abbr)),
      home: teamIdByEspn.get(g.home.espnId), away: teamIdByEspn.get(g.away.espnId),
      tip: g.startsAt, status: g.status, broadcasts: g.broadcasts,
    }));
    const insertedGames = await db.query<{ id: string; kalshi_game_key: string }>(
      `insert into games (league, espn_event_id, kalshi_game_key, slate_date, home_team_id, away_team_id,
                          tip_off_at, status, broadcasts, updated_at)
       select 'nba', g.espn_event_id, g.key, $2::date, g.home, g.away, g.tip, g.status::game_status, g.broadcasts, now()
       from jsonb_to_recordset($1) as g(espn_event_id text, key text, home smallint, away smallint,
                                        tip timestamptz, status text, broadcasts jsonb)
       on conflict (league, espn_event_id, slate_date) do update
         set tip_off_at = excluded.tip_off_at, status = excluded.status,
             broadcasts = excluded.broadcasts, updated_at = now()
       returning id, kalshi_game_key`,
      [JSON.stringify(gameRows), slateDate],
    );
    // A postponed game replayed on another night is a new game (one row per ESPN event per
    // slate). The original stays on its night with its markets, cards and picks: Kalshi voids
    // those markets and settlement refunds the picks (ADR-004). If ESPN reused the event ID,
    // we can tell which earlier game this replaces, and mark it postponed.
    await db.query(
      `update games set status = 'postponed', updated_at = now()
        where league = 'nba' and espn_event_id = any($1) and slate_date < $2::date
          and status not in ('postponed', 'final', 'canceled')`,
      [games.map((g) => g.eventId), slateDate],
    );
    const gameIdByKey = new Map(insertedGames.rows.map((r) => [r.kalshi_game_key, r.id]));

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
      for (const m of await kalshi.listMarkets(series)) {
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
      `select id, full_name, espn_athlete_id, kalshi_player_id from players
        where league = 'nba' and (espn_athlete_id = any($1) or kalshi_player_id = any($2))`,
      [[...claims.values()].flatMap((c) => athleteOf(c)?.espnId ?? []), [...claims.keys()]],
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

    await db.query(
      `update players p set kalshi_player_id = r.kalshi_id, updated_at = now()
         from jsonb_to_recordset($1) as r(player_id uuid, kalshi_id text)
        where p.id = r.player_id`,
      [JSON.stringify(repoint)],
    );
    const playerRows = await db.query<{ id: string; kalshi_player_id: string }>(
      `insert into players (league, full_name, team_id, espn_athlete_id, kalshi_player_id, injury_status, headshot_url, updated_at)
       select 'nba', p.name, p.team_id, p.espn_id, p.kalshi_id, p.injury, p.headshot, now()
       from jsonb_to_recordset($1) as p(name text, team_id smallint, espn_id text, kalshi_id text, injury text, headshot text)
       on conflict (league, kalshi_player_id) do update
         set full_name = excluded.full_name, team_id = excluded.team_id,
             espn_athlete_id = coalesce(excluded.espn_athlete_id, players.espn_athlete_id),
             injury_status = excluded.injury_status, headshot_url = excluded.headshot_url, updated_at = now()
       returning id, kalshi_player_id`,
      [JSON.stringify([...players.values()])],
    );
    const playerIdByKalshi = new Map(playerRows.rows.map((r) => [r.kalshi_player_id, r.id]));
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
       select 'nba', game_id, kind::market_kind, title, player_id, team_id, stat, strike,
              yes_bid, yes_ask, no_bid, no_ask, volume, status, $2, now()
       from incoming i
       where not exists (select 1 from external_ids x
                         where x.source = $3 and x.kind = 'market' and x.external_id = i.ticker)
       on conflict (game_id, kind, player_id, team_id, stat, strike) do nothing`,
      [rowsJson, kalshiFetchedAt, kalshi.SOURCE],
    );
    // 2. Attach a Kalshi ticker to each market that has none (new, or one whose id went
    //    missing). A market has one Kalshi ticker: if two are listed for it, one is attached.
    await db.query(
      `with ${incoming}
       insert into external_ids (source, kind, external_id, market_id)
       select distinct on (mk.id) $2, 'market', i.ticker, mk.id
       from incoming i
       join markets mk on (mk.game_id, mk.kind, mk.player_id, mk.team_id, mk.stat, mk.strike)
                          is not distinct from (i.game_id, i.kind::market_kind, i.player_id, i.team_id, i.stat, i.strike)
       where not exists (select 1 from external_ids y
                         where y.source = $2 and y.kind = 'market' and y.market_id = mk.id)
       order by mk.id, i.ticker
       on conflict (source, kind, external_id) do nothing`,
      [rowsJson, kalshi.SOURCE],
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
                          where x.source = $2 and x.kind = 'market' and x.external_id = i.ticker)
        order by 1`,
      [rowsJson, kalshi.SOURCE],
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
         join external_ids x on x.source = $3 and x.kind = 'market' and x.external_id = m.ticker
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
      [rowsJson, kalshiFetchedAt, kalshi.SOURCE],
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
