// The story step's ESPN inputs (STO-76) over a mocked fetch, never the network: what is fetched, whose log is skipped,
// and how it fails. The recorded story world (helpers/storyWorld.ts) writes ESPN's recorded shape.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installFetch, json } from "./helpers/mockFetch.js";
import { storyRoutes, P, STAR, NY, TOR, DAY, GAME, injuries } from "./helpers/storyWorld.js";
import { collectStoryInputs, tonightStatus } from "../src/sources/espnStories.js";
import { parseInjuryStatus } from "../src/domain/injuryStatus.js";
import type { Slate, SlatePlayer } from "../src/sources/types.js";

let restore = () => {};
afterEach(() => restore());
const OPTS = { pauseMs: 0, maxConsecutiveFailures: 3, fetchOpts: { retries: 0, baseDelayMs: 1 } };

const sp = (p: { id: string; espn: string; team: number; name: string }, injury: string | null = null, externalId: string | null = p.espn): SlatePlayer =>
  ({ id: p.id, name: p.name, teamId: p.team, externalId, injuryStatus: injury ? parseInjuryStatus(injury) : null });
const slate = (players: SlatePlayer[]): Slate => ({
  slateDate: DAY, league: "nba",
  games: [{ id: GAME, homeTeamId: TOR, awayTeamId: NY, externalId: "1" }],
  teams: [{ id: NY, externalId: String(NY) }, { id: TOR, externalId: String(TOR) }],
  players,
});
const gamelogCalls = (calls: string[]) => calls.filter((u) => u.endsWith("/gamelog")).map((u) => u.match(/athletes\/(\d+)/)![1]!).sort();

test("fetches injuries once, each team's schedule once, and the logs of players who may play plus teammates listed out", async () => {
  const net = installFetch(storyRoutes()); restore = net.restore;
  const got = await collectStoryInputs(slate([sp(P.HOT), sp(P.RET), sp(P.BACKUP), sp(P.HOTOUT, "Out")]), OPTS);
  assert.equal(net.calls.filter((u) => u.endsWith("/injuries")).length, 1);
  assert.deepEqual(net.calls.filter((u) => u.endsWith("/schedule")).length, 2);
  // Hot But Out is listed Out in the feed so he is fetched as an out teammate; the star is fetched because he is out on a slate team
  assert.deepEqual(gamelogCalls(net.calls), [P.HOT.espn, P.HOTOUT.espn, P.RET.espn, P.BACKUP.espn, STAR.espn].sort());
  assert.equal(got.feedOk, true);
  assert.equal(got.statusByAthlete.get(STAR.espn)?.status, "Out");
  assert.equal(got.statusByAthlete.has(P.HOT.espn), false, "absent from the feed = healthy");
  assert.equal(got.teamGames.get(NY)!.length, 10);
});

test("a player the feed doesn't list as hurt, but ingest stored as Out, is trusted as healthy when the feed loaded (the feed is fresher)", async () => {
  restore = installFetch(storyRoutes()).restore;
  const got = await collectStoryInputs(slate([sp(P.HOT, "Out")]), OPTS);
  assert.equal(tonightStatus(sp(P.HOT, "Out"), got), null);
});

test("with the injuries feed down, ingest's status stands in, and an Out player's log isn't fetched as a candidate", async () => {
  const net = installFetch(storyRoutes({ injuries: () => json({}, 503) })); restore = net.restore;
  const got = await collectStoryInputs(slate([sp(P.HOT), sp(P.HOTOUT, "Out")]), OPTS);
  assert.equal(got.feedOk, false);
  assert.deepEqual(gamelogCalls(net.calls), [P.HOT.espn]);
  assert.equal(tonightStatus(sp(P.HOTOUT, "Out"), got)?.status, "Out");
  assert.match(got.failures[0]!, /injuries/);
});

test("one failed game log is skipped and counted; the rest still load", async () => {
  restore = installFetch(storyRoutes({ [`gamelog-${P.RET.espn}`]: () => json({}, 503) })).restore;
  const got = await collectStoryInputs(slate([sp(P.HOT), sp(P.RET)]), OPTS);
  assert.equal(got.logs.has(P.RET.espn), false);
  assert.equal(got.logs.has(P.HOT.espn), true);
  assert.equal(got.failures.length, 1);
  assert.match(got.failures[0]!, /gamelog 9003/);
});

test("everything down: throws 'ESPN down' after the set number of failures in a row, not after hundreds of calls", async () => {
  const net = installFetch(() => json({}, 503)); restore = net.restore;
  await assert.rejects(collectStoryInputs(slate([sp(P.HOT), sp(P.RET), sp(P.BACKUP)]), OPTS), /ESPN down: stopped after 3 failed calls in a row/);
  assert.equal(net.calls.length, 3);
});

test("a player with no ESPN id is never looked up (we don't invent a match)", async () => {
  const net = installFetch(storyRoutes()); restore = net.restore;
  await collectStoryInputs(slate([sp(P.HOT, null, null)]), OPTS);
  assert.ok(!net.calls.includes(`https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${P.HOT.espn}/gamelog`));
});

test("an injury status we don't recognise is reported and treated as won't-play (not fetched)", async () => {
  const net = installFetch(storyRoutes({ injuries: () => json(injuries([{ team: NY, athleteId: P.HOT.espn, name: P.HOT.name, status: "Suspended" }])) })); restore = net.restore;
  const got = await collectStoryInputs(slate([sp(P.HOT), sp(P.RET)]), OPTS);
  assert.deepEqual(got.unknownStatuses, [`${P.HOT.name}: "Suspended"`]);
  assert.deepEqual(gamelogCalls(net.calls), [P.RET.espn]);
});

test("bad settings are rejected, not turned into odd behaviour", async () => {
  await assert.rejects(collectStoryInputs(slate([]), { ...OPTS, maxConsecutiveFailures: 0 }), /maxConsecutiveFailures/);
  await assert.rejects(collectStoryInputs(slate([]), { ...OPTS, pauseMs: -1 }), /pauseMs/);
});
