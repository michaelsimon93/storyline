// The X context runner end to end (STO-75 part 1): a recorded Grok response through a mocked fetch, a real Postgres, the real
// migrations. Tier 1 for the write path: which rows are written, trust, and that a re-run changes nothing.
// Acceptance criteria covered here: off by default; report-only stores no signals but lists accounts; unreviewed vs attributed;
// a failed Grok call is reported and curation continues; hard caps; spend in the run summary; re-runs are safe.

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/lib/db.js";
import { runXContext, type XRunResult } from "../src/jobs/contextX.js";
import { contextXJob } from "../src/jobs/index.js";
import { freshDb } from "./helpers/testDb.js";
import { installFetch, json, fixture } from "./helpers/mockFetch.js";
import { story, xaiResponse } from "./helpers/xai.js";

const skip = !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run integration tests";
const DAY = "2026-11-25";
const DET = 1, BOS = 2, DAL = 3, DEN = 4;
const G1 = "e0000000-0000-0000-0000-0000000000a1", G2 = "e0000000-0000-0000-0000-0000000000a2";
const CADE = "e0000000-0000-0000-0000-0000000000b1", JOKIC = "e0000000-0000-0000-0000-0000000000b2";

let db: Db | null = null;
let restore = () => {};
let alerts: string[] = [];
const alert = async (m: string) => { alerts.push(m); };
const q = async <T = any>(sql: string, args: unknown[] = []) => (await db!.query(sql, args)).rows as T[];
const run = (o: { apiKey?: string | undefined } = {}): Promise<XRunResult> => runXContext(db!, { alert, date: DAY, apiKey: "apiKey" in o ? o.apiKey : "k", now: () => new Date(`${DAY}T23:00:00Z`) });
const grok = (body: unknown, status = 200) => installFetch((u) => (u.hostname === "api.x.ai" ? json(body, status) : undefined));
const live = () => q(`update feature_flags set enabled = false where key = 'context_x_report_only'`);
const signals = () => q(`select s.id, s.kind, s.trust, s.key, s.evidence, s.player_id, s.team_id, s.game_id from signals s where source = 'x' order by s.id`);

before(async () => {
  db = await freshDb("storyline_context_x_test");
  if (!db) return;
  await db.query(`
    insert into teams (id, league, name, abbr) values (${DET}, 'nba', 'Detroit Pistons', 'DET'), (${BOS}, 'nba', 'Boston Celtics', 'BOS'),
      (${DAL}, 'nba', 'Dallas Mavericks', 'DAL'), (${DEN}, 'nba', 'Denver Nuggets', 'DEN');
    insert into games (id, league, slate_date, home_team_id, away_team_id, tip_off_at) values
      ('${G1}','nba','${DAY}',${DEN},${DAL},'${DAY}T23:30:00Z'), ('${G2}','nba','${DAY}',${BOS},${DET},'${DAY}T23:00:00Z');
    insert into players (id, league, full_name, team_id) values ('${CADE}','nba','Cade Cunningham',${DET}), ('${JOKIC}','nba','Nikola Jokić',${DEN});
    insert into markets (league, game_id, kind, title, player_id, stat, strike, status) values
      ('nba','${G2}','player_stat','pts','${CADE}','points',20,'open'), ('nba','${G1}','player_stat','pts','${JOKIC}','points',25,'open');`);
});
after(async () => { await db?.end(); });

beforeEach(async () => {
  if (!db) return;
  alerts = [];
  await db.query(`delete from signal_sightings; delete from signals; delete from pipeline_runs; delete from x_accounts;
    update feature_flags set enabled = true where key in ('context_x', 'context_x_report_only');
    update app_config set value = '25' where key = 'x_max_posts_per_run';`);
});
afterEach(() => restore());

const recorded = () => fixture("xai-x-search-stories-2026-11-25.json");

test("flag off (the default): no Grok call, no spend, no run row", { skip }, async () => {
  await db!.query(`update feature_flags set enabled = false where key = 'context_x'`);
  const n = grok(recorded()); restore = n.restore;
  assert.deepEqual(await run(), { status: "off", slateDate: DAY });
  assert.equal(n.calls.length, 0);
  assert.equal((await q(`select count(*)::int n from pipeline_runs`))[0].n, 0);
});

