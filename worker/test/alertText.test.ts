import { test } from "node:test";
import assert from "node:assert/strict";
import { alertText, describeError, workerLocation } from "../src/lib/alertText.js";
import { HttpError } from "../src/lib/http.js";

const now = new Date("2026-11-13T21:12:05Z"); // 4:12:05 PM ET

test("a failure alert says what broke, where, when, how long, and which run", () => {
  const err = Object.assign(new HttpError(503, "https://api.elections.kalshi.com/x", "upstream down"),
    { pipelineRunId: 42, slateDate: "2026-11-13" });
  const text = alertText({ severity: "failed", job: "ingest", headline: "ingest failed: HTTP 503",
    error: err, startedAt: new Date(now.getTime() - 3_200) }, now, { RAILWAY_SERVICE_NAME: "worker", RAILWAY_ENVIRONMENT_NAME: "production" });
  const lines = text.split("\n");

  assert.equal(lines[0], "🔴 **ingest failed: HTTP 503**", "headline first: it's what the notification shows");
  assert.match(lines[1]!, /job `ingest` · worker\/production · Nov 13, 2026, 4:12:05\s?PM ET · ran 3\.2s/);
  assert.equal(lines[2], "pipeline_runs id 42 (slate 2026-11-13)");
  assert.match(text, /error: Error: HTTP 503 for https:\/\/api\.elections\.kalshi\.com\/x: upstream down/);
});

test("stack frames point at lines in our own code, not node_modules or tests", async () => {
  const { validateSchedules } = await import("../src/scheduler.js");
  let err: unknown;
  try { validateSchedules({ ingest: "every morning" }); } catch (e) { err = e; }
  const text = describeError(err).join("\n");
  assert.match(text, /\(src\/scheduler\.ts:\d+:\d+\)/);
  assert.doesNotMatch(text, /node_modules|\/test\//);
});

test("the cause chain is shown, so a wrapped error isn't a dead end", () => {
  const root = new Error("connect ECONNREFUSED 10.0.0.5:5432");
  const lines = describeError(new Error("could not load config", { cause: root }));
  assert.equal(lines[0], "error: Error: could not load config");
  assert.equal(lines[1], "caused by: Error: connect ECONNREFUSED 10.0.0.5:5432");
});

test("non-Error throws and warnings without an error still produce a readable alert", () => {
  assert.deepEqual(describeError("boom"), ["error: boom"]);
  const text = alertText({ severity: "warning", job: "ingest", headline: "ingest skipped", note: "check for a stuck run" }, now, {});
  assert.match(text, /^🟡 \*\*ingest skipped\*\*\njob `ingest` · .+ ET\n→ check for a stuck run$/);
});

test("location falls back to the host name outside Railway", () => {
  assert.ok(workerLocation({}).length > 0);
  assert.equal(workerLocation({ RAILWAY_SERVICE_NAME: "worker" }), "worker");
});
