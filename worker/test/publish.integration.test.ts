// The publish step (STO-12) against real Postgres: cards go live from a curation run's stored picks, a re-run is safe,
// the line can't move afterwards, and a card that is no longer fit to publish is left out and the set flagged short.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { runPublish } from "../src/jobs/publish.js";
import { freshDb } from "./helpers/testDb.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const DAY = "2026-11-24", EMPTY_DAY = "2026-11-25";
const P = ["00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000a2", "00000000-0000-0000-0000-0000000000a3"];
const [G1, G2] = ["00000000-0000-0000-0000-0000000000b1", "00000000-0000-0000-0000-0000000000b2"];
let db: Db | null = null;
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db!.query(sql, p)).rows as T[];

const markets: string[] = [], stories: string[] = [];
const facts = (signals: unknown[] = []) => ({ level: "full", market: { player: "x", team: "t", opponent: "o", home: true, stat: "points", strike: 25, yesPriceCents: 50 }, signals });
const verified = { id: 1, source: "espn", kind: "stat", trust: "verified", summary: "s", observedAt: "2026-11-24T12:00:00Z", slateDate: DAY, via: "own" };

async function storePicks(picks: { i: number; blurb?: string; signals?: unknown[] }[], day = DAY) {
  return Number((await q<{ id: string }>(`insert into pipeline_runs (job, slate_date, status, outputs) values ('curate', $1, 'ok', $2) returning id`,
    [day, JSON.stringify({ picks: picks.map((p) => ({ storyId: stories[p.i], marketId: markets[p.i], reason: "r", blurb: p.blurb ?? `Player ${p.i} is on a roll.`, blurbFacts: facts(p.signals ?? [verified]) })) })]))[0]!.id);
}
const alerts = () => { const sent: string[] = []; return { sent, alert: async (m: string) => { sent.push(m); } }; };
const cardCount = async () => Number((await q<{ n: string }>(`select count(*) n from cards`))[0]!.n);

before(async () => {
  db = await freshDb("storyline_publish_test");
  if (!db) return;
  await q(`insert into teams (id, league, name, abbr) values (1,'nba','Knicks','NYK'),(2,'nba','Raptors','TOR'),(3,'nba','Heat','MIA'),(4,'nba','Magic','ORL')`);
  await q(`insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values
    ($1,'nba',$3,2,1, now() + interval '5 hours'), ($2,'nba',$3,4,3, now() + interval '6 hours')`, [G1, G2, DAY]);
  await q(`insert into players (id, league, full_name, team_id) values ($1,'nba','Jalen Brunson',1), ($2,'nba','Scottie Barnes',2), ($3,'nba','Paolo Banchero',4)`, P);
  const run = (await q<{ id: number }>(`insert into pipeline_runs (job, slate_date, status) values ('story', $1, 'ok') returning id`, [DAY]))[0]!.id;
  const games = [G1, G1, G2], teams = [1, 2, 4], angles = ["hot_streak", "backup_steps_in", "back_from_injury"];
  for (let i = 0; i < 3; i++) {
    const m = (await q<{ id: string }>(`insert into markets (league, game_id, kind, title, player_id, stat, strike, yes_bid_cents, yes_ask_cents, status)
      values ('nba',$1,'player_stat','t',$2,'points',$3,48,50,'open') returning id`, [games[i], P[i], 25 + i]))[0]!.id;
    markets.push(m);
    stories.push((await q<{ id: string }>(`insert into story_shortlist (run_id, slate_date, league, position, player_id, game_id, team_id, angle, stat, score, summary, market_id, slot_kind)
      values ($1,$2,'nba',$3,$4,$5,$6,$7,'pts',10,'s',$8,'quota') returning id`, [run, DAY, i + 1, P[i], games[i], teams[i], angles[i], m]))[0]!.id);
  }
});
after(async () => { await db?.end(); });
beforeEach(async () => {
  if (!db) return;
  await q(`delete from cards`);
  await q(`delete from pipeline_runs where job in ('curate', 'publish')`);
  await q(`update markets set yes_ask_cents = 50, status = 'open'`);
  await q(`update app_config set value = '3' where key = 'cards_per_day'`);
});

test("publishes every pick: the line, blurb, facts, type and order are stored, and the run is on the record", { skip }, async () => {
  const curation = await storePicks([{ i: 1 }, { i: 0 }, { i: 2 }]);
  const a = alerts();
  const r = await runPublish(db!, { alert: a.alert, date: DAY });
  assert.equal(r.status, "ok");
  assert.deepEqual(a.sent, []);
  const cards = await q<{ player_id: string; market_id: string; blurb: string; blurb_facts: { level: string }; storyline_type: string; sort_key: string; curation_run_id: string; team_id: number; placement: string }>(
    `select * from cards where slate_date = $1 order by sort_key`, [DAY]);
  assert.deepEqual(cards.map((c) => c.player_id), [P[1], P[0], P[2]]);                    // the curator's order
  assert.deepEqual(cards.map((c) => c.market_id), [markets[1], markets[0], markets[2]]);   // the picked strike is the locked line
  assert.deepEqual(cards.map((c) => c.storyline_type), ["injury_opportunity", "hot_streak", "news"]);
  assert.deepEqual(cards.map((c) => c.team_id), [2, 1, 4]);
  assert.equal(cards[0]!.blurb, "Player 1 is on a roll.");
  assert.equal(cards[0]!.blurb_facts.level, "full");
  assert.ok(cards.every((c) => Number(c.curation_run_id) === curation && c.placement === "core"));
  assert.equal((await q<{ status: string }>(`select status from pipeline_runs where job = 'publish'`))[0]!.status, "ok");
});