test("report-only (the default state): searches and lists accounts, stores no signals", { skip }, async () => {
  const n = grok(recorded()); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.equal(r.summary.mode, "report_only");
  assert.deepEqual([r.summary.storiesKept, r.summary.dropped.length, r.summary.signalsStored], [3, 2, 0]);
  assert.equal((await signals()).length, 0, "nothing X said can reach curation");
  const accts = await q(`select handle, status from x_accounts order by handle`);
  assert.deepEqual(accts.map((a) => a.handle), ["arbasketball_", "inquirersports", "pulssix"]);
  assert.ok(accts.every((a) => a.status === "unreviewed"), "every account starts unreviewed, however it was cited");
  assert.deepEqual(r.summary.accounts.map((a) => [a.handle, a.storiesCiting]).sort(), [["arbasketball_", 1], ["inquirersports", 1], ["pulssix", 3]]);
});

test("spend is in the run summary: xAI's own counter, and an estimate in dollars", { skip }, async () => {
  const n = grok(recorded()); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.deepEqual(r.summary.spend, { costTicks: 1361488000, usdEstimate: 0.136, postsFetched: 24, searchCalls: 3 });
  const out = (await q(`select outputs from pipeline_runs where job = 'context:x'`))[0].outputs;
  assert.equal(out.spend.costTicks, 1361488000, "on the pipeline_runs record, not only in the post");
});

test("live: posts become signals about our own player, team and game ids; unreviewed accounts stay unreviewed", { skip }, async () => {
  await live();
  const n = grok(recorded()); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.equal(r.summary.mode, "live");
  const sigs = await signals();
  assert.equal(sigs.length, r.summary.signalsStored);
  assert.deepEqual([...new Set(sigs.map((s) => s.trust))], ["unreviewed"]);
  assert.deepEqual([...new Set(sigs.map((s) => (s.team_id ? "team" : s.game_id ? "game" : "player")))].sort(), ["game", "team"]);
  assert.ok(sigs.every((s) => s.kind === "story" && s.evidence.url && s.evidence.handle && s.evidence.quote));
});

test("live: an approved account's post is attributed, and only that account's", { skip }, async () => {
  await live();
  await db!.query(`insert into x_accounts (handle, status) values ('inquirersports', 'approved')`);
  const n = grok(recorded()); restore = n.restore;
  await run();
  const by = Object.fromEntries((await signals()).map((s) => [s.evidence.handle + ":" + s.key, s.trust]));
  assert.equal(by["inquirersports:x:2125471945684660733"], "attributed");
  assert.equal(by["pulssix:x:2125447623779705198"], "unreviewed");
});

test("a re-run is safe: no duplicate signals, ids stay, an approved account stays approved", { skip }, async () => {
  await live();
  await db!.query(`insert into x_accounts (handle, status) values ('pulssix', 'approved')`);
  const n = grok(recorded()); restore = n.restore;
  await run();
  const first = await signals();
  const approvedAt = (await q(`select reviewed_at from x_accounts where handle = 'pulssix'`))[0].reviewed_at;
  await run();
  assert.deepEqual((await signals()).map((s) => s.id), first.map((s) => s.id), "same signals, same ids blurbs cite");
  assert.equal((await q(`select count(*)::int n from x_accounts`))[0].n, 3);
  const a = (await q(`select status, reviewed_at from x_accounts where handle = 'pulssix'`))[0];
  assert.deepEqual([a.status, a.reviewed_at.getTime()], ["approved", approvedAt.getTime()], "seeing an account again never touches the decision");
  assert.deepEqual((await q(`select count(*)::int n from x_accounts where status <> 'approved' and handle <> 'pulssix'`))[0].n, 2);
});

test("a rejected account stays rejected, and its posts are still unreviewed", { skip }, async () => {
  await live();
  await db!.query(`insert into x_accounts (handle, status) values ('pulssix', 'rejected')`);
  const n = grok(recorded()); restore = n.restore;
  await run();
  assert.equal((await q(`select status from x_accounts where handle = 'pulssix'`))[0].status, "rejected");
  assert.ok((await signals()).filter((s) => s.evidence.handle === "pulssix").every((s) => s.trust === "unreviewed"));
});

test("the post cap holds: posts past x_max_posts_per_run are not stored and their accounts are not listed", { skip }, async () => {
  await live();
  await db!.query(`update app_config set value = '2' where key = 'x_max_posts_per_run'`);
  const answer = { stories: [story("Detroit Pistons", "team", [["a", "1", "one"], ["b", "2", "two"]]), story("Nikola Jokić", "player", [["c", "3", "three"]])] };
  const n = grok(xaiResponse(answer)); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.deepEqual([(await signals()).length, r.summary.postsOverCap], [2, 1]);
  assert.deepEqual((await q(`select handle from x_accounts order by handle`)).map((x) => x.handle), ["a", "b"]);
});

