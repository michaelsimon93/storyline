import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dollarsToCents, gameKey, kalshiDateCode, parseMarket, playerNameFromTitle, playerTeamFromTicker,
  splitTicker, strikeFromMarket,
} from "../src/domain/kalshiParse.js";
import { kalshiFromEspn, NBA_TEAMS } from "../src/domain/nbaTeams.js";
import { matchPlayer, normalizeName } from "../src/domain/names.js";

test("kalshi date code and game key", () => {
  assert.equal(kalshiDateCode("2026-11-13"), "26NOV13");
  assert.equal(kalshiDateCode("2027-01-05"), "27JAN05");
  assert.equal(gameKey("26NOV13", "MIL", "ORL"), "26NOV13MILORL");
});

test("ticker parsing", () => {
  const t = "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25";
  assert.deepEqual(splitTicker(t), { series: "KXNBAPTS", gameKey: "26NOV13MILORL", rest: ["ORLABLACK0", "25"] });
  assert.equal(playerTeamFromTicker(t), "ORL");
  assert.equal(playerNameFromTitle("Anthony Black: 25+ points"), "Anthony Black");
  assert.equal(playerNameFromTitle("Myles Turner: 10+ combined points, rebounds, and assists"), "Myles Turner");
});

test("prices and strikes", () => {
  assert.equal(dollarsToCents("0.4300"), 43);
  assert.equal(dollarsToCents("0.0050"), 1);
  assert.equal(dollarsToCents(""), null);
  assert.equal(dollarsToCents(undefined), null);
  assert.equal(strikeFromMarket({ floor_strike: 24.5, strike_type: "greater" }), 25);
  assert.equal(strikeFromMarket({ floor_strike: 2.5, strike_type: "greater" }), 3);
  assert.equal(strikeFromMarket({ floor_strike: null }), null);
});

test("team map covers all 30 teams, both directions", () => {
  assert.equal(NBA_TEAMS.length, 30);
  assert.equal(new Set(NBA_TEAMS.map((t) => t.kalshi)).size, 30);
  assert.equal(new Set(NBA_TEAMS.map((t) => t.espn)).size, 30);
  assert.equal(kalshiFromEspn("NY"), "NYK");
  assert.equal(kalshiFromEspn("UTAH"), "UTA");
  assert.equal(kalshiFromEspn("WSH"), "WAS");
  assert.throws(() => kalshiFromEspn("XYZ"));
});

test("name normalization", () => {
  assert.equal(normalizeName("Nikola Jokić"), "nikola jokic");
  assert.equal(normalizeName("Jaren Jackson Jr."), "jaren jackson");
  assert.equal(normalizeName("T.J. McConnell"), "tj mcconnell");
  assert.equal(normalizeName("Royce O'Neale"), "royce oneale");
  assert.equal(normalizeName("Shai Gilgeous-Alexander"), "shai gilgeous alexander");
  assert.equal(normalizeName("Gary Trent Jr"), "gary trent");
});

test("player matching", () => {
  const roster = [
    { espnId: "1", fullName: "Jaren Jackson Jr." },
    { espnId: "2", fullName: "Nicolas Claxton" },
    { espnId: "3", fullName: "Jalen Williams" },
    { espnId: "4", fullName: "Jaylin Williams" },
  ];
  assert.deepEqual(matchPlayer("Jaren Jackson", roster), { kind: "exact", player: roster[0] });
  assert.deepEqual(matchPlayer("Nic Claxton", roster), { kind: "fuzzy", player: roster[1] });
  assert.equal(matchPlayer("J. Williams", roster).kind, "ambiguous"); // two J. Williams: never guess
  assert.equal(matchPlayer("Nobody Here", roster).kind, "none");
});

test("a Kalshi quote becomes integer cents and a whole-number volume, and never carries a result", async () => {
  const { marketQuote } = await import("../src/domain/kalshiParse.js");
  assert.deepEqual(marketQuote({
    yes_bid_dollars: "0.4300", yes_ask_dollars: "0.4500", no_bid_dollars: "0.5500", no_ask_dollars: "0.5700",
    volume_fp: "1234.00", status: "active",
  }), { yes_bid: 43, yes_ask: 45, no_bid: 55, no_ask: 57, volume: 1234, status: "open" });
  // Kalshi's result is ignored even when present: settlement owns results (STO-13, ADR-004).
  const settled = marketQuote({ status: "finalized", result: "yes" } as { status: string });
  assert.equal("result" in settled, false);
  assert.equal(settled.yes_bid, null, "missing prices stay null, not 0");
  assert.equal(settled.volume, 0);
});

