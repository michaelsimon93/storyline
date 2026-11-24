// blurb-style-guide.md (STO-77) is product copy, but three things about it are code's business: it must load, its banned list
// must be the list the code enforces, and its "good" examples must pass the code's own rules (or the guide would teach the writer
// to write blurbs we then reject).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadStyleGuide } from "../src/sources/styleGuide.js";
import { BANNED_WORDS, checkBlurbs, type BlurbInput } from "../src/domain/blurbRules.js";

const guide = await loadStyleGuide();
const section = (title: string) => guide.split(/^## /m).find((s) => s.startsWith(title)) ?? "";

test("the guide loads from where the worker is deployed (worker/), and says it needs product review", () => {
  assert.match(guide, /^# Blurb style guide/);
  assert.match(guide, /draft for Michael's product review/);
});

test("a missing or empty guide stops the run with a message that names the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guide-"));
  await assert.rejects(loadStyleGuide(pathToFileURL(join(dir, "nope.md"))), /blurb-style-guide\.md could not be read \(ENOENT\)/);
  await writeFile(join(dir, "empty.md"), "  \n");
  await assert.rejects(loadStyleGuide(pathToFileURL(join(dir, "empty.md"))), /blurb-style-guide\.md is empty/);
});

test("the banned words in the guide are exactly the ones the code rejects", () => {
  const listed = section("Banned words").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  assert.deepEqual([...listed].sort(), [...BANNED_WORDS].sort());
});

test("every story type has one good and one bad example, and the three angles the story step produces are covered", () => {
  const types = [...guide.matchAll(/^### (\w+)$/gm)].map((m) => m[1]!);
  assert.deepEqual(types, ["hot_streak", "back_from_injury", "backup_steps_in", "market_only"]);
  for (const t of types) {
    const body = guide.split(new RegExp(`^### ${t}$`, "m"))[1]!.split(/^##/m)[0]!;
    assert.equal((body.match(/^- Good: /gm) ?? []).length, 1, `${t}: one good`);
    assert.equal((body.match(/^- Bad: /gm) ?? []).length, 1, `${t}: one bad`);
  }
});

test("the good examples pass the code's own rules: short, one line, no betting language", () => {
  const good = [...guide.matchAll(/^- Good: "(.+?)"/gm)].map((m) => m[1]!);
  assert.equal(good.length, 4);
  for (const text of good) {
    const input: BlurbInput = { slateDate: "2026-11-24", stories: [{
      storyId: "1", playerName: "x", angle: "x", summary: "x", level: "market_only", signals: [], otherAngleSignals: [],
      market: { player: "x", team: "x", opponent: "x", home: true, stat: "x", strike: 4, yesPriceCents: 48 },
    }] };
    const r = checkBlurbs(input, { blurbs: [{ storyId: "1", blurb: text, signalIds: [] }] }, { maxChars: 200, maxAttempts: 1 });
    const kinds = r.ok ? [] : r.violations.map((v) => v.kind).filter((k) => k !== "market_only_number");   // examples have invented numbers; only form is checked here
    assert.deepEqual(kinds, [], text);
  }
});
