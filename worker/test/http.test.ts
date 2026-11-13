import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DeadlineError, fetchJson, HttpError, throttle } from "../src/lib/http.js";
import { installFetch, json } from "./helpers/mockFetch.js";

let restore = () => {};
afterEach(() => restore());

function sequence(...responses: (() => Response)[]) {
  let i = 0;
  const m = installFetch(() => responses[Math.min(i++, responses.length - 1)]!());
  restore = m.restore;
  return m;
}

test("returns parsed JSON on success", async () => {
  sequence(() => json({ ok: 1 }));
  assert.deepEqual(await fetchJson("https://x.test/a"), { ok: 1 });
});

test("retries a 429 and then succeeds", async () => {
  const m = sequence(() => json({}, 429), () => json({}, 429), () => json({ ok: 2 }));
  assert.deepEqual(await fetchJson("https://x.test/a", { baseDelayMs: 1 }), { ok: 2 });
  assert.equal(m.calls.length, 3);
});

test("retries a 5xx", async () => {
  const m = sequence(() => json({}, 503), () => json({ ok: 3 }));
  assert.deepEqual(await fetchJson("https://x.test/a", { baseDelayMs: 1 }), { ok: 3 });
  assert.equal(m.calls.length, 2);
});

test("honors Retry-After over exponential backoff", async () => {
  sequence(() => json({}, 429, { "retry-after": "0.05" }), () => json({ ok: 4 }));
  const start = Date.now();
  await fetchJson("https://x.test/a", { baseDelayMs: 5_000 }); // would take 5s if Retry-After were ignored
  const took = Date.now() - start;
  assert.ok(took >= 40 && took < 2_000, `took ${took}ms`);
});

test("does not retry a 404", async () => {
  const m = sequence(() => json({ error: "nope" }, 404));
  await assert.rejects(fetchJson("https://x.test/a", { baseDelayMs: 1 }), (e: unknown) =>
    e instanceof HttpError && e.status === 404);
  assert.equal(m.calls.length, 1);
});

test("gives up after the retry budget", async () => {
  const m = sequence(() => json({}, 429));
  await assert.rejects(fetchJson("https://x.test/a", { retries: 2, baseDelayMs: 1 }), (e: unknown) =>
    e instanceof HttpError && e.status === 429);
  assert.equal(m.calls.length, 3); // first try + 2 retries
});

test("throttle spaces out calls", async () => {
  const pace = throttle(50);
  const start = Date.now();
  await pace(); await pace(); await pace();
  assert.ok(Date.now() - start >= 95);
});

test("a deadline caps the total time: a long Retry-After fails now instead of waiting", async () => {
  sequence(() => json({}, 429, { "retry-after": "30" }), () => json({ ok: 1 }));
  const start = Date.now();
  await assert.rejects(fetchJson("https://x.test/a", { deadlineMs: 2_000 }), (e) =>
    e instanceof DeadlineError && /HTTP 429/.test(e.message) && /2s deadline/.test(e.message));
  assert.ok(Date.now() - start < 500, "gave up immediately rather than sleeping 30s");
});

test("a deadline still allows retries that fit inside it", async () => {
  sequence(() => json({}, 429, { "retry-after": "0.05" }), () => json({ ok: 2 }));
  assert.deepEqual(await fetchJson("https://x.test/a", { deadlineMs: 2_000 }), { ok: 2 });
});

test("the poller gives each poll one interval's worth of time on Kalshi", async () => {
  const { fetchDeadline } = await import("../src/jobs/poller.js");
  assert.deepEqual(fetchDeadline(30), { deadlineMs: 30_000 });
});
