// The one "won't play" rule (STO-89) and the strict status union (STO-81). Pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/mockFetch.js";
import { parseInjuryStatus, isWontPlay, isKnownWontPlay, mostSevere, KNOWN_STATUSES, SEEN_IN_REAL_RESPONSES } from "../src/domain/injuryStatus.js";

test("known statuses parse to themselves, case and spacing aside, and keep ESPN's own spelling in raw", () => {
  assert.deepEqual(parseInjuryStatus("Out"), { status: "Out", raw: "Out" });
  assert.deepEqual(parseInjuryStatus(" day-to-day "), { status: "Day-To-Day", raw: " day-to-day " });
  assert.equal(parseInjuryStatus("DOUBTFUL").status, "Doubtful");
});

test("a status we have never seen is Unknown, with the raw string kept, never thrown away", () => {
  assert.deepEqual(parseInjuryStatus("Suspension"), { status: "Unknown", raw: "Suspension" });
  assert.deepEqual(parseInjuryStatus(""), { status: "Unknown", raw: "" });
});

test("won't play: Out, Doubtful and Unknown. Questionable, Probable and Day-To-Day play", () => {
  const w = (s: string) => isWontPlay(parseInjuryStatus(s));
  assert.deepEqual(["Out", "Doubtful", "Suspension"].map(w), [true, true, true]);
  assert.deepEqual(["Questionable", "Probable", "Day-To-Day"].map(w), [false, false, false]);
  assert.equal(isWontPlay(null), false, "no injury entry means healthy");
});

test("a story may only say a player is out when ESPN said so in words we know: Out or Doubtful, never Unknown", () => {
  const k = (s: string) => isKnownWontPlay(parseInjuryStatus(s));
  assert.deepEqual(["Out", "Doubtful"].map(k), [true, true]);
  assert.deepEqual(["Suspension", "Questionable", "Day-To-Day", "Probable"].map(k), [false, false, false, false]);
  assert.equal(isKnownWontPlay(null), false);
  assert.equal(isWontPlay(parseInjuryStatus("Suspension")), true, "Unknown is still skipped for form; it just can't headline a story");
});

test("several injuries: the most severe one is the player's status, whatever order ESPN lists them", () => {
  assert.equal(mostSevere(["Day-To-Day", "Out"])?.status, "Out");
  assert.equal(mostSevere(["Out", "Day-To-Day"])?.status, "Out");
  assert.equal(mostSevere(["Probable", "Questionable"])?.status, "Questionable");
  assert.equal(mostSevere(["Day-To-Day", "Suspension"])?.raw, "Suspension", "Unknown outranks everything that plays");
  assert.equal(mostSevere(["Doubtful", "Suspension"])?.status, "Unknown", "Unknown is treated as at least as bad as Doubtful");
  assert.equal(mostSevere([]), null);
});

test("severity order is locked pair by pair: a swap in SEVERITY must fail a test", () => {
  const worst = (a: string, b: string) => [mostSevere([a, b])?.status, mostSevere([b, a])?.status];
  assert.deepEqual(worst("Questionable", "Doubtful"), ["Doubtful", "Doubtful"]);
  assert.deepEqual(worst("Suspension", "Out"), ["Out", "Out"]);
  assert.deepEqual(worst("Suspension", "Doubtful"), ["Unknown", "Unknown"]);
  assert.deepEqual(worst("Day-To-Day", "Questionable"), ["Questionable", "Questionable"]);
  assert.deepEqual(worst("Probable", "Day-To-Day"), ["Day-To-Day", "Day-To-Day"]);
});

test("blank statuses are not statuses: ESPN gave no designation", () => {
  assert.equal(mostSevere(["", "  "]), null);
  assert.equal(mostSevere(["", "Out"])?.status, "Out");
});

test("SEEN_IN_REAL_RESPONSES is exactly the statuses in the recorded responses, so a guess can't be listed as seen", () => {
  const injuries = (fixture("espn-injuries.json") as any).injuries.flatMap((t: any) => t.injuries.map((i: any) => i.status));
  const roster = (fixture("espn-roster-19.json") as any).athletes.flatMap((a: any) => (a.injuries ?? []).map((i: any) => i.status));
  assert.deepEqual([...new Set([...injuries, ...roster])].sort(), [...SEEN_IN_REAL_RESPONSES].sort());
  for (const s of SEEN_IN_REAL_RESPONSES) assert.ok((KNOWN_STATUSES as readonly string[]).includes(s));
});
