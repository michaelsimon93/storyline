// Alert messages detailed enough to act on without opening logs first (STO-8).
// One headline (what broke, shown in the Discord notification), then: where and when it
// happened, how long it ran, which pipeline_runs row has the full record, the error with its
// cause chain, and the first few stack frames in our own code.

import { hostname } from "node:os";

export type Severity = "failed" | "warning";
const ICON: Record<Severity, string> = { failed: "🔴", warning: "🟡" };

export interface AlertDetails {
  severity: Severity;
  headline: string;          // e.g. "ingest failed: HTTP 503 for https://…"
  job: string;
  startedAt?: Date;
  error?: unknown;
  note?: string;             // what it means / what to check
}

/** Where the worker is running: Railway's service/environment if set, else the host name. */
export function workerLocation(env = process.env): string {
  const railway = [env.RAILWAY_SERVICE_NAME, env.RAILWAY_ENVIRONMENT_NAME].filter(Boolean).join("/");
  return railway || hostname();
}

const et = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium" }) + " ET";

/** The error, each `cause` beneath it, and up to 4 stack frames from our own source files. */
export function describeError(err: unknown): string[] {
  const lines: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e !== undefined && e !== null && depth < 4; depth++) {
    const label = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    lines.push(depth === 0 ? `error: ${label}` : `caused by: ${label}`);
    e = e instanceof Error ? (e as { cause?: unknown }).cause : undefined;
  }
  const frames = (err instanceof Error ? err.stack ?? "" : "")
    .split("\n")
    .filter((l) => /\/src\//.test(l) && !/node_modules/.test(l))
    .slice(0, 4)
    .map((l) => "  " + l.trim().replace(/\(?[^\s(]*\/(src\/[^\s)]+)\)?/, "($1)"));
  if (frames.length) lines.push("```", ...frames, "```");
  return lines;
}

export function alertText(d: AlertDetails, now = new Date(), env = process.env): string {
  const run = d.error as { pipelineRunId?: number; slateDate?: string } | undefined;
  const lines = [
    `${ICON[d.severity]} **${d.headline}**`,
    `job \`${d.job}\` · ${workerLocation(env)} · ${et(now)}` +
      (d.startedAt ? ` · ran ${((now.getTime() - d.startedAt.getTime()) / 1000).toFixed(1)}s` : ""),
  ];
  if (run?.pipelineRunId) {
    lines.push(`pipeline_runs id ${run.pipelineRunId}` + (run.slateDate ? ` (slate ${run.slateDate})` : ""));
  }
  if (d.error !== undefined) lines.push(...describeError(d.error));
  if (d.note) lines.push(`→ ${d.note}`);
  return lines.join("\n");
}
