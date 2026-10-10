import type { BrowserBridge } from "@job-newtab/agent-core";
import { scrapeUrls } from "./scraper";

/**
 * Loads board search pages in the user's real browser, so LinkedIn and Indeed
 * show what they show a signed-in user. Runs in the service worker, in-process
 * with the agent loop. ATS APIs use the worker's plain `fetch`.
 */
export const browserBridge: BrowserBridge = {
  getPageHtml: ({ urls, loadDelayMs }) => scrapeUrls(urls, { loadDelay: loadDelayMs }),
};
