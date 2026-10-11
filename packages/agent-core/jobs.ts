/**
 * The agent's deliverable (jobs.json) and how it folds into what the extension
 * already knows. The UI is fixed code; the model only supplies data, which is
 * validated here before anything renders it.
 */
import { knownCompanyDomain } from "./companies";
import type { JobSource } from "./profile";
import type { SponsorRecord } from "./sponsors";
import type { VisaSignal } from "./visa";

export const JOB_SOURCES: JobSource[] = ["greenhouse", "lever", "ashby", "linkedin", "indeed"];

export interface Job {
  id: string;
  title: string;
  company: string;
  /** Website domain, for the logo. */
  companyDomain: string | null;
  location: string;
  url: string;
  source: JobSource;
  remote: boolean;
  postedAt: string | null;
  salary: string | null;
  /** 0–100: how well the job fits the profile. The sum of `scoreBreakdown` when there is one. */
  matchScore: number;
  /** The parts of matchScore. Missing on jobs saved before breakdowns existed. */
  scoreBreakdown?: ScoreBreakdown | null;
  /** Why it fits, in short phrases tied to the resume or preferences. */
  matchReasons: string[];
  /** Possible dealbreakers: seniority mismatch, sponsorship, on-site requirement. */
  concerns: string[];
  /** The agent's one-sentence take for this person. Missing on jobs saved before takes existed. */
  take?: string;
  /** What the posting says about visas. Set only when the profile needs sponsorship. */
  visa?: VisaSignal[];
  /** The employer's H-1B and PERM filings. Set only when the profile needs sponsorship. */
  sponsor?: SponsorRecord;
}

/**
 * How the fit score is made. The agent judges role, skills and location; the code
 * adds freshness from postedAt and does the arithmetic, so the total always
 * matches its parts.
 */
export interface ScoreBreakdown {
  /** Title, function and level against the target roles. */
  role: number;
  /** Resume against the description. Null when there is no resume. */
  skills: number | null;
  /** Place and work setup against the profile. */
  location: number;
  /** From postedAt: newer postings get more. */
  freshness: number;
  /** The stated preference or dealbreaker the job breaks; caps the total. */
  dealbreaker: string | null;
}

/** The most each part can add. They sum to 100. */
export const SCORE_MAX = { role: 40, skills: 35, location: 15, freshness: 10 } as const;

/** A job that breaks a stated rule never scores above this. */
export const DEALBREAKER_CAP = 29;

/** Points for posting age: fresh openings get fewer applicants ahead of you. */
export function freshnessPoints(postedAt: string | null, now: Date): number {
  const t = postedAt ? Date.parse(postedAt) : NaN;
  if (!Number.isFinite(t)) return 5;
  const days = (now.getTime() - t) / 86_400_000;
  if (days <= 1) return 10;
  if (days <= 3) return 8;
  if (days <= 7) return 6;
  if (days <= 14) return 4;
  if (days <= 30) return 2;
  return 0;
}

/**
 * The total from its parts. Without a resume there is no skills part, so the
 * other three are scaled up to 100 rather than capped at 65.
 */
export function totalScore(b: ScoreBreakdown): number {
  const rest = b.role + b.location + b.freshness;
  const total =
    b.skills === null ? Math.round((rest * 100) / (100 - SCORE_MAX.skills)) : rest + b.skills;
  const clamped = Math.max(0, Math.min(100, total));
  return b.dealbreaker ? Math.min(clamped, DEALBREAKER_CAP) : clamped;
}

const clampPart = (v: unknown, max: number): number | null => {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : null;
};

/** The agent's `score` object plus computed freshness, or null when it is missing or malformed. */
function parseBreakdown(raw: unknown, postedAt: string | null, dealbreaker: string, now: Date): ScoreBreakdown | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const role = clampPart(s.role, SCORE_MAX.role);
  const location = clampPart(s.location, SCORE_MAX.location);
  if (role === null || location === null) return null;
  return {
    role,
    skills: clampPart(s.skills, SCORE_MAX.skills),
    location,
    freshness: freshnessPoints(postedAt, now),
    dealbreaker: dealbreaker || null,
  };
}

