// Builders turn parsed ESPN rows into SignalDrafts. Keys must be stable per fact across runs
// (ADR-024 rule 2): no timestamps, no run numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/mockFetch.js";
import { parseGameLog, parseSplits, parseInjuries, parseSchedule, parseNews } from "../src/domain/espnParse.js";
import { playerSignals, teamInjurySignals, seriesSignal, newsSignals } from "../src/domain/espnSignals.js";

const T1 = "2026-11-17T15:00:00.000Z", T2 = "2026-11-17T16:30:00.000Z";
const log = parseGameLog(fixture("espn-gamelog-2993874.json"));
const splits = parseSplits(fixture("espn-splits-2993874.json"));

test("player signals: last-5 averages per stat, with the games behind them", () => {
  const d = playerSignals({ playerId: "p1", espnId: "2993874", log, splits, windowGames: 5, observedAt: T1 });
  const keys = d.map((x) => x.key);
  assert.deepEqual(keys, ["last5:pts", "last5:reb", "last5:ast", "last5:3pm", "split:home-road"]);
  const pts = d.find((x) => x.key === "last5:pts")!;
  const last5 = log.slice(0, 5).map((r) => r.pts);
  const avg = (last5.reduce((a, b) => a + b, 0) / 5).toFixed(1);
  assert.match(pts.summary, new RegExp(`Last 5 games: ${avg} PTS`));
  assert.ok(pts.evidence.quote!.includes(last5.join(", ")));
  assert.deepEqual([pts.kind, pts.trust, pts.subject], ["stat", "verified", { kind: "player", id: "p1" }]);
  assert.equal(pts.evidence.observedAt, T1);
});

test("player signals: fewer games than the window says so instead of claiming five", () => {
  const one = parseGameLog(fixture("espn-gamelog-4433188.json"));
  const d = playerSignals({ playerId: "p2", espnId: "4433188", log: one, splits: { home: splits.home }, windowGames: 5, observedAt: T1 });
  assert.match(d[0]!.summary, /^Last 1 game: /);
  assert.ok(!d.some((x) => x.key === "split:home-road"), "no road games, so no home/road comparison");
});

test("player signals: no games, no signals", () => {
  assert.deepEqual(playerSignals({ playerId: "p", espnId: "1", log: [], splits: {}, windowGames: 5, observedAt: T1 }), []);
});

test("keys are the same on a re-run; only observedAt moves", () => {
  const run = (t: string) => playerSignals({ playerId: "p1", espnId: "2993874", log, splits, windowGames: 5, observedAt: t });
  assert.deepEqual(run(T1).map((d) => d.key), run(T2).map((d) => d.key));
  assert.notEqual(run(T1)[0]!.evidence.observedAt, run(T2)[0]!.evidence.observedAt);
});

test("injury signals: one per entry on the team, keyed by the ESPN athlete", () => {
  const entries = parseInjuries(fixture("espn-injuries.json")).get("28")!;
  const d = teamInjurySignals({ teamId: 28, entries, observedAt: T1 });
  assert.equal(d.length, entries.length);
  const kawhi = d.find((x) => x.summary.includes("Kawhi Leonard"))!;
  assert.deepEqual([kawhi.kind, kawhi.subject], ["injury", { kind: "team", id: 28 }]);
  assert.match(kawhi.key, /^injury:\d+$/);
  assert.ok(kawhi.evidence.quote || kawhi.evidence.url);
});

test("series signal: season record between the two teams, from finished games", () => {
  const games = parseSchedule(fixture("espn-schedule-18.json"));
  const d = seriesSignal({ gameId: "g1", teamA: { espnId: "18", abbr: "NY" }, teamB: { espnId: "28", abbr: "TOR" }, games, observedAt: T1 })!;
  assert.deepEqual([d.key, d.kind, d.subject], ["series:season", "stat", { kind: "game", id: "g1" }]);
  assert.match(d.summary, /^Season series: (NY leads \d-\d|TOR leads \d-\d|tied \d-\d) /);
  assert.ok(d.evidence.quote!.includes("NY") && d.evidence.quote!.includes("TOR"));
});

test("series signal: teams that haven't met produce none", () => {
  const games = parseSchedule(fixture("espn-schedule-18.json"));
  assert.equal(seriesSignal({ gameId: "g", teamA: { espnId: "18", abbr: "NY" }, teamB: { espnId: "999", abbr: "XXX" }, games, observedAt: T1 }), undefined);
});

test("news signals: a matchup article belongs to the game, a one-team article to the team, a roundup to nobody", () => {
  const articles = parseNews(fixture("espn-news-28.json"));
  const d = newsSignals({ articles, game: { id: "g1", homeEspnId: "28", awayEspnId: "18" }, teamIds: { "28": 28, "18": 18 }, observedAt: T1 });
  const byKey = new Map(d.map((x) => [x.key, x]));
  const preview = byKey.get("news:50499326")!;
  assert.deepEqual(preview.subject, { kind: "game", id: "g1" });
  assert.equal(preview.evidence.url, "http://www.espn.com/nba/preview?gameId=401910002");
  assert.equal(preview.kind, "news");
  assert.ok(!byKey.has("news:50502518"), "a league roundup tagged to many teams isn't about this game");
  assert.equal(new Set(d.map((x) => x.key)).size, d.length, "each article appears once");
});
