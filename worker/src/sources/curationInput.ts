// Turns shortlist entries into what the curator reads (STO-11): each entry's signals and its player's ladder, from the database.
//
// A shortlist entry (STO-76) carries signal IDs and one matched market, not the signal text or the ladder, and says the
// ranker may pick another strike on the same player and stat. So both are loaded here. Reading the shortlist itself
// (the story_shortlist table) is the job's concern, not this file's.
//
// Confirmed with the story step's author (Nov 23): a strike's "yes price" is `yes_ask_cents` (what buying Yes costs),
// and a ladder rung counts only if its market is open, has both a bid and an ask, and its spread is within
// `max_spread_cents`, the same filters matching applies. The ladder on the market table is unfiltered, so the band is applied here
// (by narrowToBand) and not in SQL.

import type { Db } from "../lib/db.js";
import type { StatKey } from "../domain/storyDetectors.js";
import type { ShortlistEntry } from "../domain/shortlist.js";
import type { CurationInput, CurationSignal, CurationStory, LadderStrike, OtherAngleSignal } from "../domain/curationRules.js";

/** The fields of a shortlist entry (STO-76) that curation reads. Anything else on the entry, scores included, is deliberately not passed on. */
export type CurationEntry = Pick<ShortlistEntry, "id" | "playerId" | "gameId" | "angle" | "stat" | "summary" | "signalIds">;

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
  const sig = await db.query<{ id: string; source: string; kind: CurationSignal["kind"]; trust: CurationSignal["trust"]; summary: string; observed_at: Date; slate_date: string; url: string | null }>(
    `select id, source, kind::text as kind, trust::text as trust, summary, observed_at, slate_date::text as slate_date, evidence ->> 'url' as url
       from signals where id = any($1::bigint[])`, [signalIds]);
  const signals = new Map<number, CurationSignal>(sig.rows.map((r) => [Number(r.id), {
    id: Number(r.id), source: r.source, kind: r.kind, trust: r.trust, summary: r.summary,
    observedAt: r.observed_at.toISOString(), slateDate: r.slate_date, ...(r.url ? { url: r.url } : {}),
  }]));

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
    // STO-120: the signals of the same player's other stories, labelled by their angle. A signal shared with this story is not "other".
    const ownIds = new Set(e.signalIds);
    const otherAngleSignals: OtherAngleSignal[] = [];
    const seen = new Set<number>();
    for (const o of entries) {
      if (o.playerId !== e.playerId || o.id === e.id) continue;
      for (const id of o.signalIds) {
        if (ownIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        otherAngleSignals.push({ ...signals.get(id)!, angle: o.angle });
      }
    }
    const lad = await db.query<{ id: string; strike: string; yes_ask_cents: number }>(LADDER_SQL, [e.playerId, e.gameId, MARKET_STAT[e.stat], maxSpreadCents]);
    const ladder: LadderStrike[] = lad.rows.map((r) => ({ marketId: r.id, strike: Number(r.strike), yesPriceCents: r.yes_ask_cents }));
    stories.push({ storyId: String(e.id), playerId: e.playerId, playerName: name, gameId: e.gameId, stat: e.stat, angle: e.angle, summary: e.summary, signals: own, otherAngleSignals, ladder });
  }
  return { slateDate, stories };
}