test("safe to re-run: a second run, even after a newer curation run, adds nothing and changes no line", { skip }, async () => {
  await storePicks([{ i: 0 }, { i: 1 }]);
  await runPublish(db!, { alert: async () => {}, date: DAY });
  const before = await q(`select id, market_id, sort_key, blurb from cards order by sort_key`);
  await storePicks([{ i: 2 }, { i: 0 }]);   // a later curation run, with a different set
  const r = await runPublish(db!, { alert: async () => {}, date: DAY });
  assert.equal(r.status, "already_published");
  assert.deepEqual(await q(`select id, market_id, sort_key, blurb from cards order by sort_key`), before);
});

test("six publishes at once make one deck, and neither crashes", { skip }, async () => {
  await storePicks([{ i: 0 }, { i: 1 }, { i: 2 }]);
  const rs = await Promise.all(Array.from({ length: 6 }, () => runPublish(db!, { alert: async () => {}, date: DAY })));
  assert.equal(rs.filter((r) => r.status === "ok").length, 1);
  assert.equal(rs.filter((r) => r.status === "already_published").length, 5);
  assert.equal(await cardCount(), 3);
});

test("a short set publishes and says so; a line that left the band is the one left out", { skip }, async () => {
  await storePicks([{ i: 0 }, { i: 1 }, { i: 2 }]);
  await q(`update markets set yes_ask_cents = 80 where id = $1`, [markets[1]]);   // drifted since curation
  const r = await runPublish(db!, { alert: async () => {}, date: DAY });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.published.length, 2);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["out_of_band"]);
  assert.equal(await cardCount(), 2);
  assert.equal((await q<{ n: string }>(`select count(*) n from cards where player_id = $1`, [P[1]]))[0]!.n, "0");
  assert.ok(r.published.length < r.asked);   // asked 3
});

test("a stored blurb that cites an unreviewed signal never publishes", { skip }, async () => {
  const a = alerts();
  await storePicks([{ i: 0, signals: [{ ...verified, trust: "unreviewed", source: "x" }] }, { i: 1 }]);
  const r = await runPublish(db!, { alert: a.alert, date: DAY });
  assert.equal(r.status, "ok");
  assert.equal(await cardCount(), 1);
  assert.equal((await q<{ n: string }>(`select count(*) n from cards where player_id = $1`, [P[0]]))[0]!.n, "0");
});

test("nothing passes the checks: nothing is published and an alert goes out", { skip }, async () => {
  const a = alerts();
  await storePicks([{ i: 0 }]);
  await q(`update markets set status = 'closed'`);
  const r = await runPublish(db!, { alert: a.alert, date: DAY });
  assert.equal(r.status, "nothing_publishable");
  assert.equal(await cardCount(), 0);
  assert.equal(a.sent.length, 1);
});

test("no finished curation run: alert, nothing published", { skip }, async () => {
  const a = alerts();
  assert.equal((await runPublish(db!, { alert: a.alert, date: DAY })).status, "no_curation");
  assert.equal(a.sent.length, 1);
  await q(`insert into pipeline_runs (job, slate_date, status) values ('curate', $1, 'failed')`, [DAY]);   // a failed run is not a curation
  assert.equal((await runPublish(db!, { alert: async () => {}, date: DAY })).status, "no_curation");
  assert.equal(await cardCount(), 0);
});

test("a day with no games does nothing, not even a run row", { skip }, async () => {
  const a = alerts();
  assert.equal((await runPublish(db!, { alert: a.alert, date: EMPTY_DAY })).status, "no_games");
  assert.deepEqual(a.sent, []);
  assert.equal((await q(`select 1 from pipeline_runs where job = 'publish'`)).length, 0);
});

test("the line locks: a published card can't be moved to another market or player, but can still be marked out", { skip }, async () => {
  await storePicks([{ i: 0 }]);
  await runPublish(db!, { alert: async () => {}, date: DAY });
  await assert.rejects(q(`update cards set market_id = $1`, [markets[1]]), /card_line_locked/);
  await assert.rejects(q(`update cards set player_id = $1, team_id = 2`, [P[1]]), /card_line_locked/);
  await q(`update cards set is_out = true, sort_key = 9`);
  assert.equal((await q<{ is_out: boolean }>(`select is_out from cards`))[0]!.is_out, true);
});
