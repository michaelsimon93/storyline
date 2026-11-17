// Parsers run on trimmed copies of real ESPN responses recorded Nov 16-17 2026 (ORL @ BOS, NY @ TOR).
// ESPN's endpoints are undocumented, so each parser must fail loudly when the shape moves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/mockFetch.js";
import {
  parseGameLog, parseInjuries, parseSchedule, parseNews,
} from "../src/domain/espnParse.js";

test("game log: regular season only, newest first, stats matched by label", () => {
  const rows = parseGameLog(fixture("espn-gamelog-2993874.json")).rows;
  // 12 rows in the file: 9 regular season, 3 preseason. Preseason must not count as form.
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.eventId), ["401909976", "401909968"]);
  const first = rows[0]!;
  assert.equal(first.date, "2026-11-13T00:00:00.000+00:00");
  assert.equal(first.home, false); // atVs "@"
  assert.equal(first.opponentId, "20");
  assert.deepEqual({ min: first.min, reb: first.reb, ast: first.ast, pts: first.pts }, { min: 5, reb: 0, ast: 1, pts: 0 });
  const second = rows[1]!;
  assert.equal(second.home, true);
  assert.deepEqual({ pts: second.pts, fg3m: second.fg3m, fg3a: second.fg3a }, { pts: 2, fg3m: 0, fg3a: 0 });
});

test("game log: a player with one regular-season game returns one row", () => {
  const rows = parseGameLog(fixture("espn-gamelog-4433188.json")).rows;
  assert.equal(rows.length, 1);
});

test("game log: whole-response shape drift fails loudly", () => {
  const good = fixture("espn-gamelog-2993874.json") as any;
  assert.throws(() => parseGameLog({}), /labels/);
  assert.throws(() => parseGameLog({ ...good, labels: ["MIN", "PTS"] }), /REB/); // a column we read is gone
  assert.throws(() => parseGameLog({ ...good, events: undefined }), /events/);
});

test("game log: one bad row is skipped and reported, the rest still count", () => {
  const good = fixture("espn-gamelog-2993874.json") as any;
  const rowsOf = (g: any) => g.seasonTypes[0].categories[0].events;
  const clean = parseGameLog(good).rows.length;

  const shortRow = structuredClone(good); rowsOf(shortRow)[0].stats = ["5"];
  const orphan = structuredClone(good); rowsOf(orphan)[0].eventId = "999";
  const noScore = structuredClone(good); rowsOf(noScore)[0].stats[13] = "--"; // e.g. a did-not-play row
  for (const [bad, why] of [[shortRow, /stats/], [orphan, /999/], [noScore, /PTS/]] as const) {
    const r = parseGameLog(bad);
    assert.equal(r.rows.length, clean - 1);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0]!, why);
  }
  assert.deepEqual(parseGameLog(good).skipped, []);
});

test("injuries: grouped by team, athlete id read from the player-card link", () => {
  const byTeam = parseInjuries(fixture("espn-injuries.json")).rows;
  const tor = byTeam.get("28")!;
  assert.ok(tor.length >= 3);
  const kawhi = tor.find((i) => i.name === "Kawhi Leonard")!;
  assert.equal(kawhi.status, "Out");
  assert.match(kawhi.athleteId, /^\d+$/);
  assert.ok(kawhi.comment.length > 0);
});

test("injuries: one entry with no player-card link is skipped, not misattributed, and the rest survive", () => {
  const clean = parseInjuries(fixture("espn-injuries.json")).rows;
  const bad = structuredClone(fixture("espn-injuries.json")) as any;
  const firstTeam = bad.injuries[0];
  firstTeam.injuries[0].athlete.links = [];
  const r = parseInjuries(bad);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!, /athlete id/);
  assert.equal(r.rows.get(firstTeam.id)!.length, clean.get(firstTeam.id)!.length - 1);
  assert.equal(r.rows.get("28")!.length, clean.get("28")!.length, "other teams are untouched");
  assert.throws(() => parseInjuries({}), /injuries/);
});

test("schedule: finished regular-season games only, with scores", () => {
  const games = parseSchedule(fixture("espn-schedule-18.json")).rows;
  assert.ok(games.length > 5);
  const vsTor = games.filter((g) => g.homeId === "28" || g.awayId === "28");
  assert.ok(vsTor.length >= 1, "NY and TOR have already met this season");
  assert.ok(vsTor.every((g) => [g.homeAbbr, g.awayAbbr].sort().join() === "NY,TOR"));
  for (const g of games) assert.ok(Number.isInteger(g.homeScore) && Number.isInteger(g.awayScore));
  assert.ok(!games.some((g) => g.date > "2026-11-17"), "scheduled games are not results");
});

test("schedule: a finished game with no score is skipped and reported", () => {
  const clean = parseSchedule(fixture("espn-schedule-18.json")).rows.length;
  const bad = structuredClone(fixture("espn-schedule-18.json")) as any;
  const final = bad.events.find((e: any) => e.competitions[0].status.type.name === "STATUS_FINAL");
  delete final.competitions[0].competitors[0].score;
  const r = parseSchedule(bad);
  assert.equal(r.rows.length, clean - 1);
  assert.match(r.skipped[0]!, /score/);
  assert.throws(() => parseSchedule({}), /events/);
});

test("news: ids, urls and tagged teams; athlete tags are ignored", () => {
  const a = parseNews(fixture("espn-news-28.json")).rows;
  assert.equal(a.length, 6);
  const preview = a.find((x) => x.id === "50499326")!;
  assert.equal(preview.url, "http://www.espn.com/nba/preview?gameId=401910002");
  assert.deepEqual([...preview.teamIds].sort(), ["18", "28"]);
  const roundup = a.find((x) => x.id === "50502518")!;
  assert.ok(roundup.teamIds.length > 4, "a league roundup is tagged to many teams");
});

test("news: an article with no link is skipped and reported; a missing feed fails loudly", () => {
  const bad = structuredClone(fixture("espn-news-28.json")) as any;
  delete bad.articles[0].links;
  const r = parseNews(bad);
  assert.equal(r.rows.length, 5);
  assert.match(r.skipped[0]!, /link/);
  assert.throws(() => parseNews({}), /articles/);
});
