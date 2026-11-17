// The ESPN context source end to end over recorded fixtures with a mocked fetch. Never the network.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fixture, installFetch, json } from "./helpers/mockFetch.js";
import { espnRoutes } from "./helpers/espnRoutes.js";
import { createEspnSource, type CollectStats } from "../src/sources/espnContext.js";
import type { Slate, SlatePlayer } from "../src/sources/types.js";
import { parseInjuryStatus } from "../src/domain/injuryStatus.js";

let restore = () => {};
afterEach(() => restore());

/** `injuryStatus` is what ingest stored (ESPN's own string); the slate carries it parsed. */
const player = (o: { id: string; externalId?: string | null; injuryStatus?: string | null }): SlatePlayer =>
  ({ id: o.id, name: o.id, teamId: 28, externalId: o.externalId ?? null, injuryStatus: o.injuryStatus ? parseInjuryStatus(o.injuryStatus) : null });

/** The recorded league injuries feed with extra entries on Toronto's list: [athlete id, name, status]. */
const feedWith = (extra: [string, string, string][]) => () => {
  const feed = structuredClone(fixture("espn-injuries.json")) as any;
  const tor = feed.injuries.find((t: any) => t.id === "28");
  for (const [id, name, status] of extra) {
    tor.injuries.push({ id: `inj-${id}`, status, date: "2026-11-17T10:00Z", shortComment: "", type: {},
      athlete: { displayName: name, links: [{ rel: ["playercard", "desktop", "athlete"], href: `https://www.espn.com/nba/player/_/id/${id}/x` }] } });
  }
  return json(feed);
};

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

const make = (onStats?: (s: CollectStats) => void) => createEspnSource({
  flag: "context_espn", windowGames: 5, pauseMs: 0, maxConsecutiveFailures: 3, fetchOpts: { retries: 1, baseDelayMs: 1 }, now: () => new Date("2026-11-17T15:00:00Z"), onStats,
});

test("declares itself as the ESPN discover source", () => {
  const s = make();
  assert.deepEqual([s.name, s.stage, s.flag], ["espn", "discover", "context_espn"]);
});

test("collects player, team and game signals for the slate", async () => {
  const net = installFetch(routes()); restore = net.restore;
  let stats!: CollectStats;
  const drafts = await make((s) => { stats = s; }).collect(slate);
  const keys = (k: string) => drafts.filter((d) => d.subject.kind === k).map((d) => d.key);
  assert.ok(keys("player").includes("form:pts"));
  assert.ok(drafts.some((d) => d.subject.kind === "player" && d.subject.id === "p-rookie"));
  assert.ok(keys("team").some((k) => k.startsWith("injury:")));
  assert.ok(keys("game").includes("series:season"));
  assert.ok(keys("game").includes("news:50499326"));
  for (const d of drafts) assert.match(d.evidence.observedAt, /^2026-11-17T15:00:00\.000Z$/);
  assert.deepEqual({ ...stats.players }, { fetched: 2, skippedWontPlay: 2, unmatched: 1, failed: 0 });
  assert.equal(stats.failures.length, 0);
  // Out and Doubtful players, and players we haven't matched, cost no calls.
  assert.ok(!net.calls.some((u) => u.includes("/1111/") || u.includes("/2222/")));
  // One call per player: form and home/road both come from the game log.
  assert.equal(net.calls.filter((u) => u.includes("/athletes/")).length, 2);
  // League injuries are fetched once, not once per team.
  assert.equal(net.calls.filter((u) => u.endsWith("/injuries")).length, 1);
});

/** The recorded routes, with the slate's Out and Doubtful players on today's feed (a skip now needs the feed to say so). */
const routes = (over: Parameters<typeof espnRoutes>[0] = {}) =>
  espnRoutes({ injuries: feedWith([["1111", "Out Player", "Out"], ["2222", "Doubtful Player", "Doubtful"]]), ...over });

// ---------------------------------------------------------------- who is skipped (STO-89, STO-90, STO-81)

