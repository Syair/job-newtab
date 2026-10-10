/**
 * Public job-board APIs for Greenhouse, Lever and Ashby. These are the boards
 * companies embed on their own careers pages: unauthenticated, JSON, and meant to
 * be read. Using them instead of scraping keeps builds cheap and within the
 * sites' terms.
 */
import { isRemoteText, matchesLocation, matchesRole, matchesSeniority, normalizeCountry } from "./filter";
import type { AtsKind, CompanySource, JobProfile, JobSource } from "./profile";
import { htmlToText, truncate } from "./text";

/** One listing, normalized across sources. What the agent reads from candidates.json. */
export interface RawJob {
  /** Stable across builds: `greenhouse:figma:5426468004`. */
  id: string;
  source: JobSource;
  company: string;
  /** Website domain, when known, for the logo. */
  companyDomain?: string;
  title: string;
  location: string;
  remote: boolean;
  /** ISO country code when the source states one. */
  country?: string;
  url: string;
  /** ISO 8601, when the source exposes it. */
  postedAt?: string;
  salary?: string;
  department?: string;
  description: string;
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const DESCRIPTION_CHARS = 1200;

// ---------------------------------------------------------------------------
// per-ATS fetch + normalize
// ---------------------------------------------------------------------------

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  content?: string;
  departments?: Array<{ name: string }>;
  offices?: Array<{ name: string; location?: string | null }>;
}

export function normalizeGreenhouse(company: CompanySource, data: { jobs?: GreenhouseJob[] }): RawJob[] {
  return (data.jobs ?? []).map((j) => {
    const label = (j.location?.name ?? "").trim();
    // Some boards label every job "Hybrid" or "In-Office"; the offices say where.
    const offices = (j.offices ?? [])
      .map((o) => (o.location ?? o.name).trim())
      .filter((place) => place && !label.toLowerCase().includes(place.split(",")[0].toLowerCase()));
    const location = offices.length ? `${label} (${[...new Set(offices)].join(" • ")})`.trim() : label;
    return {
      id: `greenhouse:${company.slug}:${j.id}`,
      source: "greenhouse",
      company: j.company_name?.trim() || company.name,
      companyDomain: company.domain,
      title: j.title.trim(),
      location,
      remote: isRemoteText(label),
      url: j.absolute_url,
      postedAt: j.first_published ?? j.updated_at,
      department: j.departments?.[0]?.name,
      description: truncate(htmlToText(j.content ?? ""), DESCRIPTION_CHARS),
    };
  });
}

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  categories?: { location?: string; allLocations?: string[]; team?: string; department?: string };
  descriptionPlain?: string;
  lists?: Array<{ text: string; content: string }>;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export function normalizeLever(company: CompanySource, data: LeverJob[]): RawJob[] {
  return (Array.isArray(data) ? data : []).map((j) => {
    const locations = j.categories?.allLocations?.length
      ? j.categories.allLocations
      : [j.categories?.location ?? ""];
    const location = locations.filter(Boolean).join(" • ");
    const lists = (j.lists ?? []).map((l) => `${l.text}: ${htmlToText(l.content)}`).join("\n");
    return {
      id: `lever:${company.slug}:${j.id}`,
      source: "lever",
      company: company.name,
      companyDomain: company.domain,
      title: j.text.trim(),
      location,
      remote: j.workplaceType === "remote" || isRemoteText(location),
      country: j.country ? normalizeCountry(j.country) : undefined,
      url: j.hostedUrl,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
      salary: formatSalaryRange(j.salaryRange),
      department: j.categories?.department ?? j.categories?.team,
      description: truncate(`${j.descriptionPlain ?? ""}\n${lists}`.trim(), DESCRIPTION_CHARS),
    };
  });
}

function formatSalaryRange(r: LeverJob["salaryRange"]): string | undefined {
  if (!r?.min && !r?.max) return undefined;
  const fmt = (n?: number) => (n ? `${Math.round(n / 1000)}K` : "?");
  const unit = r.interval ? ` ${r.interval.replace("-", " ")}` : "";
  return `${r.currency ?? ""} ${fmt(r.min)}–${fmt(r.max)}${unit}`.trim();
}

interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string; address?: { postalAddress?: { addressCountry?: string } } }>;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  publishedAt?: string;
  department?: string;
  address?: { postalAddress?: { addressCountry?: string } };
  descriptionPlain?: string;
  compensation?: { compensationTierSummary?: string | null; scrapeableCompensationSalarySummary?: string | null };
}

