/**
 * End-to-end build against the real API (needs ANTHROPIC_API_KEY in .env).
 * Spends API credits — one agent session.
 *
 * Runs the exact orchestrator the extension runs, with a Node bridge standing in
 * for chrome.tabs: board pages are fetched anonymously (no sign-in), so LinkedIn
 * and Indeed are off by default here. Set BOARDS=1 to include them anyway.
 *
 * Run: pnpm agent:run [role ...]
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  EMPTY_PROFILE,
  PRESET_COMPANIES,
  runJobScout,
  type BrowserBridge,
  type JobProfile,
  type KVStore,
} from "@job-newtab/agent-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join(import.meta.dirname, "out");
const STATE_PATH = join(import.meta.dirname, "..", ".agent-state.json");

/** Agent/environment IDs persist between runs, like chrome.storage in the extension. */
class FileKVStore implements KVStore {
  constructor(private path: string) {}
  private read(): Record<string, unknown> {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }
  async get<T>(key: string) {
    return this.read()[key] as T | undefined;
  }
  async set(key: string, value: unknown) {
    writeFileSync(this.path, JSON.stringify({ ...this.read(), [key]: value }, null, 2));
  }
  async remove(key: string) {
    const data = this.read();
    delete data[key];
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }
}

const nodeBridge: BrowserBridge = {
  fetchPublicText: (url) => fetch(url, { headers: { "user-agent": "Mozilla/5.0 job-newtab harness" } }),
  async getPageHtml({ urls }) {
    const pages = [];
    const failed = [];
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 job-newtab harness" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = (await res.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
        pages.push({ url, title: html.match(/<title>([^<]*)/)?.[1] ?? url, html });
      } catch (err) {
        failed.push({ url, reason: String(err) });
      }
    }
    return { pages, failed };
  },
};

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (put it in .env)");

  const roles = process.argv.slice(2);
  const profile: JobProfile = {
    ...EMPTY_PROFILE,
    roles: roles.length ? roles : ["Software Engineer"],
    seniority: ["mid", "senior"],
    locations: ["San Francisco, CA", "New York, NY"],
    remoteOk: true,
    boards: { linkedin: process.env.BOARDS === "1", indeed: false },
    companies: PRESET_COMPANIES,
    resume: process.env.RESUME_FILE ? readFileSync(process.env.RESUME_FILE, "utf8") : "",
    notes: process.env.NOTES ?? "",
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();
  let lastPhase = "";

  const result = await runJobScout({
    client: new Anthropic({ apiKey }),
    bridge: nodeBridge,
    store: new FileKVStore(STATE_PATH),
    profile,
    model: (process.env.MODEL as never) ?? undefined,
    callbacks: {
      onPhase: (phase, detail) => {
        if (phase !== lastPhase) {
          lastPhase = phase;
          process.stdout.write(`\n\x1b[36m[${phase}]\x1b[0m${detail ? " " + detail : ""}\n`);
        }
      },
      onText: (text) => process.stdout.write(text),
      onLog: (line) => process.stdout.write(`\n\x1b[90m  · ${line}\x1b[0m\n`),
    },
  });

  const out = join(OUT_DIR, "jobs.json");
  writeFileSync(out, JSON.stringify(result.jobs, null, 2));

  console.log("\n\n========== RESULT ==========");
  console.log(`session  : ${result.sessionId}`);
  console.log(`source   : ${result.source}`);
  console.log(`jobs     : ${result.jobs.jobs.length} (${result.dropped.length} dropped by validation)`);
  console.log(`elapsed  : ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`written  : ${out}`);
  console.log(`\n${result.jobs.summary}\n`);
  for (const j of result.jobs.jobs.slice(0, 10)) {
    console.log(`  ${String(j.matchScore).padStart(3)}  ${j.company} — ${j.title}`);
    const b = j.scoreBreakdown;
    if (b) console.log(`         role ${b.role} · skills ${b.skills ?? "—"} · location ${b.location} · freshness ${b.freshness}`);
    for (const r of j.matchReasons) console.log(`         ✓ ${r}`);
    for (const c of j.concerns) console.log(`         ! ${c}`);
  }
  process.exit(result.jobs.jobs.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[run-agent] fatal:", err);
  process.exit(1);
});
