// Ingest: load a slate's games (ESPN), its prop + game-winner markets (Kalshi),
// and match every Kalshi player to an ESPN athlete. Safe to re-run: every write
// is an upsert, so a second run refreshes rather than duplicates.

import type { Db } from "../lib/db.js";
import { withRun } from "../lib/db.js";
import * as espn from "../sources/espn.js";
import * as kalshi from "../sources/kalshi.js";
import { kalshiFromEspn } from "../domain/nbaTeams.js";
import { matchPlayer } from "../domain/names.js";
import {
  GAME_WINNER_SERIES, PLAYER_PROP_SERIES, dollarsToCents, gameKey, kalshiDateCode,
  playerNameFromTitle, playerTeamFromTicker, splitTicker, strikeFromMarket,
} from "../domain/kalshiParse.js";

export interface IngestSummary {
  slateDate: string;
  games: number;
  markets: Record<string, number>;
  players: { total: number; exact: number; fuzzy: number; unmatched: string[]; ambiguous: string[] };
  outOrDoubtful: string[];
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
      players: { total: 0, exact: 0, fuzzy: 0, unmatched: [], ambiguous: [] },
      outOrDoubtful: [], snapshots: 0,
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
       on conflict (league, espn_event_id) do update
         set tip_off_at = excluded.tip_off_at, status = excluded.status,
             broadcasts = excluded.broadcasts, updated_at = now()
       returning id, kalshi_game_key`,
      [JSON.stringify(gameRows), slateDate],
    );
    const gameIdByKey = new Map(insertedGames.rows.map((r) => [r.kalshi_game_key, r.id]));

    // ---------------------------------------------------------------- markets (Kalshi)
    const seriesList = [...Object.keys(PLAYER_PROP_SERIES), GAME_WINNER_SERIES];
    const marketsBySeries = new Map<string, kalshi.KalshiMarket[]>();
    for (const series of seriesList) {
      const all = await kalshi.listMarkets(series);
      const tonight = all.filter((m) => gameIdByKey.has(splitTicker(m.ticker).gameKey));
      marketsBySeries.set(series, tonight);
      summary.markets[series] = tonight.length;
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
    const players = new Map<string, PlayerRow>();
    for (const series of Object.keys(PLAYER_PROP_SERIES)) {
      for (const m of marketsBySeries.get(series) ?? []) {
        const kalshiId = m.custom_strike?.basketball_player;
        if (!kalshiId || players.has(kalshiId)) continue;
        const name = playerNameFromTitle(m.title);
        const team = playerTeamFromTicker(m.ticker);
        const match = matchPlayer(name, rosters.get(team) ?? []);

        const row: PlayerRow = { kalshi_id: kalshiId, name, team_id: teamIdByKalshi.get(team),
                                 espn_id: null, injury: null, headshot: null };
        if (match.kind === "exact" || match.kind === "fuzzy") {
          summary.players[match.kind]++;
          const p = match.player as espn.EspnRosterPlayer;
          Object.assign(row, { espn_id: p.espnId, injury: p.injuryStatus, headshot: p.headshotUrl });
          if (p.injuryStatus === "Out" || p.injuryStatus === "Doubtful") {
            summary.outOrDoubtful.push(`${name} (${team}): ${p.injuryStatus}`);
          }
        } else if (match.kind === "ambiguous") {
          summary.players.ambiguous.push(`${name} (${team})`);
        } else {
          summary.players.unmatched.push(`${name} (${team})`);
        }
        players.set(kalshiId, row);
      }
    }
    summary.players.total = players.size;

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

    // ---------------------------------------------------------------- write markets
    const marketRows = [];
    for (const [series, list] of marketsBySeries) {
      for (const m of list) {
        const { gameKey: key, rest } = splitTicker(m.ticker);
        const isWinner = series === GAME_WINNER_SERIES;
        marketRows.push({
          ticker: m.ticker,
          game_id: gameIdByKey.get(key),
          kind: isWinner ? "game_winner" : "player_stat",
          series,
          title: m.title,
          player_id: isWinner ? null : playerIdByKalshi.get(m.custom_strike?.basketball_player ?? ""),
          team_id: isWinner ? teamIdByKalshi.get(rest[0] ?? "") : null,
          stat: isWinner ? null : PLAYER_PROP_SERIES[series],
          strike: isWinner ? null : strikeFromMarket(m),
          yes_bid: dollarsToCents(m.yes_bid_dollars), yes_ask: dollarsToCents(m.yes_ask_dollars),
          no_bid: dollarsToCents(m.no_bid_dollars),   no_ask: dollarsToCents(m.no_ask_dollars),
          volume: Math.round(Number(m.volume_fp ?? 0)),
          status: m.status,
          result: m.result === "" ? null : m.result,
        });
      }
    }
    await db.query(
      `insert into markets (ticker, league, game_id, kind, kalshi_series, title, player_id, team_id, stat, strike,
                            yes_bid_cents, yes_ask_cents, no_bid_cents, no_ask_cents, volume, kalshi_status,
                            result, prices_updated_at, updated_at)
       select m.ticker, 'nba', m.game_id, m.kind::market_kind, m.series, m.title, m.player_id, m.team_id, m.stat, m.strike,
              m.yes_bid, m.yes_ask, m.no_bid, m.no_ask, m.volume, m.status, m.result, now(), now()
       from jsonb_to_recordset($1) as m(ticker text, game_id uuid, kind text, series text, title text, player_id uuid,
            team_id smallint, stat text, strike numeric, yes_bid smallint, yes_ask smallint, no_bid smallint,
            no_ask smallint, volume integer, status text, result text)
       on conflict (ticker) do update
         set yes_bid_cents = excluded.yes_bid_cents, yes_ask_cents = excluded.yes_ask_cents,
             no_bid_cents = excluded.no_bid_cents,   no_ask_cents = excluded.no_ask_cents,
             volume = excluded.volume, kalshi_status = excluded.kalshi_status, result = excluded.result,
             prices_updated_at = now(), updated_at = now()`,
      [JSON.stringify(marketRows)],
    );

    // Price history: snapshot anything that moved (rule lives in snapshot_prices()).
    const snap = await db.query<{ n: number }>(`select snapshot_prices() as n`);
    summary.snapshots = snap.rows[0]!.n;

    return summary;
  });
}
