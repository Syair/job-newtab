/**
 * Hits the real Greenhouse / Lever / Ashby APIs for every preset company with a
 * sample profile and prints what would be handed to the agent. No API key, no
 * Claude calls, no cost.
 *
 * Run: pnpm ats:smoke [role ...]
 */
import { EMPTY_PROFILE, PRESET_COMPANIES, buildSearchTargets, collectAtsJobs } from "@job-newtab/agent-core";

const roles = process.argv.slice(2).length ? process.argv.slice(2) : ["Software Engineer"];
const profile = {
  ...EMPTY_PROFILE,
  roles,
  seniority: ["mid" as const, "senior" as const],
  locations: ["San Francisco, CA", "New York, NY"],
  remoteOk: true,
  companies: PRESET_COMPANIES,
};

const started = Date.now();
const { jobs, stats } = await collectAtsJobs(profile, { fetchImpl: (url) => fetch(url) });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\nRoles: ${roles.join(", ")} · ${profile.locations.join(", ")} + remote\n`);
for (const s of stats) {
  const status = s.error ? `ERROR ${s.error}` : `${String(s.matched).padStart(3)} of ${s.listed}`;
  console.log(`  ${s.company.padEnd(14)} ${s.ats.padEnd(10)} ${status}`);
}
const failures = stats.filter((s) => s.error);
console.log(`\n${jobs.length} candidates (capped) from ${stats.length} companies in ${seconds}s, ${failures.length} failed.`);
console.log(`candidates.json would be ${(JSON.stringify(jobs, null, 1).length / 1024).toFixed(0)} KB.\n`);
for (const j of jobs.slice(0, 10)) {
  console.log(`  ${j.postedAt?.slice(0, 10) ?? "undated   "}  ${j.company} — ${j.title} (${j.location})`);
}

console.log(`\nBoard searches for the first build:`);
for (const t of buildSearchTargets(profile, { freshnessHours: 24, max: 6 })) {
  console.log(`  ${t.board.padEnd(8)} ${t.role} @ ${t.where}\n           ${t.url}`);
}

process.exit(failures.length === stats.length ? 1 : 0);
