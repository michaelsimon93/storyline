// Fetch JSON with a timeout, and back off on rate limits (429) and transient 5xx.
// Kalshi rate-limits after a handful of rapid calls, so every external call goes
// through here.

export class HttpError extends Error {
  constructor(public status: number, public url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

export interface FetchOptions {
  retries?: number;     // attempts after the first
  timeoutMs?: number;
  baseDelayMs?: number; // first backoff delay; doubles each retry
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { retries = 4, timeoutMs = 20_000, baseDelayMs = 1_000 } = opts;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "storyline-worker/0.1", Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new HttpError(res.status, url, await res.text().catch(() => ""));
    }

    // Respect Retry-After when present, otherwise exponential backoff.
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : baseDelayMs * 2 ** attempt;
    await sleep(delay);
  }
}

/** Space out sequential calls to a rate-limited API. */
export function throttle(minIntervalMs: number) {
  let last = 0;
  return async () => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}