const stats = async (s: Slate, over: Parameters<typeof espnRoutes>[0]) => {
  const net = installFetch(routes(over)); restore = net.restore;
  let out!: CollectStats;
  await make((x) => { out = x; }).collect(s);
  return { out, calls: net.calls };
};
const one = (p: SlatePlayer): Slate => ({ ...slate, players: [p] });

test("STO-90: ingest said Out, but today's feed no longer lists him, so he is asked for", async () => {
  const { out, calls } = await stats(one(player({ id: "p-back", externalId: "2993874", injuryStatus: "Out" })), {});
  assert.equal(out.players.skippedWontPlay, 0);
  assert.ok(calls.some((u) => u.includes("/athletes/2993874/")), "the stale ingest status must not decide");
});

test("STO-90: ingest saw only his first injury (Day-To-Day); the feed also has him Out, so he is skipped", async () => {
  const feed = feedWith([["2993874", "Vet", "Day-To-Day"], ["2993874", "Vet", "Out"]]);
  const { out, calls } = await stats(one(player({ id: "p-vet", externalId: "2993874", injuryStatus: "Day-To-Day" })), { injuries: feed });
  assert.equal(out.players.skippedWontPlay, 1);
  assert.ok(!calls.some((u) => u.includes("/athletes/")));
});

test("STO-90: the order ESPN lists a player's injuries in does not matter", async () => {
  for (const order of [["Out", "Day-To-Day"], ["Day-To-Day", "Out"]]) {
    const { out } = await stats(one(player({ id: "p", externalId: "2993874" })), { injuries: feedWith(order.map((st) => ["2993874", "Vet", st] as [string, string, string])) });
    assert.equal(out.players.skippedWontPlay, 1, order.join(" then "));
  }
});

test("a player listed Day-To-Day or Questionable still plays, so he is asked for", async () => {
  for (const st of ["Day-To-Day", "Questionable", "Probable"]) {
    const { out } = await stats(one(player({ id: "p", externalId: "2993874" })), { injuries: feedWith([["2993874", "Vet", st]]) });
    assert.deepEqual([st, out.players.skippedWontPlay, out.players.fetched], [st, 0, 1]);
  }
});

test("if the injuries feed itself fails, ingest's status is the fallback, so an Out player is still not asked for", async () => {
  const { out, calls } = await stats(one(player({ id: "p-out", externalId: "2993874", injuryStatus: "Out" })), { injuries: () => json({}, 503) });
  assert.equal(out.players.skippedWontPlay, 1);
  assert.ok(!calls.some((u) => u.includes("/athletes/")));
  assert.ok(out.failures.some((f) => f.startsWith("injuries")), "the failed feed is still reported");
});

test("STO-81: a status we have never seen is treated as won't-play, reported with its raw value, and doesn't fail the row", async () => {
  const { out, calls } = await stats(one(player({ id: "p", externalId: "2993874" })), { injuries: feedWith([["2993874", "Vet", "Suspension"]]) });
  assert.equal(out.players.skippedWontPlay, 1);
  assert.equal(out.players.failed, 0);
  assert.deepEqual(out.unknownStatuses, ['p: "Suspension"']);
  assert.ok(!calls.some((u) => u.includes("/athletes/")));
});

test("an unknown status from ingest (feed down) is reported too", async () => {
  const { out } = await stats(one(player({ id: "p-x", externalId: "2993874", injuryStatus: "Suspension" })), { injuries: () => json({}, 503) });
  assert.deepEqual(out.unknownStatuses, ['p-x: "Suspension"']);
  assert.equal(out.players.skippedWontPlay, 1);
});

test("a re-run reports the same keys for the same subjects", async () => {
  restore = installFetch(routes()).restore;
  const id = (d: { subject: unknown; key: string }) => JSON.stringify([d.subject, d.key]);
  const a = (await make().collect(slate)).map(id).sort();
  const b = (await make().collect(slate)).map(id).sort();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, "no duplicate (subject, key) inside one run");
});

