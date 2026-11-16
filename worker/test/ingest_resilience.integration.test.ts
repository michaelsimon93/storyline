// STO-32: messy Kalshi and ESPN data must not fail the whole night's ingest.
// Real Postgres, recorded fixtures with targeted edits, mocked fetch.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../src/jobs/ingest.js";
import type { Db } from "../src/lib/db.js";
import type { KalshiMarket } from "../src/sources/kalshi.js";
import { freshDb } from "./helpers/testDb.js";
import { fixture, installFetch, json, slateRoutes, type Route } from "./helpers/mockFetch.js";
import { idOf } from "./helpers/markets.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const SLATE = "2026-11-13";
const BLACK25 = "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25";
const BLACK20 = "KXNBAPTS-26NOV13MILORL-ORLABLACK0-20";
const WINNER = "KXNBAGAME-26NOV13MILORL-ORL";
const BLACK_KALSHI_ID = "60bb439a-df6a-4fea-8312-4caa6a2c0fbe";

const dbs: Db[] = [];
let restore = () => {};
after(async () => { restore(); for (const d of dbs) await d.end(); });

async function db(name: string): Promise<Db> {
  const d = (await freshDb(`sto32_${name}`))!;
  dbs.push(d);
  return d;
}
function useFetch(...routes: Route[]) {
  restore();
  restore = installFetch(...routes, slateRoutes).restore;
}

/** Kalshi's series pages from the fixtures, with an edit applied to each page's markets. */
function kalshiEdited(edit: (markets: KalshiMarket[], series: string) => KalshiMarket[]): Route {
  return (url) => {
    const series = url.searchParams.get("series_ticker");
    if (url.hostname !== "external-api.kalshi.com" || !series) return undefined;
    const body = fixture(`kalshi-${series}.json`) as { markets: KalshiMarket[]; cursor: string };
    return json({ ...body, markets: edit(body.markets, series) });
  };
}

const counts = async (d: Db) => (await d.query(`
  select (select count(*) from games)::int g, (select count(*) from markets)::int m,
         (select count(*) from external_ids)::int x, (select count(*) from players)::int p,
         (select count(*) from teams)::int t`)).rows[0];
const lastRun = async (d: Db) => (await d.query(
  `select status, outputs from pipeline_runs order by id desc limit 1`)).rows[0];

// ------------------------------------------------------------------ duplicates

test("a market Kalshi returns twice (pagination overlap) is loaded once", { skip }, async () => {
  const d = await db("dupes");
  // A player prop and a game winner, each listed twice; the prop's second copy has a newer price.
  useFetch(kalshiEdited((markets) => markets.flatMap((m) =>
    m.ticker === WINNER ? [m, { ...m }]
    : m.ticker === BLACK25 ? [m, { ...m, yes_ask_dollars: "0.1300" }]
    : [m])));
  const s = await ingest(d, SLATE);

  assert.deepEqual(s.markets, { KXNBAPTS: 37, KXNBAREB: 46, KXNBAAST: 41, KXNBA3PT: 54, KXNBAPRA: 31, KXNBAGAME: 2 });
  const first = await counts(d);
  assert.equal(first.m, 211);
  assert.equal(first.x, 211);
  const { rows: [m] } = await d.query(`select yes_ask_cents from markets where id = $1`, [await idOf(d, BLACK25)]);
  assert.equal(m.yes_ask_cents, 13, "the later copy wins");

  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first, "re-running with the same duplicates changes nothing");
});

// ------------------------------------------------------------------ malformed markets

test("malformed markets are skipped and logged; the rest of the slate loads", { skip }, async () => {
  const d = await db("malformed");
  useFetch(kalshiEdited((markets, series) => [
    ...markets.map((m) => {
      if (m.ticker === BLACK25) { const { custom_strike, ...rest } = m; return rest as KalshiMarket; }
      if (m.ticker === BLACK20) return { ...m, floor_strike: null };
      if (m.ticker === WINNER) return { ...m, yes_ask_dollars: "1.5000" };
      return m;
    }),
    ...(series === "KXNBAPTS" ? [{ ...markets[0]!, ticker: "GARBAGE" }, { ...markets[0]!, ticker: undefined as unknown as string }] : []),
  ]));
  const s = await ingest(d, SLATE);

  assert.equal(s.skipped.length, 5, `skipped: ${s.skipped.join(" | ")}`);
  const reasonFor = (t: string) => s.skipped.find((x) => x.startsWith(`${t}:`));
  assert.match(reasonFor(BLACK25)!, /player/);
  assert.match(reasonFor(BLACK20)!, /strike/);
  assert.match(reasonFor(WINNER)!, /price/);
  assert.ok(reasonFor("GARBAGE"));
  assert.equal(s.markets.KXNBAPTS, 35);
  assert.equal(s.markets.KXNBAGAME, 1);

  const first = await counts(d);
  assert.equal(first.m, 208, "211 minus the three malformed markets on tonight's game");
  assert.equal(first.x, 208);
  await assert.rejects(idOf(d, BLACK25));
  // Not silently stored in a broken shape either.
  const { rows: [bad] } = await d.query(
    `select count(*)::int n from markets where kind = 'player_stat' and (player_id is null or strike is null)`);
  assert.equal(bad.n, 0);

  const run = await lastRun(d);
  assert.equal(run.status, "ok");
  assert.deepEqual(run.outputs.skipped, s.skipped, "skips are in the run output");

  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first, "re-running is safe");
});

