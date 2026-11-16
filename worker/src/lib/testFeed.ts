// The Discord test feed (STO-40): a viewing window on what the backend produced, so Michael can
// see each slate before the web app exists. Not verification: correctness lives in the tests.
//
// On when DISCORD_TEST_WEBHOOK_URL is set. DISCORD_TEST_FEED_ENABLED=false turns it off while
// keeping the URL. Either way the worker says once, at startup, what the feed is doing.

import { WEBHOOK_ENV, postWebhook } from "./notify.js";

export const ENABLED_ENV = "DISCORD_TEST_FEED_ENABLED";
const OFF = new Set(["false", "0", "off", "no"]);

export interface TestFeed {
  /** Post one message. Never throws, never retries. */
  post(content: string): Promise<void>;
}

export function testFeed(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.log): TestFeed {
  const url = env[WEBHOOK_ENV.test];
  const off = OFF.has((env[ENABLED_ENV] ?? "").trim().toLowerCase());
  if (!url || off) {
    log(`discord test feed off (${!url ? `${WEBHOOK_ENV.test} not set` : `${ENABLED_ENV}=${env[ENABLED_ENV]}`})`);
    return { post: async () => {} };
  }
  log("discord test feed on");
  return {
    async post(content) {
      // allowed_mentions: a name or blurb containing "@everyone" must not ping the channel.
      await postWebhook("test", url, { content, allowed_mentions: { parse: [] } }, content.split("\n")[0]!);
    },
  };
}
