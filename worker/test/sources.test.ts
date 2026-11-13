import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as espn from "../src/sources/espn.js";
import * as kalshi from "../src/sources/kalshi.js";
import { installFetch, json, slateRoutes } from "./helpers/mockFetch.js";

let restore = () => {};
afterEach(() => restore());

test("ESPN scoreboard parses games, teams, tip-off, broadcasts", async () => {
  restore = installFetch(slateRoutes).restore;
  const games = await espn.getGames("2026-11-13");
  assert.equal(games.length, 1);
  const g = games[0]!;
  assert.equal(g.away.abbr, "MIL");
  assert.equal(g.home.abbr, "ORL");
  assert.equal(g.status, "scheduled");
  assert.equal(g.startsAt, "2026-11-14T00:00Z");
  assert.deepEqual(g.broadcasts[0]?.names, ["MyMi", "Bucks App"]);
});

test("ESPN roster parses players and injury status", async () => {
  restore = installFetch(slateRoutes).restore;
  const roster = await espn.getRoster("19"); // Orlando
  assert.ok(roster.length > 10);
  const suggs = roster.find((p) => p.fullName === "Jalen Suggs");
  assert.equal(suggs?.injuryStatus, "Out");
});

test("ESPN shape change fails loudly instead of writing bad data", async () => {
  restore = installFetch(() => json({ notEvents: [] })).restore;
  await assert.rejects(espn.getGames("2026-11-13"), /missing events/);
});

test("Kalshi listMarkets follows pagination cursors", async () => {
  const pages: Record<string, unknown> = {
    "": { markets: [{ ticker: "A" }], cursor: "p2" },
    p2: { markets: [{ ticker: "B" }], cursor: "p3" },
    p3: { markets: [{ ticker: "C" }], cursor: "" },
  };
  const m = installFetch((url) => json(pages[url.searchParams.get("cursor") ?? ""]));
  restore = m.restore;
  const markets = await kalshi.listMarkets("KXNBAPTS");
  assert.deepEqual(markets.map((x) => x.ticker), ["A", "B", "C"]);
  assert.equal(m.calls.length, 3);
});
