// Posting to chat webhooks (Discord). Two channels, each with its own secret URL in the
// environment, so alerts and the test feed can never post to each other's channel (STO-40):
//   alerts  ALERT_WEBHOOK_URL         job failures (STO-8)
//   test    DISCORD_TEST_WEBHOOK_URL  what the backend produced, for Michael to look at
// Only the worker calls Discord (ADR-003).

export type Channel = "alerts" | "test";

export const WEBHOOK_ENV: Record<Channel, string> = {
  alerts: "ALERT_WEBHOOK_URL",
  test: "DISCORD_TEST_WEBHOOK_URL",
};

/**
 * POST a JSON body to a webhook once. Never throws and never retries: a chat post is never
 * worth failing or delaying the job that sent it. Returns whether the webhook accepted it.
 */
export async function postWebhook(channel: Channel, url: string, body: object, logLine: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`${channel} webhook returned ${res.status}: ${logLine}`);
    return res.ok;
  } catch (err) {
    console.error(`${channel} webhook failed (${err instanceof Error ? err.message : err}): ${logLine}`);
    return false;
  }
}