test("a player story resolves to our player id", { skip }, async () => {
  await live();
  const n = grok(xaiResponse({ stories: [story("Nikola Jokic", "player", [["a", "9", "Jokic is cooking"]])] })); restore = n.restore;
  await run();
  assert.equal((await signals())[0]!.player_id, JOKIC);
});

test("a failed Grok call is reported and the run ends without X: nothing stored, curation unaffected", { skip }, async () => {
  await live();
  const n = grok({ error: "overloaded" }, 503); restore = n.restore;
  const r = await run();
  assert.equal(r.status, "source_down");
  assert.equal(n.calls.length, 1, "a paid call is not retried");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /context:x/); assert.match(alerts[0]!, /curation goes on without X/);
  assert.equal((await signals()).length, 0);
  assert.equal((await q(`select count(*)::int n from x_accounts`))[0].n, 0);
  assert.equal((await q(`select status from pipeline_runs where job = 'context:x'`))[0].status, "failed", "the outage is on the record");
});

test("an answer we can't read is the same as no answer: reported, nothing stored", { skip }, async () => {
  await live();
  const n = grok(xaiResponse("I could not find anything")); restore = n.restore;
  assert.equal((await run()).status, "source_down");
  assert.equal(alerts.length, 1);
  assert.equal((await signals()).length, 0);
});

test("a missing key is reported and skipped before any call", { skip }, async () => {
  const n = grok(recorded()); restore = n.restore;
  const r = await run({ apiKey: undefined });
  assert.equal(r.status, "no_key");
  assert.equal(n.calls.length, 0);
  assert.match(alerts[0]!, /XAI_API_KEY is not set/);
  assert.equal((await q(`select count(*)::int n from pipeline_runs`))[0].n, 0);
});

test("a missing setting fails the run loudly, names the key, and spends nothing", { skip }, async () => {
  await db!.query(`update app_config set key = 'x_model_gone' where key = 'x_model'`);
  try {
    const n = grok(recorded()); restore = n.restore;
    const r = await run();
    assert.equal(r.status, "config_error");
    assert.equal(n.calls.length, 0);
    assert.match(alerts[0]!, /missing x_model/);
  } finally { await db!.query(`update app_config set key = 'x_model' where key = 'x_model_gone'`); }
});

test("a day with no games makes no call", { skip }, async () => {
  const n = grok(recorded()); restore = n.restore;
  const r = await runXContext(db!, { alert, date: "2026-12-30", apiKey: "k" });
  assert.equal(r.status, "no_games");
  assert.equal(n.calls.length, 0);
});