export interface JobsFile {
  /** One or two sentences: what's new today and what to apply to first. */
  summary: string;
  jobs: Job[];
}

/** The latest build as the extension stores it. */
export interface LastBuild {
  timestamp: string;
  summary: string;
  /** Jobs this build found for the first time. */
  added: string[];
}

/** A job as stored by the extension, with bookkeeping across builds. */
export interface StoredJob extends Job {
  firstSeen: string;
  lastSeen: string;
}

/** What the user has done with a job. No entry means unreviewed. */
export type JobStatus = "saved" | "applied" | "interviewing" | "offer" | "rejected" | "dismissed";

export const PIPELINE_STATUSES: JobStatus[] = ["saved", "applied", "interviewing", "offer", "rejected"];

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * A stable ID for a job, so the same posting found again tomorrow is recognized.
 * ATS jobs already carry one (`greenhouse:figma:123`); board jobs derive one from
 * the posting's ID in the URL.
 */
export function jobKey(job: { id?: string; url: string }): string {
  if (job.id && /^(greenhouse|lever|ashby|linkedin|indeed):/.test(job.id)) return job.id;
  let url: URL;
  try {
    url = new URL(job.url);
  } catch {
    return job.url;
  }
  const linkedin = url.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/);
  if (url.hostname.endsWith("linkedin.com") && linkedin) return `linkedin:${linkedin[1]}`;
  const linkedinParam = url.searchParams.get("currentJobId");
  if (url.hostname.endsWith("linkedin.com") && linkedinParam) return `linkedin:${linkedinParam}`;
  const jk = url.searchParams.get("jk") ?? url.searchParams.get("vjk");
  if (url.hostname.endsWith("indeed.com") && jk) return `indeed:${jk}`;
  return `${url.hostname}${url.pathname}`.replace(/\/$/, "").toLowerCase();
}

/** Same company + same title = the same opening, even when found on two sites. */
function sameOpeningKey(job: Pick<Job, "company" | "title">): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${norm(job.company)}|${norm(job.title)}`;
}

/** Direct ATS links beat aggregator links: they go straight to the application. */
function sourceRank(source: JobSource): number {
  return source === "linkedin" || source === "indeed" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const JSON_FENCE = /```(?:json)?\s*\n([\s\S]*?)```/;

export interface ParsedJobs {
  file: JobsFile;
  /** Entries that failed validation, with the reason — logged, never rendered. */
  dropped: string[];
}

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown, maxItems: number): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, 200)).filter(Boolean).slice(0, maxItems) : [];

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** "https://www.Figma.com/careers" or "figma.com" → "figma.com"; anything else → null. */
export function cleanDomain(value: unknown): string | null {
  const text = str(value, 200).toLowerCase();
  if (!text) return null;
  let host = text;
  try {
    host = new URL(text.includes("://") ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  return DOMAIN.test(host) ? host : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Parse and validate the agent's jobs.json. Throws only when nothing usable came back. */
export function parseJobsFile(text: string, now: Date = new Date()): ParsedJobs {
  const fenced = text.match(JSON_FENCE);
  let data: unknown;
  try {
    data = JSON.parse((fenced ? fenced[1] : text).trim());
  } catch (err) {
    throw new Error(`jobs.json is not valid JSON: ${String(err)}`);
  }
  const root = (Array.isArray(data) ? { jobs: data } : data) as { summary?: unknown; jobs?: unknown };
  if (!root || !Array.isArray(root.jobs)) throw new Error("jobs.json has no jobs array");

  const dropped: string[] = [];
  const jobs: Job[] = [];
  const seen = new Set<string>();

  for (const [i, raw] of (root.jobs as Record<string, unknown>[]).entries()) {
    const title = str(raw?.title, 200);
    const company = str(raw?.company, 120);
    const url = str(raw?.url, 2000);
    if (!title || !company) {
      dropped.push(`#${i}: missing title or company`);
      continue;
    }
    if (!isHttpUrl(url)) {
      dropped.push(`#${i} ${title}: invalid url "${url.slice(0, 80)}"`);
      continue;
    }
    const source = JOB_SOURCES.includes(raw.source as JobSource) ? (raw.source as JobSource) : guessSource(url);
    const id = jobKey({ id: str(raw.id, 200), url });
    if (seen.has(id)) continue;
    seen.add(id);

    const postedAt = str(raw.postedAt, 40) || null;
    const dealbreaker = str(raw.dealbreaker, 200);
    const breakdown = parseBreakdown(raw.score, postedAt, dealbreaker, now);
    // Older prompts sent only a total; keep accepting it.
    const legacy = clampPart(raw.matchScore, 100) ?? 0;
    let concerns = strList(raw.concerns, 3);
    if (dealbreaker && !concerns.includes(dealbreaker)) concerns = [dealbreaker, ...concerns].slice(0, 3);
    jobs.push({
      id,
      title,
      company,
      companyDomain: knownCompanyDomain(company) ?? cleanDomain(raw.companyDomain),
      location: str(raw.location, 200),
      url,
      source,
      remote: raw.remote === true,
      postedAt,
      salary: str(raw.salary, 120) || null,
      matchScore: breakdown ? totalScore(breakdown) : dealbreaker ? Math.min(legacy, DEALBREAKER_CAP) : legacy,
      scoreBreakdown: breakdown,
      matchReasons: strList(raw.matchReasons, 4),
      concerns,
      take: str(raw.take, 240),
    });
  }

  jobs.sort((a, b) => b.matchScore - a.matchScore);
  return { file: { summary: str(root.summary, 1200), jobs }, dropped };
}

