// Replace global fetch with a router over recorded fixtures. Any URL without a
// route fails the test, so tests can never silently reach the network.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

export type Route = (url: URL) => Response | undefined;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function installFetch(...routes: Route[]): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    for (const r of routes) {
      const res = r(url);
      if (res) return res;
    }
    throw new Error(`Unmocked fetch: ${url.href}`);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Routes for the recorded Nov 13 2026 MIL @ ORL slate. */
export const slateRoutes: Route = (url) => {
  if (url.hostname === "site.api.espn.com") {
    if (url.pathname.endsWith("/scoreboard")) return json(fixture("espn-scoreboard-20261113.json"));
    const roster = url.pathname.match(/\/teams\/(\d+)\/roster$/);
    if (roster) return json(fixture(`espn-roster-${roster[1]}.json`));
  }
  if (url.hostname === "external-api.kalshi.com" && url.pathname.endsWith("/markets")) {
    return json(fixture(`kalshi-${url.searchParams.get("series_ticker")}.json`));
  }
  return undefined;
};
