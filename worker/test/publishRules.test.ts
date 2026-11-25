import { test } from "node:test";
import assert from "node:assert/strict";
import { whyNotPublishable, storylineTypeOf, type LiveMarket } from "../src/domain/publishRules.js";
import { cardEmbed, cardMessages } from "../src/lib/publishText.js";
import type { PublishedCard } from "../src/jobs/publish.js";
import type { CardBlurb, CitedSignal } from "../src/domain/blurbRules.js";

const rules = { bandMin: 25, bandMax: 75, maxChars: 200 };
const story = { gameId: "g1", playerId: "p1" };
const market: LiveMarket = { status: "open", yesAskCents: 50, gameId: "g1", playerId: "p1", strike: 25 };
const sig = (o: Partial<CitedSignal> = {}): CitedSignal => ({ id: 1, source: "espn", kind: "stat", trust: "verified", summary: "s", observedAt: "2026-11-24T12:00:00Z", slateDate: "2026-11-24", via: "own", ...o });
const blurb = (text: string, signals: CitedSignal[] = [sig()]): CardBlurb => ({
  storyId: "1", blurb: text, facts: { level: "full", market: { player: "P", team: "T", opponent: "O", home: true, stat: "points", strike: 25, yesPriceCents: 50 }, signals },
});
const why = (b: CardBlurb, m: LiveMarket | null = market, started = false) => whyNotPublishable(b, story, m ?? undefined, started, rules)?.reason;

test("a clean card passes; the band is inclusive at both edges", () => {
  assert.equal(why(blurb("Hot.")), undefined);
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: 25 }), undefined);
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: 75 }), undefined);
});

test("a line that drifted out of the band, a closed market, a started game or a wrong market is kept off", () => {
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: 24 }), "out_of_band");
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: 76 }), "out_of_band");
  assert.equal(why(blurb("Hot."), { ...market, yesAskCents: null }), "out_of_band");
  assert.equal(why(blurb("Hot."), { ...market, status: "paused" }), "market_closed");
  assert.equal(why(blurb("Hot."), market, true), "game_started");
  assert.equal(why(blurb("Hot."), null), "wrong_market");
  assert.equal(why(blurb("Hot."), { ...market, playerId: "p2" }), "wrong_market");
});

test("a blurb over the limit or empty is kept off", () => {
  assert.equal(why(blurb("x".repeat(201))), "blurb_invalid");
  assert.equal(why(blurb("  ")), "blurb_invalid");
});

test("trust (ADR-024): an unreviewed signal never publishes; an approved post needs its link and its name in the blurb", () => {
  const post = sig({ id: 7, source: "x", kind: "story", trust: "attributed", url: "https://x.com/ShamsCharania/status/1" });
  assert.equal(why(blurb("Per @ShamsCharania, he's back tonight.", [post])), undefined);
  assert.equal(why(blurb("He's back tonight.", [post])), "blurb_invalid");                       // stated as fact, source not named
  assert.equal(why(blurb("Per @ShamsCharania, back.", [{ ...post, url: undefined }])), "blurb_invalid");   // no link to show
  assert.equal(why(blurb("Per @ShamsCharania, back.", [{ ...post, trust: "unreviewed" }])), "blurb_invalid");
});

test("storyline type: known angles map, a new one is 'other' (so a new detector needs no migration)", () => {
  assert.equal(storylineTypeOf("hot_streak"), "hot_streak");
  assert.equal(storylineTypeOf("backup_steps_in"), "injury_opportunity");
  assert.equal(storylineTypeOf("something_new"), "other");
});

const cards = (n: number, signals: CitedSignal[] = [sig()]): PublishedCard[] => Array.from({ length: n }, (_, i) => ({
  cardId: `c${i}`, storyId: `${i}`, playerName: `P${i}`, blurb: `Per @ShamsCharania, P${i} is back.`, facts: blurb("", signals).facts,
  strike: 25, yesPriceCents: 40, noPriceCents: 62, tipOffAt: "2026-11-25T00:30:00Z",
}));

test("#testing deck: one embed per card with market, blurb, Yes %, No %, payout per $1 and tip-off in ET", () => {
  const e = cardEmbed(cards(1)[0]!, "2026-11-24");
  assert.equal(e.title, "P0 · points 25+");
  assert.equal(e.description, "Per @ShamsCharania, P0 is back.");
  const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
  assert.deepEqual(f, { Yes: "40%", No: "62%", "Pays per $1": "Yes $2.50 · No $1.61", "Tip-off": "7:30 PM ET" });   // 00:30Z is 7:30 PM the evening before, EST
  assert.equal(e.footer.text, "Storylines for Tue, Nov 24");
  assert.equal(cardEmbed({ ...cards(1)[0]!, noPriceCents: null }, "2026-11-24").fields[1]!.value, "n/a");
});

test("#testing deck: an approved post's link is shown with its card", () => {
  const post = sig({ trust: "attributed", url: "https://x.com/ShamsCharania/status/1" });
  assert.match(cardEmbed(cards(1, [post])[0]!, "2026-11-24").description, /source: <https:\/\/x\.com\/ShamsCharania\/status\/1>/);
});

test("#testing deck: up to 10 embeds per message, every message headed by the slate day, a short set flagged on the first", () => {
  const msgs = cardMessages(cards(12), "2026-11-24", "**Short: 12 of 15**");
  assert.deepEqual(msgs.map((m) => m.embeds.length), [10, 2]);
  assert.equal(msgs[0]!.content, "**Storylines for Tue, Nov 24** · **Short: 12 of 15**");
  assert.equal(msgs[1]!.content, "**Storylines for Tue, Nov 24**");
  assert.deepEqual(cardMessages([], "2026-11-24"), []);
});

test("#testing deck: long text is clipped and a message never carries more embed text than Discord allows", () => {
  const long = cards(10).map((c) => ({ ...c, playerName: "N".repeat(400), blurb: "b".repeat(3000) }));
  for (const m of cardMessages(long, "2026-11-24")) {
    assert.ok(m.embeds.length >= 1 && m.embeds.length <= 10);
    assert.ok(m.embeds.every((e) => e.title.length <= 256 && e.description.length <= 1500));
    assert.ok(m.embeds.reduce((a, e) => a + e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0), 0) <= 6000);
  }
});

// Attacks: trust is checked as a deny-list, so a stored signal with a trust level publish doesn't know (missing, mis-cased) goes live.
test("trust (ADR-024): a signal whose trust is anything but verified or attributed never publishes", () => {
  assert.equal(why(blurb("Hot.", [sig({ trust: "Unreviewed" as CitedSignal["trust"] })])), "blurb_invalid");
  assert.equal(why(blurb("Hot.", [sig({ trust: undefined as unknown as CitedSignal["trust"] })])), "blurb_invalid");
});

// Attacks: the account is read as the URL's first path segment, so an x.com/i/status link makes any blurb containing "i" pass as "naming the source".
test("trust (ADR-024): an approved post whose link has no account in it can't be named, so it can't publish", () => {
  const post = sig({ id: 7, source: "x", kind: "story", trust: "attributed", url: "https://x.com/i/status/1" });
  assert.equal(why(blurb("He is back tonight.", [post])), "blurb_invalid");
});

// Attacks: "every claim cites a fact" — a full-level blurb whose stored facts cite nothing is publishable today.
test("every claim cites (ADR-014): a full-level blurb with no cited signals is kept off", () => {
  assert.equal(why(blurb("He has scored 40 in three straight.", [])), "blurb_invalid");
});