test("Kalshi's lifecycle maps to our four statuses; only finalized counts as settled", async () => {
  const { marketStatus } = await import("../src/domain/kalshiParse.js");
  const mapped = Object.fromEntries(
    ["active", "initialized", "inactive", "closed", "determined", "disputed", "amended", "finalized", "settled"]
      .map((k) => [k, marketStatus(k).status]));
  assert.deepEqual(mapped, {
    active: "open", initialized: "paused", inactive: "paused",
    closed: "closed", determined: "closed", disputed: "closed", amended: "closed",   // result may still change
    finalized: "settled", settled: "settled",
  });
  assert.equal(marketStatus("active").unknown, undefined);
});

test("an unknown Kalshi status is treated as paused and flagged", async () => {
  const { marketStatus } = await import("../src/domain/kalshiParse.js");
  assert.deepEqual(marketStatus("halted_for_review"), { status: "paused", unknown: "halted_for_review" });
  assert.deepEqual(marketStatus(""), { status: "paused", unknown: "" });
  for (const builtin of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.deepEqual(marketStatus(builtin), { status: "paused", unknown: builtin }, builtin);
  }
});

// A real market from the KXNBAPTS fixture; each malformed case below changes one field.
const PROP = {
  ticker: "KXNBAPTS-26NOV13MILORL-ORLABLACK0-25", title: "Anthony Black: 25+ points", status: "active",
  floor_strike: 24.5, strike_type: "greater",
  custom_strike: { basketball_player: "60bb439a-df6a-4fea-8312-4caa6a2c0fbe" },
  yes_bid_dollars: "0.0900", yes_ask_dollars: "0.1100", no_bid_dollars: "0.8900", no_ask_dollars: "0.9100",
  volume_fp: "0.00",
};
const WINNER = { ...PROP, ticker: "KXNBAGAME-26NOV13MILORL-ORL", title: "Milwaukee at Orlando Winner?",
                 floor_strike: undefined, custom_strike: undefined };

test("parseMarket translates a player prop and a game winner", () => {
  const p = parseMarket(PROP, "KXNBAPTS");
  assert.deepEqual(
    { gameKey: p.gameKey, kind: p.kind, team: p.team, player: p.player, stat: p.stat, strike: p.strike },
    { gameKey: "26NOV13MILORL", kind: "player_stat", team: "ORL", stat: "points", strike: 25,
      player: { kalshiId: "60bb439a-df6a-4fea-8312-4caa6a2c0fbe", name: "Anthony Black" } });
  assert.equal(p.quote.yes_ask, 11);
  assert.equal(p.quote.status, "open");

  const w = parseMarket(WINNER, "KXNBAGAME");
  assert.deepEqual({ kind: w.kind, team: w.team, player: w.player, stat: w.stat, strike: w.strike },
                   { kind: "game_winner", team: "ORL", player: null, stat: null, strike: null });
});

test("parseMarket rejects a market it can't store correctly, with the reason", () => {
  const bad = (edit: object, series: string, reason: RegExp) =>
    assert.throws(() => parseMarket({ ...(series === "KXNBAGAME" ? WINNER : PROP), ...edit }, series), reason);
  bad({ custom_strike: undefined }, "KXNBAPTS", /no player id/);
  bad({ custom_strike: {} }, "KXNBAPTS", /no player id/);
  bad({ floor_strike: null }, "KXNBAPTS", /no strike/);
  bad({ title: "25+ points" }, "KXNBAPTS", /No player name/);
  bad({ title: undefined }, "KXNBAPTS", /no title/);
  bad({ ticker: undefined }, "KXNBAPTS", /no ticker/);
  bad({ ticker: "GARBAGE" }, "KXNBAPTS", /Unrecognized ticker/);
  bad({ ticker: "KXNBAPTS-26NOV13MILORL" }, "KXNBAPTS", /No player segment/);
  bad({ status: undefined }, "KXNBAPTS", /no status/);
  bad({ yes_ask_dollars: "1.5000" }, "KXNBAPTS", /price out of range/);
  bad({ no_bid_dollars: "-0.0100" }, "KXNBAGAME", /price out of range/);
  bad({ volume_fp: "lots" }, "KXNBAPTS", /bad volume/);
  bad({ ticker: "KXNBAGAME-26NOV13MILORL" }, "KXNBAGAME", /no team/);
  bad({}, "KXNBAXYZ", /unknown series/);
});

test("parseMarket keeps missing prices as null and unknown statuses as paused (not rejected)", () => {
  const p = parseMarket({ ...PROP, yes_ask_dollars: undefined, status: "brand_new" }, "KXNBAPTS");
  assert.equal(p.quote.yes_ask, null);
  assert.equal(p.quote.status, "paused");
  assert.equal(p.quote.unknown, "brand_new");
});
