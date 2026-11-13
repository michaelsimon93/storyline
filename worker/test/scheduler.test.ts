import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { nextRunEt, validateSchedules } from "../src/scheduler.js";
import { webhookAlert } from "../src/lib/alert.js";
import { installFetch, json } from "./helpers/mockFetch.js";

let restore = () => {};
afterEach(() => restore());

test("schedules are evaluated in ET, across daylight saving", () => {
  // 10:00 ET is 15:00 UTC in winter (EST) and 14:00 UTC in summer (EDT).
  assert.equal(nextRunEt("0 10 * * *", new Date("2026-11-13T12:00:00Z"))?.toISOString(), "2026-11-13T15:00:00.000Z");
  assert.equal(nextRunEt("0 10 * * *", new Date("2026-03-07T12:00:00Z"))?.toISOString(), "2026-03-07T15:00:00.000Z");
  assert.equal(nextRunEt("0 10 * * *", new Date("2026-03-08T12:00:00Z"))?.toISOString(), "2026-03-08T14:00:00.000Z");
});

test("the default ingest schedule runs every 2 hours, 8am to 10pm ET", () => {
  const runs: string[] = [];
  let t = new Date("2026-11-13T05:00:00Z"); // midnight ET
  for (let i = 0; i < 9; i++) {
    t = nextRunEt("0 8-22/2 * * *", t)!;
    runs.push(t.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric" }));
  }
  assert.deepEqual(runs, ["8 AM", "10 AM", "12 PM", "2 PM", "4 PM", "6 PM", "8 PM", "10 PM", "8 AM"]);
});

test("invalid schedules fail at startup, listing every problem", () => {
  assert.doesNotThrow(() => validateSchedules({ ingest: "0 8-22/2 * * *" }));
  assert.throws(
    () => validateSchedules({ ingest: "every morning", curation: "0 25 * * *", ok: "0 10 * * *" }),
    (e: unknown) => e instanceof Error && /ingest/.test(e.message) && /curation/.test(e.message) && !/ok:/.test(e.message));
});

test("alerts post to the webhook with both Discord and Slack fields", async () => {
  let body: any;
  const m = installFetch((url) => (url.hostname === "hooks.test" ? json({ ok: true }) : undefined));
  restore = m.restore;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => { body = JSON.parse(init.body); return original(input, init); }) as typeof fetch;
  await webhookAlert("https://hooks.test/abc")("job ingest failed: boom");
  globalThis.fetch = original;
  assert.equal(m.calls.length, 1);
  assert.match(body.content, /job ingest failed: boom/);
  assert.equal(body.content, body.text);
});

test("an alert never throws, even if the webhook is down or unset", async () => {
  restore = installFetch(() => { throw new Error("network down"); }).restore;
  await assert.doesNotReject(webhookAlert("https://hooks.test/abc")("x"));
  await assert.doesNotReject(webhookAlert("")("x")); // unset: logs only, no fetch
});
