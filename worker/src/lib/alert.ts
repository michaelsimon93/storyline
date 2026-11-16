// Failure alerts, so a broken job isn't silent (STO-8).
// Posts to a chat webhook. The URL is a secret, so it lives in the environment, not app_config.
// The payload carries both `content` (Discord) and `text` (Slack), so either works.

import { WEBHOOK_ENV, postWebhook } from "./notify.js";

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

export function webhookAlert(url = process.env[WEBHOOK_ENV.alerts]): Alert {
  return async (message) => {
    const line = formatAlert(message);
    if (!url) {
      console.error(`${line} (${WEBHOOK_ENV.alerts} not set; logged only)`);
      return;
    }
    // Never let a failed alert take down the worker: postWebhook logs and moves on.
    await postWebhook("alerts", url, { content: line, text: line }, line);
  };
}
