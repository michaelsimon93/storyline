// The ESPN context source end to end over recorded fixtures with a mocked fetch. Never the network.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fixture, installFetch, json, type Route } from "./helpers/mockFetch.js";
import { createEspnSource, type CollectStats } from "../src/sources/espnContext.js";
import type { Slate, SlatePlayer } from "../src/sources/types.js";

let restore = () => {};
afterEach(() => restore());

const player = (o: Partial<SlatePlayer> & { id: string }): SlatePlayer =>
  ({ name: o.id, teamId: 28, externalId: null, injuryStatus: null, ...o });

// Tonight (Nov 17): NY @ TOR. Our ids are made up; ESPN's (18, 28, 401910002, athlete ids) are the recorded ones.
const slate: Slate = {
  slateDate: "2026-11-17", league: "nba",
  games: [{ id: "game-1", homeTeamId: 28, awayTeamId: 18, externalId: "401910002" }],
  teams: [{ id: 28, externalId: "28" }, { id: 18, externalId: "18" }],
  players: [
    player({ id: "p-vet", externalId: "2993874" }),
    player({ id: "p-rookie", externalId: "4433188", injuryStatus: "Day-To-Day" }),
    player({ id: "p-out", externalId: "1111", injuryStatus: "Out" }),
    player({ id: "p-doubtful", externalId: "2222", injuryStatus: "Doubtful" }),
    player({ id: "p-unmatched", externalId: null }),
  ],
};

const espnRoutes = (over: Record<string, () => Response> = {}): Route => (url) => {
  const hit = (k: string) => over[k] ? over[k]!() : undefined;
  const p = url.pathname;
  let m;
  if (url.hostname === "site.api.espn.com") {
    if (p.endsWith("/injuries")) return hit("injuries") ?? json(fixture("espn-injuries.json"));
    if (p.endsWith("/news")) return hit(`news-${url.searchParams.get("team")}`) ?? json(url.searchParams.get("team") === "28" ? fixture("espn-news-28.json") : { articles: [] });
    if ((m = p.match(/\/teams\/(\d+)\/schedule$/))) return hit(`schedule-${m[1]}`) ?? json(fixture("espn-schedule-18.json"));
  }
  if (url.hostname === "site.web.api.espn.com" && (m = p.match(/\/athletes\/(\d+)\/(gamelog)$/))) {
    return hit(`gamelog-${m[1]}`) ?? json(fixture(`espn-gamelog-${m[1]}.json`));
  }
  return undefined;
};

const make = (onStats?: (s: CollectStats) => void) => createEspnSource({
  flag: "context_espn", windowGames: 5, pauseMs: 0, fetchOpts: { retries: 1, baseDelayMs: 1 }, now: () => new Date("2026-11-17T15:00:00Z"), onStats,
});

test("declares itself as the ESPN discover source", () => {
  const s = make();
  assert.deepEqual([s.name, s.stage, s.flag], ["espn", "discover", "context_espn"]);
});

test("collects player, team and game signals for the slate", async () => {
  const net = installFetch(espnRoutes()); restore = net.restore;
  let stats!: CollectStats;
  const drafts = await make((s) => { stats = s; }).collect(slate);
  const keys = (k: string) => drafts.filter((d) => d.subject.kind === k).map((d) => d.key);
  assert.ok(keys("player").includes("last5:pts"));
  assert.ok(drafts.some((d) => d.subject.kind === "player" && d.subject.id === "p-rookie"));
  assert.ok(keys("team").some((k) => k.startsWith("injury:")));
  assert.ok(keys("game").includes("series:season"));
  assert.ok(keys("game").includes("news:50499326"));
  for (const d of drafts) assert.match(d.evidence.observedAt, /^2026-11-17T15:00:00\.000Z$/);
  assert.deepEqual({ ...stats.players }, { fetched: 2, skippedOutOrDoubtful: 2, unmatched: 1, failed: 0 });
  assert.equal(stats.failures.length, 0);
  // Out and Doubtful players, and players we haven't matched, cost no calls.
  assert.ok(!net.calls.some((u) => u.includes("/1111/") || u.includes("/2222/")));
  // One call per player: form and home/road both come from the game log.
  assert.equal(net.calls.filter((u) => u.includes("/athletes/")).length, 2);
  // League injuries are fetched once, not once per team.
  assert.equal(net.calls.filter((u) => u.endsWith("/injuries")).length, 1);
});

test("a re-run reports the same keys for the same subjects", async () => {
  restore = installFetch(espnRoutes()).restore;
  const id = (d: { subject: unknown; key: string }) => JSON.stringify([d.subject, d.key]);
  const a = (await make().collect(slate)).map(id).sort();
  const b = (await make().collect(slate)).map(id).sort();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, "no duplicate (subject, key) inside one run");
});

test("a transient 503 is retried and the player's signals still arrive", async () => {
  let n = 0;
  restore = installFetch(espnRoutes({ "gamelog-2993874": () => (n++ === 0 ? json({}, 503) : json(fixture("espn-gamelog-2993874.json"))) })).restore;
  let stats!: CollectStats;
  const drafts = await make((s) => { stats = s; }).collect(slate);
  assert.ok(drafts.some((d) => d.subject.kind === "player" && d.subject.id === "p-vet"));
  assert.equal(stats.players.failed, 0);
});

test("partial failure keeps what worked and reports what didn't", async () => {
  restore = installFetch(espnRoutes({
    "gamelog-2993874": () => json({}, 500),
    "news-28": () => json({}, 500),
  })).restore;
  let stats!: CollectStats;
  const drafts = await make((s) => { stats = s; }).collect(slate);
  assert.ok(!drafts.some((d) => d.subject.kind === "player" && d.subject.id === "p-vet"));
  assert.ok(drafts.some((d) => d.subject.kind === "player" && d.subject.id === "p-rookie"));
  assert.equal(stats.players.failed, 1);
  assert.equal(stats.failures.length, 2);
  assert.ok(stats.failures.some((f) => f.includes("2993874")) && stats.failures.some((f) => f.includes("news")));
});

test("a malformed response counts as that call failing, not as a signal", async () => {
  restore = installFetch(espnRoutes({ "gamelog-2993874": () => json({ labels: ["MIN"] }) })).restore;
  let stats!: CollectStats;
  await make((s) => { stats = s; }).collect(slate);
  assert.equal(stats.players.failed, 1);
  assert.match(stats.failures[0]!, /REB/);
});

test("ESPN down: every call fails, so the source throws and the caller can fall back", async () => {
  restore = installFetch((url) => (url.hostname.includes("espn") ? json({ error: "x" }, 503) : undefined)).restore;
  await assert.rejects(make().collect(slate), /ESPN down/);
});

test("a slate with nothing to ask about is not an error", async () => {
  restore = installFetch(espnRoutes()).restore;
  const drafts = await make().collect({ ...slate, games: [], teams: [], players: [] });
  assert.deepEqual(drafts, []);
});
