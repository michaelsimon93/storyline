// Routes for the recorded ESPN responses (Nov 16-17 2026: NY @ TOR). `over` replaces one route by name,
// e.g. { "gamelog-2993874": () => json({}, 503) } or { injuries: () => json(bad) }.

import { fixture, json, type Route } from "./mockFetch.js";

export const espnRoutes = (over: Record<string, () => Response> = {}): Route => (url) => {
  const hit = (k: string) => over[k] ? over[k]!() : undefined;
  const p = url.pathname;
  let m;
  if (url.hostname === "site.api.espn.com") {
    if (p.endsWith("/injuries")) return hit("injuries") ?? json(fixture("espn-injuries.json"));
    if (p.endsWith("/news")) return hit(`news-${url.searchParams.get("team")}`) ?? json(url.searchParams.get("team") === "28" ? fixture("espn-news-28.json") : { articles: [] });
    if ((m = p.match(/\/teams\/(\d+)\/schedule$/))) return hit(`schedule-${m[1]}`) ?? json(fixture("espn-schedule-18.json"));
  }
  if (url.hostname === "site.web.api.espn.com" && (m = p.match(/\/athletes\/(\d+)\/(gamelog)$/))) {
    return hit(`gamelog-${m[1]}`) ?? json(fixture(`espn-gamelog-${m[1]}.json`));
  }
  return undefined;
};