test("the job posts the account review to #testing and logs counts, not account lists", { skip }, async () => {
  const n = grok(recorded()); restore = n.restore;
  const posted: string[] = [];
  const out = await contextXJob(alert, { post: async (c) => { posted.push(c); } }, DAY, { XAI_API_KEY: " k " }).run(db!) as any;
  assert.match(posted.join("\n"), /@pulssix/);
  assert.match(posted.join("\n"), /Proposed stories \(3\)[\s\S]*Detroit Pistons[\s\S]*from @/);
  assert.match(posted.join("\n"), /handle in \(/);
  assert.deepEqual([out.accounts, out.newAccounts], [3, 3]);
  assert.equal(await contextXJob(alert, { post: async () => { throw new Error("discord down"); } }, DAY, { XAI_API_KEY: "k" }).run(db!).then(() => "ok"), "ok", "a feed failure never fails the run");
});

/** The recorded response with `extra` posts added to its first story (Detroit Pistons), citations left as recorded. */
const recordedWith = (extra: { url: string; handle: string; excerpt: string }[]) => {
  const r = recorded() as { output: { type: string; content?: { text: string }[] }[] };
  const c = r.output.find((o) => o.type === "message")!.content![0]!;
  const answer = JSON.parse(c.text);
  answer.stories[0].posts.push(...extra);
  c.text = JSON.stringify(answer);
  return r;
};

// Attacks "a claim without a post is dropped": the recorded response lists every post the search fetched as url_citations (24 posts
// fetched, 24 citations). A post URL Grok wrote that the search never fetched is a claim with no post behind it, and here it would
// become attributed reporting from an approved account.
test("a post the search never fetched (not among the response's citations) is not stored", { skip }, async () => {
  await live();
  await db!.query(`insert into x_accounts (handle, status) values ('inquirersports', 'approved')`);
  const n = grok(recordedWith([{ url: "https://x.com/inquirersports/status/1999999999999999999", handle: "@inquirersports", excerpt: "Cade Cunningham is out tonight" }]));
  restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.deepEqual((await signals()).filter((s) => s.key === "x:1999999999999999999").map((s) => s.trust), [], "an invented post must not reach curation");
});

// Attacks "status is the only thing that makes a post quotable": rejecting an account that was approved earlier in the day must stop
// its posts being quoted tonight, even if the next run doesn't happen to return the same post (trust is copied onto the signal).
test("rejecting an approved account stops tonight's stored posts from it being attributed", { skip }, async () => {
  await live();
  await db!.query(`insert into x_accounts (handle, status) values ('inquirersports', 'approved')`);
  const n = grok(recorded()); restore = n.restore;
  await run();
  assert.ok((await signals()).some((s) => s.evidence.handle === "inquirersports" && s.trust === "attributed"), "precondition");
  await db!.query(`update x_accounts set status = 'rejected' where handle = 'inquirersports'`);
  restore();
  const n2 = grok(xaiResponse({ stories: [story("Nikola Jokic", "player", [["someone", "42", "Jokic is cooking"]])] })); restore = n2.restore;
  await runXContext(db!, { alert, date: DAY, apiKey: "k", now: () => new Date(`${DAY}T23:30:00Z`) });
  assert.deepEqual((await signals()).filter((s) => s.evidence.handle === "inquirersports").map((s) => s.trust), ["unreviewed"]);
});

// Attacks "a failed Grok call is reported and curation continues": Postgres text can't hold NUL, so an excerpt with \u0000 in Grok's
// JSON makes the run throw a raw database error instead of being dropped or reported as an unreadable answer.
test("a NUL character in a post excerpt doesn't crash the run", { skip }, async () => {
  await live();
  const n = grok(xaiResponse({ stories: [story("Nikola Jokic", "player", [["a", "9", "Jokic\u0000 is cooking"]])] })); restore = n.restore;
  const r = await run().catch((e: Error) => ({ status: `threw: ${e.message}` }));
  assert.ok(r.status === "ok" || r.status === "source_down", r.status);
});

// Follow-up from the eng-lead review: the downgrade must not depend on X being switched on.
test("rejecting an account still withdraws its stored posts after X is switched off", { skip }, async () => {
  await live();
  await db!.query(`insert into x_accounts (handle, status) values ('inquirersports', 'approved')`);
  const n = grok(recorded()); restore = n.restore;
  await run();
  await db!.query(`update x_accounts set status = 'rejected' where handle = 'inquirersports'; update feature_flags set enabled = false where key = 'context_x'`);
  assert.equal((await run()).status, "off");
  assert.deepEqual([...new Set((await signals()).filter((s) => s.evidence.handle === "inquirersports").map((s) => s.trust))], ["unreviewed"]);
});

// ---------------------------------------------------------------- the search over approved accounts (STO-144)

/** Routes api.x.ai: the open search gets `open`, a search limited to handles gets `byHandles`. Records each request body. */
const grokSplit = (open: unknown, byHandles: unknown | ((handles: string[]) => unknown), status = 200) => {
  const bodies: any[] = [];
  const n = installFetch((u) => u.hostname === "api.x.ai" ? json(open, status) : undefined);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const b = JSON.parse(String(init.body)); bodies.push(b);
    const handles: string[] | undefined = b.tools?.[0]?.allowed_x_handles;
    if (!handles) return inner(input, init);
    const body = typeof byHandles === "function" ? byHandles(handles) : byHandles;
    return json(body, body === null ? 503 : 200);
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = inner; n.restore(); } };
};
const approve = (...hs: string[]) => db!.query(`insert into x_accounts (handle, status) select h, 'approved' from unnest($1::text[]) h`, [hs]);
const handleCalls = (bodies: any[]) => bodies.filter((b) => b.tools[0].allowed_x_handles);

test("approved accounts get their own search, limited to their handles; the open search stays unfiltered", { skip }, async () => {
  await approve("zed", "abe");
  const n = grokSplit(xaiResponse({ stories: [] }), xaiResponse({ stories: [] })); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.equal(n.bodies.length, 2);
  assert.deepEqual(n.bodies[0].tools, [{ type: "x_search" }]);
  assert.deepEqual(n.bodies[1].tools, [{ type: "x_search", allowed_x_handles: ["abe", "zed"] }]);
  assert.match(n.bodies[1].input, /@abe, @zed/);
  assert.deepEqual(r.summary.handleSearches, { handles: 2, calls: 1, failed: 0 });
});