test("a transient 503 is retried and the player's signals still arrive", async () => {
  let n = 0;
  restore = installFetch(routes({ "gamelog-2993874": () => (n++ === 0 ? json({}, 503) : json(fixture("espn-gamelog-2993874.json"))) })).restore;
  let stats!: CollectStats;
  const drafts = await make((s) => { stats = s; }).collect(slate);
  assert.ok(drafts.some((d) => d.subject.kind === "player" && d.subject.id === "p-vet"));
  assert.equal(stats.players.failed, 0);
});

test("partial failure keeps what worked and reports what didn't", async () => {
  restore = installFetch(routes({
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
  restore = installFetch(routes({ "gamelog-2993874": () => json({ labels: ["MIN"] }) })).restore;
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
  restore = installFetch(routes()).restore;
  const drafts = await make().collect({ ...slate, games: [], teams: [], players: [] });
  assert.deepEqual(drafts, []);
});

test("an outage stops after N failures in a row instead of working through every player", async () => {
  const many: Slate = { ...slate, players: Array.from({ length: 50 }, (_, i) => player({ id: `p${i}`, externalId: String(5000 + i) })) };
  const net = installFetch((url) => (url.hostname.includes("espn") ? json({ error: "x" }, 503) : undefined));
  restore = net.restore;
  const source = createEspnSource({ flag: "f", windowGames: 5, pauseMs: 0, maxConsecutiveFailures: 3, fetchOpts: { retries: 0 }, now: () => new Date() });
  await assert.rejects(source.collect(many), /ESPN down: stopped after 3 failed calls in a row \(3 calls made\)/);
  assert.equal(net.calls.length, 3, "3 calls, not 50+");
});

test("failures that aren't in a row don't trip the breaker", async () => {
  // gamelog for the first player fails, the rest are fine: one failure, then successes reset the count.
  restore = installFetch(routes({ "gamelog-2993874": () => json({}, 500) })).restore;
  const drafts = await createEspnSource({ flag: "f", windowGames: 5, pauseMs: 0, maxConsecutiveFailures: 1, fetchOpts: { retries: 0 }, now: () => new Date() }).collect(slate)
    .then((d) => d, (e: Error) => e);
  assert.ok(drafts instanceof Error, "with a limit of 1 the first failure does trip it");
  restore();
  restore = installFetch(routes({ "gamelog-2993874": () => json({}, 500) })).restore;
  const ok = await make().collect(slate); // limit 3: one failure is fine
  assert.ok(ok.length > 0);
});

test("one bad injury row is skipped and reported; every other signal still arrives", async () => {
  const bad = (await feedWith([["1111", "Out Player", "Out"], ["2222", "Doubtful Player", "Doubtful"]])().json()) as any;
  const team = bad.injuries.find((t: any) => t.id === "28");
  team.injuries[0].athlete.links = [];
  const clean = (await (async () => { restore = installFetch(routes()).restore; return make().collect(slate); })()).filter((d) => d.kind === "injury").length;
  restore();
  restore = installFetch(routes({ injuries: () => json(bad) })).restore;
  let stats!: CollectStats;
  const drafts = await make((s) => { stats = s; }).collect(slate);
  assert.equal(drafts.filter((d) => d.kind === "injury").length, clean - 1);
  assert.equal(stats.skippedRows.length, 1);
  assert.match(stats.skippedRows[0]!, /^injuries: .*athlete id/);
  assert.equal(stats.failures.length, 0, "a skipped row is not a failed call");
});

test("options that would silently misbehave are rejected up front", () => {
  const base = { flag: "f", windowGames: 5, pauseMs: 0, maxConsecutiveFailures: 3 };
  assert.throws(() => createEspnSource({ ...base, windowGames: 0 }), /windowGames/);
  assert.throws(() => createEspnSource({ ...base, windowGames: -1 }), /windowGames/);
  assert.throws(() => createEspnSource({ ...base, windowGames: Number.NaN }), /windowGames/);
  assert.throws(() => createEspnSource({ ...base, windowGames: 2.5 }), /windowGames/);
  assert.throws(() => createEspnSource({ ...base, pauseMs: -1 }), /pauseMs/);
  assert.throws(() => createEspnSource({ ...base, maxConsecutiveFailures: 0 }), /maxConsecutiveFailures/);
});
