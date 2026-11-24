// The blurb style guide (STO-77, spec §8 "Blurb feedback loop"): a markdown file in the repo that goes into the blurb prompt every
// day, so Michael's feedback is an edit to the file and the next day's blurbs change. It lives in worker/ because the worker is
// deployed from that folder (docs/runbook-deploy.md), so the file ships with the code that reads it.

import { readFile } from "node:fs/promises";

export const STYLE_GUIDE_URL = new URL("../../blurb-style-guide.md", import.meta.url);

/** Reads the guide. A missing or empty file stops the run before any call to Claude: blurbs without a guide would silently drift off-voice. */
export async function loadStyleGuide(url: URL = STYLE_GUIDE_URL): Promise<string> {
  let text: string;
  try { text = await readFile(url, "utf8"); }
  catch (err) { throw new Error(`blurb-style-guide.md could not be read (${(err as NodeJS.ErrnoException).code ?? err}): ${url.pathname}`); }
  if (text.trim() === "") throw new Error(`blurb-style-guide.md is empty: ${url.pathname}`);
  return text;
}
