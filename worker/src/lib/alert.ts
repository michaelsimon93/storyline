// Failure alerts, so a broken job isn't silent (STO-8).
// Posts to a chat webhook. The URL is a secret, so it lives in the environment, not app_config.
// The payload carries both `content` (Discord) and `text` (Slack), so either works.

// Discord rejects messages over 2000 chars; a rejected alert would be a silent one.
const MAX_ALERT_CHARS = 1500;

/** Prefix, redact anything that looks like a credential, and truncate. */
export function formatAlert(message: string): string {
  const redacted = message
    .replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/gi, "$1***@")
    .replace(/((?:api[_-]?key|key|token|secret|password)=)[^&\s]+/gi, "$1***");
  const line = `[storyline-worker] ${redacted}`;
  return line.length > MAX_ALERT_CHARS ? `${line.slice(0, MAX_ALERT_CHARS)}… (truncated)` : line;
}

export type Alert = (message: string) => Promise<void>;

export function webhookAlert(url = process.env.ALERT_WEBHOOK_URL): Alert {
  return async (message) => {
    const line = formatAlert(message);
    if (!url) {
      console.error(`${line} (ALERT_WEBHOOK_URL not set; logged only)`);
      return;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: line, text: line }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`alert webhook returned ${res.status}: ${line}`);
    } catch (err) {
      // Never let a failed alert take down the worker; log and move on.
      console.error(`alert webhook failed (${err instanceof Error ? err.message : err}): ${line}`);
    }
  };
}
