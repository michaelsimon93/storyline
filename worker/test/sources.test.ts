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

test("ESPN roster: a player with several injuries gets the most severe, not the first listed (STO-90)", async () => {
  restore = installFetch(() => json({ athletes: [
    { id: "1", fullName: "Two Injuries", injuries: [{ status: "Day-To-Day" }, { status: "Out" }] },
    { id: "2", fullName: "Healthy", injuries: [] },
    { id: "3", fullName: "Blank", injuries: [{ status: "" }] },
  ] })).restore;
  const roster = await espn.getRoster("19");
  assert.deepEqual(roster.map((p) => p.injuryStatus), ["Out", null, null]);
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

test("Kalshi listMarkets returns a market once when pages overlap, keeping the later copy", async () => {
  const pages: Record<string, unknown> = {
    "": { markets: [{ ticker: "A", status: "active" }, { ticker: "B" }], cursor: "p2" },
    p2: { markets: [{ ticker: "A", status: "closed" }, { ticker: "C" }], cursor: "" },
  };
  restore = installFetch((url) => json(pages[url.searchParams.get("cursor") ?? ""])).restore;
  const markets = await kalshi.listMarkets("KXNBAPTS");
  assert.deepEqual(markets.map((x) => x.ticker), ["A", "B", "C"]);
  assert.equal(markets[0]!.status, "closed");
});

test("kalshiSource is the MarketSource over listMarkets and getMarkets", async () => {
  const m = installFetch((url) =>
    url.searchParams.has("tickers")
      ? json({ markets: [{ ticker: "T1" }, { ticker: "T2" }] })
      : json({ markets: [{ ticker: "A" }], cursor: "" }));
  restore = m.restore;
  assert.equal(kalshi.kalshiSource.name, kalshi.SOURCE);
  assert.deepEqual((await kalshi.kalshiSource.listOpen("KXNBAPTS")).map((x) => x.ticker), ["A"]);
  assert.deepEqual((await kalshi.kalshiSource.getByIds(["T1", "T2"])).map((x) => x.ticker), ["T1", "T2"]);
});