test("no approved accounts: only the open search runs", { skip }, async () => {
  const n = grokSplit(xaiResponse({ stories: [] }), xaiResponse({ stories: [] })); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.equal(n.bodies.length, 1);
  assert.deepEqual(r.summary.handleSearches, { handles: 0, calls: 0, failed: 0 });
});

test("an approved account's post is pulled and attributed even when the open search found nothing", { skip }, async () => {
  await live(); await approve("shams");
  const n = grokSplit(xaiResponse({ stories: [] }),
    xaiResponse({ stories: [story("Detroit Pistons", "team", [["shams", "901", "Pistons are shopping a big man"]])] })); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  const sigs = await signals();
  assert.deepEqual(sigs.map((s) => [s.evidence.handle, s.trust]), [["shams", "attributed"]]);
  assert.deepEqual(r.summary.accounts.map((a) => [a.handle, a.status, a.isNew]), [["shams", "approved", false]]);
});

test("the same post from both searches is one signal, and a re-run adds nothing", { skip }, async () => {
  await live(); await approve("shams");
  const both = [story("Detroit Pistons", "team", [["shams", "901", "Pistons are shopping a big man"]])];
  const n = grokSplit(xaiResponse({ stories: both }), xaiResponse({ stories: both })); restore = n.restore;
  await run();
  const first = await signals();
  await run();
  assert.equal(first.length, 1);
  assert.deepEqual((await signals()).map((s) => s.id), first.map((s) => s.id));
});

test("a failed approved-accounts search is reported and the open search's stories still go through", { skip }, async () => {
  await live(); await approve("shams");
  const n = grokSplit(xaiResponse({ stories: [story("Detroit Pistons", "team", [["fan1", "5", "Cade is out"]])] }), null); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.equal((await signals()).length, 1);
  assert.deepEqual(r.summary.handleSearches, { handles: 1, calls: 1, failed: 1 });
  assert.equal(alerts.length, 1); assert.match(alerts[0]!, /approved accounts failed/);
});

test("an unreadable approved-accounts answer is the same: reported, skipped, but its spend is counted", { skip }, async () => {
  await approve("shams");
  const n = grokSplit(xaiResponse({ stories: [] }, { ticks: 100 }), xaiResponse("not json at all", { ticks: 50 })); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.equal(r.summary.handleSearches.failed, 1);
  assert.equal(r.summary.spend.costTicks, 150, "a billed call is counted even when we can't use it");
});

test("handles go to xAI in batches of 10, and x_max_handle_searches caps how many searches one run pays for", { skip }, async () => {
  await approve(...Array.from({ length: 23 }, (_, i) => `acct${String(i).padStart(2, "0")}`));
  await db!.query(`update app_config set value = '2' where key = 'x_max_handle_searches'`);
  const n = grokSplit(xaiResponse({ stories: [] }), xaiResponse({ stories: [] })); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.deepEqual(handleCalls(n.bodies).map((b) => b.tools[0].allowed_x_handles.length), [10, 10]);
  assert.deepEqual(r.summary.handleSearches, { handles: 23, calls: 2, failed: 0 });
  await db!.query(`update app_config set value = '3' where key = 'x_max_handle_searches'`);
});

test("a rejected or unreviewed account is never searched for", { skip }, async () => {
  await db!.query(`insert into x_accounts (handle, status) values ('spam', 'rejected'), ('maybe', 'unreviewed')`);
  await approve("shams");
  const n = grokSplit(xaiResponse({ stories: [] }), xaiResponse({ stories: [] })); restore = n.restore;
  await run();
  assert.deepEqual(handleCalls(n.bodies).map((b) => b.tools[0].allowed_x_handles), [["shams"]]);
});

test("an unreadable open answer doesn't lose the stories the approved-accounts search returned", { skip }, async () => {
  await live(); await approve("shams");
  const n = grokSplit(xaiResponse("not json"), xaiResponse({ stories: [story("Detroit Pistons", "team", [["shams", "901", "Pistons are shopping a big man"]])] })); restore = n.restore;
  const r = await run();
  assert.ok(r.status === "ok");
  assert.deepEqual((await signals()).map((s) => s.evidence.handle), ["shams"]);
});
