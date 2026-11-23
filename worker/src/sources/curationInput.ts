// Turns shortlist entries into what the curator reads (STO-11): each entry's signals and its player's ladder, from the database.
//
// A shortlist entry (STO-76) carries signal IDs and one matched market, not the signal text or the ladder, and says the
// ranker may pick another strike on the same player and stat. So both are loaded here. Reading the shortlist itself
// (the story_shortlist table) is the job's concern, not this file's.
//
// ASSUMPTION to confirm against the matching code: a strike's "yes price" is `yes_ask_cents` (what buying Yes costs),
// and a ladder rung counts only if its market is open, has both a bid and an ask, and its spread is within
// `max_spread_cents`, the same filters matching applies. If matching prices the band differently, change LADDER_SQL.

import type { Db } from "../lib/db.js";
import type { StatKey } from "../domain/storyDetectors.js";
import type { CurationInput, CurationSignal, CurationStory, LadderStrike } from "../domain/curationRules.js";

/** The fields of a shortlist entry that curation reads. A `ShortlistEntry` has all of them. */
export interface CurationEntry {
  id: number;
  playerId: string;
  gameId: string;
  angle: string;
  stat: StatKey;
  summary: string;
  signalIds: number[];
}

/** Detector stat keys → markets.stat (kalshiParse.PLAYER_PROP_SERIES). `Record<StatKey, …>`: a new stat won't compile until mapped. */
export const MARKET_STAT: Record<StatKey, string> = { pts: "points", reb: "rebounds", ast: "assists", "3pm": "threes" };

const LADDER_SQL = `
  select id, strike, yes_ask_cents
  from markets
  where kind = 'player_stat' and player_id = $1 and game_id = $2 and stat = $3 and status = 'open'
    and yes_bid_cents is not null and yes_ask_cents is not null
    and yes_ask_cents - yes_bid_cents <= $4
  order by strike`;

export async function loadCurationInput(db: Db, slateDate: string, entries: CurationEntry[], maxSpreadCents: number): Promise<CurationInput> {
  const signalIds = [...new Set(entries.flatMap((e) => e.signalIds))];
  const sig = await db.query<{ id: string; source: string; kind: CurationSignal["kind"]; trust: CurationSignal["trust"]; summary: string }>(
    `select id, source, kind::text as kind, trust::text as trust, summary from signals where id = any($1::bigint[])`, [signalIds]);
  const signals = new Map(sig.rows.map((r) => [Number(r.id), { id: Number(r.id), source: r.source, kind: r.kind, trust: r.trust, summary: r.summary }]));

  const playerIds = [...new Set(entries.map((e) => e.playerId))];
  const pl = await db.query<{ id: string; full_name: string }>(`select id, full_name from players where id = any($1::uuid[])`, [playerIds]);
  const names = new Map(pl.rows.map((r) => [r.id, r.full_name]));

  const stories: CurationStory[] = [];
  for (const e of entries) {
    const name = names.get(e.playerId);
    if (name === undefined) throw new Error(`shortlist entry ${e.id}: no player ${e.playerId}`);
    const own = e.signalIds.map((id) => {
      const s = signals.get(id);
      if (!s) throw new Error(`shortlist entry ${e.id}: no signal ${id}`);
      return s;
    });
    const lad = await db.query<{ id: string; strike: string; yes_ask_cents: number }>(LADDER_SQL, [e.playerId, e.gameId, MARKET_STAT[e.stat], maxSpreadCents]);
    const ladder: LadderStrike[] = lad.rows.map((r) => ({ marketId: r.id, strike: Number(r.strike), yesPriceCents: r.yes_ask_cents }));
    stories.push({ storyId: String(e.id), playerId: e.playerId, playerName: name, gameId: e.gameId, stat: e.stat, angle: e.angle, summary: e.summary, signals: own, ladder });
  }
  return { slateDate, stories };
}