function guessSource(url: string): JobSource {
  if (/linkedin\.com/.test(url)) return "linkedin";
  if (/indeed\.com/.test(url)) return "indeed";
  if (/lever\.co/.test(url)) return "lever";
  if (/ashbyhq\.com/.test(url)) return "ashby";
  return "greenhouse";
}

// ---------------------------------------------------------------------------
// merging builds
// ---------------------------------------------------------------------------

export const RETENTION_DAYS = 30;

/**
 * Fold a build's jobs into the stored set. Re-found jobs keep their firstSeen;
 * the same opening found on a board and on the company's ATS is kept once,
 * preferring the direct ATS link. Unreviewed jobs not seen for RETENTION_DAYS
 * are dropped; anything the user acted on is kept.
 */
export function mergeJobs(
  stored: Record<string, StoredJob>,
  incoming: Job[],
  opts: { now: Date; statuses: Record<string, JobStatus | undefined> },
): {
  jobs: Record<string, StoredJob>;
  added: string[];
  /** Incoming id → the id it is stored under, where they differ (cross-source twins). */
  idMap: Record<string, string>;
} {
  const nowIso = opts.now.toISOString();
  const next: Record<string, StoredJob> = { ...stored };
  const byOpening = new Map<string, string>();
  for (const job of Object.values(next)) byOpening.set(sameOpeningKey(job), job.id);

  const added: string[] = [];
  const idMap: Record<string, string> = {};
  for (const job of incoming) {
    const existing = next[job.id];
    if (existing) {
      next[job.id] = { ...existing, ...job, firstSeen: existing.firstSeen, lastSeen: nowIso };
      continue;
    }

    const twinId = byOpening.get(sameOpeningKey(job));
    const twin = twinId ? next[twinId] : undefined;
    if (twin) {
      const replaceTwin = sourceRank(job.source) < sourceRank(twin.source) && !opts.statuses[twin.id];
      if (!replaceTwin) {
        next[twin.id] = { ...twin, take: job.take || twin.take, lastSeen: nowIso };
        idMap[job.id] = twin.id;
        continue;
      }
      delete next[twin.id];
      next[job.id] = { ...job, firstSeen: twin.firstSeen, lastSeen: nowIso };
      byOpening.set(sameOpeningKey(job), job.id);
      continue;
    }

    next[job.id] = { ...job, firstSeen: nowIso, lastSeen: nowIso };
    byOpening.set(sameOpeningKey(job), job.id);
    added.push(job.id);
  }

  const cutoff = opts.now.getTime() - RETENTION_DAYS * 86_400_000;
  for (const [id, job] of Object.entries(next)) {
    const status = opts.statuses[id];
    const tracked = status && status !== "dismissed";
    if (!tracked && Date.parse(job.lastSeen) < cutoff) delete next[id];
  }

  return { jobs: next, added, idMap };
}