test("a market that was fine yesterday and is malformed today keeps its row", { skip }, async () => {
  const d = await db("malformed_later");
  useFetch();
  await ingest(d, SLATE);
  const first = await counts(d);
  const id = await idOf(d, BLACK25);
  useFetch(kalshiEdited((markets) => markets.map((m) => {
    if (m.ticker !== BLACK25) return m;
    const { custom_strike, ...rest } = m;
    return rest as KalshiMarket;
  })));
  const s = await ingest(d, SLATE);
  assert.equal(s.skipped.length, 1);
  assert.deepEqual(await counts(d), first);
  assert.equal(await idOf(d, BLACK25), id);
});

// ------------------------------------------------------------------ re-issued player id

test("Kalshi re-issuing a player's id reuses the existing player row", { skip }, async () => {
  const d = await db("player_reissue");
  useFetch();
  await ingest(d, SLATE);
  const first = await counts(d);
  const { rows: [black] } = await d.query(
    `select id, espn_athlete_id from players where kalshi_player_id = $1`, [BLACK_KALSHI_ID]);
  assert.ok(black.espn_athlete_id, "Black is matched to ESPN");
  const marketId = await idOf(d, BLACK25);

  const NEW_ID = "11111111-2222-3333-4444-555555555555";
  const reissued = kalshiEdited((markets) => markets.map((m) =>
    m.custom_strike?.basketball_player === BLACK_KALSHI_ID
      ? { ...m, custom_strike: { ...m.custom_strike, basketball_player: NEW_ID } } : m));
  useFetch(reissued);
  await ingest(d, SLATE);   // before the fix: duplicate key on players (league, espn_athlete_id)

  assert.deepEqual(await counts(d), first, "no new player, no new markets");
  const { rows } = await d.query(
    `select id, kalshi_player_id from players where espn_athlete_id = $1`, [black.espn_athlete_id]);
  assert.deepEqual(rows, [{ id: black.id, kalshi_player_id: NEW_ID }]);
  const { rows: [m] } = await d.query(`select player_id from markets where id = $1`, [marketId]);
  assert.equal(m.player_id, black.id, "his markets still point at the same player");

  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first, "re-running is safe");
});

test("two Kalshi players matching one ESPN athlete don't crash or merge", { skip }, async () => {
  const d = await db("player_clash");
  // A second Kalshi "Anthony Black" (different Kalshi id) on the same team, in the same run.
  const OTHER = "99999999-aaaa-bbbb-cccc-dddddddddddd";
  const TWIN = "KXNBAPTS-26NOV13MILORL-ORLABLACK9-25";
  useFetch(kalshiEdited((markets) => [
    ...markets,
    ...markets.filter((m) => m.ticker === BLACK25).map((m) => ({
      ...m, ticker: TWIN, custom_strike: { ...m.custom_strike, basketball_player: OTHER } })),
  ]));
  const s = await ingest(d, SLATE);

  assert.equal(s.players.ambiguous.length, 1, "the second claimant is reported");
  const { rows } = await d.query(
    `select kalshi_player_id, espn_athlete_id from players where kalshi_player_id = any($1) order by 1`,
    [[BLACK_KALSHI_ID, OTHER]]);
  assert.equal(rows.length, 2, "two Kalshi players stay two players");
  assert.ok(rows.find((r) => r.kalshi_player_id === BLACK_KALSHI_ID).espn_athlete_id);
  assert.equal(rows.find((r) => r.kalshi_player_id === OTHER).espn_athlete_id, null);
  assert.notEqual(await idOf(d, TWIN), await idOf(d, BLACK25));

  const first = await counts(d);
  await ingest(d, SLATE);
  assert.deepEqual(await counts(d), first, "re-running is safe");
});

