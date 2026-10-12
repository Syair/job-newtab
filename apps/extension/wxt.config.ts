import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // The release asset name the README points to.
  zip: { artifactTemplate: "job-newtab-{{version}}-{{browser}}.zip" },
  manifest: {
    name: "job-newtab",
    description: "A new tab that shows today's best-fit job openings, found and ranked by an agent.",
    // A fixed public key pins the extension ID (fpfpefajbbimpchnhbeldmjjodfagcpj).
    // Unpacked extensions otherwise get an ID from their folder path, so unzipping a
    // new release into a different folder would start with empty storage.
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt302faAzDjA2hghcrnk6dhUVlCjD/Eva9m8YrQrrq4nxDpDpSPuVnjlVCoQTes3cV6Dudiek66OHXKY80cP71c4pjbnuJtzbxHaWT/cEI6n5DcQVUhue9GB0GGHbm57ZIScN8gadMmzf9cN32/efwi81QmCq1XbCGC7cdnqfWTWAFgeUu2mou4wI8wYuBBaYvXbTbP8HWo1eWamqvujNuqSXTEI473lSyoOCC7GR+2A847ebhmvuxD6wYm3zVdjYENMsTk/S8xDSX7/7Pfs0KV4GGs9R8Mj/EpQWKaWXOWKTZhTX3Hsa+utL7fZ4PL7sREY7dhR29egMXBLCk8j5bQIDAQAB",
    permissions: [
      "tabs", //          open LinkedIn / Indeed search pages and watch them load
      "scripting", //     inject the scraper into those pages
      "storage", //       API key, profile, jobs and their statuses
      "alarms", //        heartbeat: scheduled rebuilds + reattach after a worker kill
      "notifications", // surface a failed headless rebuild when no tab is open
    ],
    // Only the sites the extension reads, plus the Anthropic API. No <all_urls>,
    // no browsing history.
    host_permissions: [
      "https://www.linkedin.com/*",
      "https://www.indeed.com/*",
      "https://boards-api.greenhouse.io/*",
      "https://api.lever.co/*",
      "https://api.ashbyhq.com/*",
      "https://api.anthropic.com/*",
      // Employer H-1B / PERM filing records, only when the profile needs sponsorship.
      "https://permtracker.app/*",
    ],
  },
});
