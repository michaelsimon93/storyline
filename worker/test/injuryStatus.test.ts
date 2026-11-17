// The one "won't play" rule (STO-89) and the strict status union (STO-81). Pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInjuryStatus, isWontPlay, mostSevere, KNOWN_STATUSES, SEEN_IN_REAL_RESPONSES } from "../src/domain/injuryStatus.js";

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

test("several injuries: the most severe one is the player's status, whatever order ESPN lists them", () => {
  assert.equal(mostSevere(["Day-To-Day", "Out"])?.status, "Out");
  assert.equal(mostSevere(["Out", "Day-To-Day"])?.status, "Out");
  assert.equal(mostSevere(["Probable", "Questionable"])?.status, "Questionable");
  assert.equal(mostSevere(["Day-To-Day", "Suspension"])?.raw, "Suspension", "Unknown outranks everything that plays");
  assert.equal(mostSevere(["Doubtful", "Suspension"])?.status, "Unknown", "Unknown is treated as at least as bad as Doubtful");
  assert.equal(mostSevere([]), null);
});

test("blank statuses are not statuses: ESPN gave no designation", () => {
  assert.equal(mostSevere(["", "  "]), null);
  assert.equal(mostSevere(["", "Out"])?.status, "Out");
});

test("the list of statuses seen in real responses is a subset of the union, and says what is only a guess", () => {
  for (const s of SEEN_IN_REAL_RESPONSES) assert.ok((KNOWN_STATUSES as readonly string[]).includes(s));
  assert.deepEqual([...SEEN_IN_REAL_RESPONSES].sort(), ["Day-To-Day", "Out"]);
});