// ------------------------------------------------------------------ postponed game

/**
 * The Nov 13 game replayed on Nov 15. ESPN lists it on the new date only (under the same event
 * ID, or a new one); Kalshi lists its markets under tickers with the new date.
 */
function replayedOnNov15(espnEventId?: string): Route[] {
  return [
    (url) => {
      if (url.hostname !== "site.api.espn.com" || !url.pathname.endsWith("/scoreboard")) return undefined;
      const body = fixture("espn-scoreboard-20261113.json") as { events: { id: string; date: string }[] };
      if (url.searchParams.get("dates") !== "20261115") return json({ ...body, events: [] });
      return json({ ...body, events: body.events.map((e) => ({ ...e, id: espnEventId ?? e.id, date: "2026-11-16T00:30Z" })) });
    },
    kalshiEdited((markets) => markets.map((m) => ({
      ...m,
      ticker: m.ticker.replace("26NOV13MILORL", "26NOV15MILORL"),
      event_ticker: m.event_ticker.replace("26NOV13MILORL", "26NOV15MILORL"),
    }))),
  ];
}
const gamesBySlate = async (d: Db) => (await d.query(`
  select g.id, g.slate_date::text, g.kalshi_game_key, g.status::text, g.tip_off_at,
         (select count(*)::int from markets m where m.game_id = g.id) markets
  from games g order by g.slate_date`)).rows;

for (const [label, newEventId] of [["the same ESPN event ID", undefined], ["a new ESPN event ID", "401999999"]] as const) {
  test(`a postponed game replayed another night is a new game; the original keeps its markets (${label})`, { skip }, async () => {
    const d = await db(newEventId ? "postponed_new_id" : "postponed_same_id");
    useFetch();
    await ingest(d, SLATE);
    const first = await counts(d);
    const [original] = await gamesBySlate(d);
    const marketId = await idOf(d, BLACK25);
    // A card on the original night, as picks would have.
    await d.query(
      `insert into cards (slate_date, sort_key, game_id, subject, player_id, market_id, blurb)
       select $1, 1, game_id, 'player', player_id, id, 'story' from markets where id = $2`, [SLATE, marketId]);

    useFetch(...replayedOnNov15(newEventId));
    const s = await ingest(d, "2026-11-15");   // before the fix: the original row moved (or nothing loaded)
    assert.equal(s.games, 1);
    assert.equal(s.markets.KXNBAPTS, 37);

    const games = await gamesBySlate(d);
    assert.equal(games.length, 2, "the replay is a second game");
    // The original night is untouched: same game, key, tip-off, markets and tickers, so Kalshi's
    // void result on those tickers settles the picks made that night.
    assert.equal(games[0].id, original.id);
    assert.equal(games[0].slate_date, SLATE);
    assert.equal(games[0].kalshi_game_key, "26NOV13MILORL");
    assert.deepEqual(games[0].tip_off_at, original.tip_off_at);
    assert.equal(games[0].markets, 211);
    assert.equal(await idOf(d, BLACK25), marketId);
    const { rows: [card] } = await d.query(`select game_id, market_id from cards`);
    assert.deepEqual(card, { game_id: original.id, market_id: marketId }, "the card stays on the original game and market");
    // We can only tell which game was replaced when ESPN reuses the event ID.
    assert.equal(games[0].status, newEventId ? "scheduled" : "postponed");

    // The replay has its own markets under Kalshi's new tickers.
    assert.equal(games[1].slate_date, "2026-11-15");
    assert.equal(games[1].kalshi_game_key, "26NOV15MILORL");
    assert.equal(games[1].status, "scheduled");
    assert.equal(new Date(games[1].tip_off_at).toISOString(), "2026-11-16T00:30:00.000Z");
    assert.equal(games[1].markets, 211);
    assert.notEqual(await idOf(d, BLACK25.replace("26NOV13", "26NOV15")), marketId);
    const after1 = await counts(d);
    assert.deepEqual(after1, { ...first, g: 2, m: 422, x: 422 }, "no new players or teams");

    // Re-running either night is safe.
    await ingest(d, "2026-11-15");
    const old = await ingest(d, SLATE);
    assert.equal(old.games, 0);
    assert.deepEqual(await counts(d), after1);
    assert.deepEqual(await gamesBySlate(d), games);
  });
}