export function normalizeAshby(company: CompanySource, data: { jobs?: AshbyJob[] }): RawJob[] {
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const locations = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(
        (l): l is string => Boolean(l),
      );
      const location = locations.join(" • ");
      const countries = [
        j.address?.postalAddress?.addressCountry,
        ...(j.secondaryLocations ?? []).map((s) => s.address?.postalAddress?.addressCountry),
      ]
        .filter((c): c is string => Boolean(c))
        .map(normalizeCountry);
      return {
        id: `ashby:${company.slug}:${j.id}`,
        source: "ashby",
        company: company.name,
        companyDomain: company.domain,
        title: j.title.trim(),
        location,
        remote: Boolean(j.isRemote) || j.workplaceType === "Remote" || isRemoteText(location),
        // Multi-country postings count as US when any of their locations is.
        country: countries.includes("US") ? "US" : countries[0],
        url: j.jobUrl,
        postedAt: j.publishedAt,
        salary:
          j.compensation?.compensationTierSummary ?? j.compensation?.scrapeableCompensationSalarySummary ?? undefined,
        department: j.department,
        description: truncate(j.descriptionPlain ?? "", DESCRIPTION_CHARS),
      };
    });
}

export function atsApiUrl(company: Pick<CompanySource, "ats" | "slug">): string {
  const slug = encodeURIComponent(company.slug);
  switch (company.ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  }
}

const NORMALIZERS: Record<AtsKind, (c: CompanySource, data: never) => RawJob[]> = {
  greenhouse: normalizeGreenhouse,
  lever: normalizeLever,
  ashby: normalizeAshby,
};

export async function fetchCompanyJobs(company: CompanySource, fetchImpl: FetchLike): Promise<RawJob[]> {
  const res = await fetchImpl(atsApiUrl(company));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as never;
  return NORMALIZERS[company.ats](company, data);
}

// ---------------------------------------------------------------------------
// collection across companies
// ---------------------------------------------------------------------------

export interface CompanyStat {
  company: string;
  ats: AtsKind;
  listed: number;
  matched: number;
  error?: string;
}

export interface CollectOptions {
  fetchImpl: FetchLike;
  /** IDs already shown in an earlier build. They are skipped so each build surfaces new jobs. */
  seenIds?: ReadonlySet<string>;
  /** Drop listings older than this when the source dates them. */
  maxAgeDays?: number;
  /** Cap on candidates handed to the agent. */
  maxCandidates?: number;
  concurrency?: number;
  now?: Date;
}

export const COLLECT_DEFAULTS = {
  // Long-open roles are still open; the seen-id filter keeps them from repeating.
  maxAgeDays: 120,
  maxCandidates: 120,
  concurrency: 6,
} as const;

export function filterForProfile(
  jobs: RawJob[],
  profile: JobProfile,
  opts: { seenIds?: ReadonlySet<string>; maxAgeDays?: number; now?: Date } = {},
): RawJob[] {
  const now = (opts.now ?? new Date()).getTime();
  const maxAgeMs = (opts.maxAgeDays ?? COLLECT_DEFAULTS.maxAgeDays) * 86_400_000;
  return jobs.filter((job) => {
    if (opts.seenIds?.has(job.id)) return false;
    if (job.postedAt) {
      const posted = Date.parse(job.postedAt);
      if (Number.isFinite(posted) && now - posted > maxAgeMs) return false;
    }
    return (
      matchesRole(job.title, profile.roles) &&
      matchesSeniority(job.title, profile.seniority) &&
      matchesLocation(job, profile)
    );
  });
}

export async function collectAtsJobs(
  profile: JobProfile,
  opts: CollectOptions,
): Promise<{ jobs: RawJob[]; stats: CompanyStat[] }> {
  const concurrency = opts.concurrency ?? COLLECT_DEFAULTS.concurrency;
  const queue = [...profile.companies];
  const stats: CompanyStat[] = [];
  const matched: RawJob[] = [];

  const worker = async () => {
    for (let company = queue.shift(); company; company = queue.shift()) {
      try {
        const all = await fetchCompanyJobs(company, opts.fetchImpl);
        const fit = filterForProfile(all, profile, opts);
        matched.push(...fit);
        stats.push({ company: company.name, ats: company.ats, listed: all.length, matched: fit.length });
      } catch (err) {
        stats.push({ company: company.name, ats: company.ats, listed: 0, matched: 0, error: String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  return {
    jobs: capFairly(matched, opts.maxCandidates ?? COLLECT_DEFAULTS.maxCandidates),
    stats: stats.sort((a, b) => a.company.localeCompare(b.company)),
  };
}

const newestFirst = (a: RawJob, b: RawJob) =>
  (Date.parse(b.postedAt ?? "") || 0) - (Date.parse(a.postedAt ?? "") || 0);

/**
 * Take the newest jobs round-robin across companies, so one company with 90
 * matching openings can't crowd out the other picks. Undated listings sort last.
 */
export function capFairly(jobs: RawJob[], max: number): RawJob[] {
  const byCompany = new Map<string, RawJob[]>();
  for (const job of jobs) {
    const list = byCompany.get(job.company) ?? [];
    list.push(job);
    byCompany.set(job.company, list);
  }
  const lists = [...byCompany.values()].map((list) => list.sort(newestFirst));
  const picked: RawJob[] = [];
  for (let round = 0; picked.length < max && lists.some((l) => l.length > round); round++) {
    for (const list of lists) {
      if (picked.length >= max) break;
      if (list[round]) picked.push(list[round]);
    }
  }
  return picked.sort(newestFirst);
}
