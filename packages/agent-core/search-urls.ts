/**
 * Turns the profile into concrete search-result URLs on LinkedIn and Indeed.
 * These are the only pages the agent ever gets to scrape: the URL list is built
 * here, in code, so a model (or a prompt injection in a scraped page) can't
 * steer the browser somewhere else.
 */
import type { JobBoard, JobProfile } from "./profile";

export interface SearchTarget {
  board: JobBoard;
  role: string;
  /** What the search is scoped to: a metro, "Remote", or "United States". */
  where: string;
  url: string;
}

type Where = { label: string; kind: "metro" | "remote" | "us" };

/**
 * LinkedIn's signed-in search (`/jobs/search-results/`) reads natural-language
 * keywords and drops `location`, `sortBy`, `f_WT` and `f_E` (checked 2026-10),
 * so the place goes into the keywords. Only the posted-within filter survives.
 * Levels are left to the pre-filter and the agent.
 */
function linkedinUrl(role: string, where: Where, freshnessHours: number): string {
  const place =
    where.kind === "metro" ? `in ${where.label}` : where.kind === "remote" ? "remote in United States" : "in United States";
  const params = new URLSearchParams({
    keywords: `${role} ${place}`,
    f_TPR: `r${Math.round(freshnessHours * 3600)}`,
  });
  return `https://www.linkedin.com/jobs/search-results/?${params}`;
}

/** Indeed only accepts these values for `fromage` (days). */
const INDEED_AGES = [1, 3, 7, 14];

function indeedUrl(role: string, where: Where, freshnessHours: number): string {
  const days = INDEED_AGES.find((d) => d * 24 >= freshnessHours) ?? 14;
  const params = new URLSearchParams({
    q: role,
    l: where.kind === "metro" ? where.label : where.kind === "remote" ? "Remote" : "United States",
    fromage: String(days),
    sort: "date",
  });
  return `https://www.indeed.com/jobs?${params}`;
}

export interface BuildSearchOptions {
  /** How far back to look; matches the rebuild interval so nothing falls in a gap. */
  freshnessHours: number;
  /** Hard cap on pages per build — each one is a real browser tab. */
  max: number;
  /**
   * Which slice of the combinations to take when there are more than `max`.
   * Increment it every build and successive builds cover all of them.
   */
  rotation?: number;
}

export const SEARCH_DEFAULTS = { max: 6 } as const;

export function buildSearchTargets(profile: JobProfile, opts: BuildSearchOptions): SearchTarget[] {
  const wheres: Where[] = [
    ...profile.locations.map((label): Where => ({ label, kind: "metro" })),
    ...(profile.remoteOk ? [{ label: "Remote", kind: "remote" } as Where] : []),
    ...(profile.anywhereInUS ? [{ label: "United States", kind: "us" } as Where] : []),
  ];
  const boards = (Object.keys(profile.boards) as JobBoard[]).filter((b) => profile.boards[b]);

  // Interleave so the first few targets already span roles, places and boards.
  const all: SearchTarget[] = [];
  for (let i = 0; i < profile.roles.length * wheres.length; i++) {
    const role = profile.roles[i % profile.roles.length];
    const where = wheres[Math.floor(i / profile.roles.length)];
    for (const board of boards) {
      const url =
        board === "linkedin"
          ? linkedinUrl(role, where, opts.freshnessHours)
          : indeedUrl(role, where, opts.freshnessHours);
      if (!all.some((t) => t.url === url)) all.push({ board, role, where: where.label, url });
    }
  }

  if (all.length <= opts.max) return all;
  const start = ((opts.rotation ?? 0) * opts.max) % all.length;
  return Array.from({ length: opts.max }, (_, i) => all[(start + i) % all.length]);
}
