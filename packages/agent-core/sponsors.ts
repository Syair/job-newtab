/**
 * An employer's H-1B and PERM filing record, from PERM Tracker (permtracker.app).
 * Its keyless `/v1/lookup/employer` endpoint matches the name a posting prints to
 * a DOL employer and returns decided PERM cases, pending ones from DOL's case
 * status, the newest filing date and the H-1B LCA count.
 *
 * Only company names are sent, and only when the profile needs sponsorship.
 * Results are cached for a week; the terms allow showing them with credit but
 * not copying the dataset, so nothing here is shared beyond this browser.
 */
import type { Job } from "./jobs";
import type { JobProfile } from "./profile";
import type { KVStore } from "./types";
import type { VisaOverride } from "./overrides";
import { blockingSignal, needsH1b, needsSponsorship, wantsGreenCard, type VisaSignal } from "./visa";

export const PERM_TRACKER = {
  name: "PERM Tracker",
  site: "https://permtracker.app",
  lookup: "https://permtracker.app/v1/lookup/employer",
} as const;

export interface SponsorRecord {
  /** The name we asked about, as the posting printed it. */
  query: string;
  /** How PERM Tracker matched it. "possible" means a different legal name it thinks is the same employer. */
  match: "exact" | "possible" | "none";
  /** The employer's name in DOL filings. */
  employer: string | null;
  /** PERM Tracker's page for the employer (or its search), for credit and detail. */
  url: string;
  /** H-1B labor condition applications on record. */
  h1bLcas: number | null;
  perm: {
    /** Decided cases in DOL's published data. */
    decided: number;
    certified: number;
    denied: number;
    /** Filed and not yet decided, from DOL's case status. */
    pending: number;
    /** ISO date of the newest PERM filing seen. */
    newestFiling: string | null;
    filingsLast12Months: number;
  } | null;
  /** Decided-case data runs through this date. */
  asOf: string | null;
  checkedAt: string;
}

export const SPONSOR_DEFAULTS = {
  cacheDays: 7,
  /** Network lookups per build; the rest wait for the next build. */
  maxLookups: 80,
  /** Keyless calls are limited to 60 a minute per address. Stay under it. */
  perMinute: 50,
  /** Wait for one 429 at most this long; a second one ends lookups for the build. */
  maxRetryWaitMs: 60_000,
} as const;

export const SPONSOR_CACHE_KEY = "sponsorCache";

/** `fetch` as the lookup uses it: GET a URL, read JSON and maybe a Retry-After. */
export type SponsorFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

export function sponsorCacheKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Only links to PERM Tracker itself are kept; anything else falls back to its search. */
function siteUrl(v: unknown, query: string): string {
  const fallback = `${PERM_TRACKER.site}/perm-employers?q=${encodeURIComponent(query)}`;
  const s = text(v, 500);
  if (!s) return fallback;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname === "permtracker.app" ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

/** The lookup response as a record, tolerating missing fields. */
export function parseSponsorLookup(query: string, body: unknown, now: Date): SponsorRecord {
  const root = (body ?? {}) as { data?: Record<string, unknown>; meta?: Record<string, unknown> };
  const data = root.data ?? {};
  const employer = (data.employer ?? null) as Record<string, unknown> | null;
  const rawMatch = data.match;
  const match: SponsorRecord["match"] =
    employer && (rawMatch === "exact" || rawMatch === "possible") ? rawMatch : "none";
  const perm = (employer?.perm ?? null) as Record<string, unknown> | null;
  return {
    query,
    match,
    employer: match === "none" ? null : text(employer?.name),
    url: siteUrl(match === "none" ? root.meta?.url : (employer?.url ?? root.meta?.url), query),
    h1bLcas: match === "none" ? null : (num(employer?.h1bLcas) ?? 0),
    perm:
      match === "none" || !perm
        ? null
        : {
            decided: num(perm.published) ?? 0,
            certified: num(perm.certified) ?? 0,
            denied: num(perm.denied) ?? 0,
            pending: num(perm.pending) ?? 0,
            newestFiling: text(perm.newestFiling, 40),
            filingsLast12Months: num(perm.filingsLast12Months) ?? 0,
          },
    asOf: text(root.meta?.asOf, 40),
    checkedAt: now.toISOString(),
  };
}

export interface LookupOptions {
  fetchImpl: SponsorFetch;
  store: KVStore;
  now?: Date;
  maxLookups?: number;
  log?: (line: string) => void;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Records for each company name, from the cache when fresh and PERM Tracker
 * otherwise. Never throws: a name that could not be looked up is just missing
 * from the result.
 */
export async function lookupSponsors(names: string[], opts: LookupOptions): Promise<Map<string, SponsorRecord>> {
  const now = opts.now ?? new Date();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const cache = (await opts.store.get<Record<string, SponsorRecord>>(SPONSOR_CACHE_KEY)) ?? {};
  const freshAfter = now.getTime() - SPONSOR_DEFAULTS.cacheDays * 86_400_000;

  const result = new Map<string, SponsorRecord>();
  const misses: string[] = [];
  for (const name of new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))) {
    const hit = cache[sponsorCacheKey(name)];
    if (hit && Date.parse(hit.checkedAt) >= freshAfter) result.set(name, hit);
    else misses.push(name);
  }

  const calls: number[] = [];
  let looked = 0;
  let stopped = false;
  for (const name of misses.slice(0, opts.maxLookups ?? SPONSOR_DEFAULTS.maxLookups)) {
    if (stopped) break;
    // Pace: no more than perMinute calls in any 60 seconds.
    if (calls.length >= SPONSOR_DEFAULTS.perMinute) {
      const wait = calls[calls.length - SPONSOR_DEFAULTS.perMinute] + 60_000 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const url = `${PERM_TRACKER.lookup}?name=${encodeURIComponent(name.slice(0, 120))}`;
    try {
      calls.push(Date.now());
      let res = await opts.fetchImpl(url);
      if (res.status === 429) {
        const retry = Number(res.headers?.get("retry-after")) * 1000 || SPONSOR_DEFAULTS.maxRetryWaitMs;
        if (retry > SPONSOR_DEFAULTS.maxRetryWaitMs) {
          stopped = true;
          break;
        }
        await sleep(retry);
        calls.push(Date.now());
        res = await opts.fetchImpl(url);
        if (res.status === 429) {
          stopped = true;
          break;
        }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const record = parseSponsorLookup(name, await res.json(), now);
      cache[sponsorCacheKey(name)] = record;
      result.set(name, record);
      looked++;
    } catch (err) {
      log(`sponsor lookup failed for ${name}: ${String(err)}`);
    }
  }
  if (stopped) log("sponsor lookups stopped: PERM Tracker rate limit");
  const left = misses.length - looked;
  log(`sponsor records: ${result.size - looked} cached, ${looked} looked up${left > 0 ? `, ${left} left for later` : ""}`);

  if (looked > 0) await opts.store.set(SPONSOR_CACHE_KEY, pruneCache(cache, now));
  return result;
}

/**
 * Companies among these jobs that have no record, or one older than the cache
 * window. Jobs found before the profile needed sponsorship, or before records
 * existed, are filled in this way without waiting for a search to find them again.
 */
export function companiesToRefresh(jobs: Iterable<Pick<Job, "company" | "sponsor">>, now: Date): string[] {
  const freshAfter = now.getTime() - SPONSOR_DEFAULTS.cacheDays * 86_400_000;
  const names = new Set<string>();
  for (const job of jobs) {
    if (!job.sponsor || Date.parse(job.sponsor.checkedAt) < freshAfter) names.add(job.company.trim());
  }
  return [...names];
}

/** The jobs with each company's record attached where one was found. */
export function withSponsors<T extends Pick<Job, "company" | "sponsor">>(
  jobs: Record<string, T>,
  records: Map<string, SponsorRecord>,
): Record<string, T> {
  const next = { ...jobs };
  for (const [id, job] of Object.entries(jobs)) {
    const record = records.get(job.company.trim());
    if (record) next[id] = { ...job, sponsor: record };
  }
  return next;
}

/** Drop entries a month old, and keep the cache to a few thousand companies. */
function pruneCache(cache: Record<string, SponsorRecord>, now: Date): Record<string, SponsorRecord> {
  const cutoff = now.getTime() - 30 * 86_400_000;
  const kept = Object.entries(cache)
    .filter(([, r]) => Date.parse(r.checkedAt) >= cutoff)
    .sort(([, a], [, b]) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))
    .slice(0, 3000);
  return Object.fromEntries(kept);
}

// ---------------------------------------------------------------------------
// reading a record for one person
// ---------------------------------------------------------------------------

/** Fewer PERM cases than this is too little history to read a gap from. */
const PERM_HISTORY_MIN = 20;
/** New filings reach DOL's case status days to weeks late, so a shorter gap means nothing. */
export const PERM_QUIET_MIN_DAYS = 21;
/** An employer that used to file reads as paused after this long, however rarely it filed. */
export const PERM_QUIET_MAX_DAYS = 120;
/** Between those, a gap this many times the employer's usual spacing reads as a pause. */
const PERM_QUIET_SPACINGS = 8;

export interface PermGap {
  /** Days since the newest filing. */
  days: number;
  /** Average days between filings over the last 12 months; null when there were none. */
  usualDays: number | null;
  /** The gap is long for this employer. */
  quiet: boolean;
}

/**
 * How long the employer has gone without a new PERM filing, against its own
 * pace: a few weeks of silence from one that files daily is a pause, while
 * one that files a few times a year gets the full PERM_QUIET_MAX_DAYS.
 */
export function permGap(perm: SponsorRecord["perm"], now: Date): PermGap | null {
  const newest = perm?.newestFiling ? Date.parse(perm.newestFiling) : NaN;
  if (!perm || Number.isNaN(newest)) return null;
  const days = Math.max(0, Math.floor((now.getTime() - newest) / 86_400_000));
  const usualDays = perm.filingsLast12Months > 0 ? 365 / perm.filingsLast12Months : null;
  const limit =
    usualDays === null
      ? PERM_QUIET_MAX_DAYS
      : Math.min(PERM_QUIET_MAX_DAYS, Math.max(PERM_QUIET_MIN_DAYS, PERM_QUIET_SPACINGS * usualDays));
  return { days, usualDays, quiet: perm.decided + perm.pending >= PERM_HISTORY_MIN && days > limit };
}

export interface SponsorSummary {
  /** good: files what this person needs. warn: a gap or a weak match. bad: never files what they need. */
  tone: "good" | "warn" | "bad";
  /** A few words for the row. */
  short: string;
  /** Full sentences for the details. */
  lines: string[];
}

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);
const monthYear = (iso: string) => day(iso).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const fullDate = (iso: string) =>
  day(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "No new PERM filing in 26 days, after 617 in the last 12 months" */
function quietLine(perm: NonNullable<SponsorRecord["perm"]>, gap: PermGap): string {
  const when = gap.days > 90 ? `since ${monthYear(perm.newestFiling!)}` : `in ${gap.days} days`;
  const pace = perm.filingsLast12Months > 0 ? `, after ${perm.filingsLast12Months.toLocaleString("en-US")} in the last 12 months` : "";
  return `No new PERM filing ${when}${pace}`;
}

/** "PERM suspended since Oct 8, 2026" */
export function overrideHeadline(o: VisaOverride): string {
  return `${o.kind === "perm" ? "PERM" : "H-1B"} ${o.status} since ${fullDate(o.since)}`;
}

/** Stands in for a company that has not been looked up, so an action on it still counts. */
function noRecord(now: Date): SponsorRecord {
  return { query: "", match: "none", employer: null, url: "", h1bLcas: null, perm: null, asOf: null, checkedAt: now.toISOString() };
}

/**
 * What a record means for this profile's visa needs. `active` are the
 * government actions in effect for this employer (see activeOverrides). The
 * details show their text separately, so here they set only the tone and the
 * short form.
 */
export function sponsorSummary(
  record: SponsorRecord,
  profile: Pick<JobProfile, "workAuth" | "wantsGreenCard">,
  now: Date,
  active: VisaOverride[],
): SponsorSummary {
  const h1b = needsH1b(profile.workAuth);
  const gc = wantsGreenCard(profile);
  const h1bAction = h1b ? active.find((o) => o.kind === "h1b") : undefined;
  const permAction = gc ? active.find((o) => o.kind === "perm") : undefined;

  if (record.match === "none") {
    const lines = record.query
      ? [`No H-1B or PERM filings found under "${record.query}". The employer may file under another name.`]
      : [];
    if (h1bAction) return { tone: "bad", short: `H-1B ${h1bAction.status}`, lines };
    if (permAction) return { tone: profile.workAuth === "ead" ? "bad" : "warn", short: `PERM ${permAction.status}`, lines };
    return { tone: "warn", short: "No filings found", lines };
  }

  const lcas = record.h1bLcas ?? 0;
  const perm = record.perm;
  const permFiled = perm ? perm.decided + perm.pending : 0;
  const gap = permGap(perm, now);
  const quiet = !!gap?.quiet;

  const lines: string[] = [];
  if (record.match === "possible") lines.push(`Matched to ${record.employer ?? "a similar name"} (possible match).`);
  lines.push(
    lcas > 0
      ? `H-1B: ${lcas.toLocaleString("en-US")} labor condition applications (LCAs) on record, all years combined: a count of past filings, not of recent hiring.`
      : "H-1B: no labor condition applications on record.",
  );
  if (perm && permFiled > 0) {
    const share = perm.certified + perm.denied > 0 ? Math.round((perm.certified / (perm.certified + perm.denied)) * 100) : null;
    lines.push(
      `PERM: ${perm.decided.toLocaleString("en-US")} decided${share !== null ? ` (${share}% certified)` : ""}, ` +
        `${perm.pending.toLocaleString("en-US")} pending, ${perm.filingsLast12Months} filed in the last 12 months` +
        (perm.newestFiling ? `, newest ${perm.newestFiling.slice(0, 10)}.` : "."),
    );
  } else {
    lines.push("PERM: no green card filings on record.");
  }
  if (quiet && perm && gap && !permAction) lines.push(`${quietLine(perm, gap)}: green card filings may be paused.`);

  const parts = [lcas > 0 ? `H-1B ${compact(lcas)}` : "", permFiled > 0 ? `PERM ${compact(permFiled)}` : ""].filter(Boolean);
  let tone: SponsorSummary["tone"] = "good";
  let short = parts.join(" · ");
  if (h1bAction) {
    tone = "bad";
    short = `H-1B ${h1bAction.status}`;
  } else if (h1b && lcas === 0) {
    tone = "bad";
    short = "No H-1B filings";
  } else if (permAction) {
    tone = profile.workAuth === "ead" ? "bad" : "warn";
    short = parts.length ? `${short} · PERM ${permAction.status}` : `PERM ${permAction.status}`;
  } else if (gc && permFiled === 0) {
    tone = profile.workAuth === "ead" ? "bad" : "warn";
    short = parts.length ? `${short} · no PERM` : "No PERM filings";
  } else if (gc && quiet) {
    // The row has little room; the date is in the details.
    tone = "warn";
    short = `${short} · PERM quiet`;
  } else if (!short) {
    tone = "bad";
    short = "No filings";
  }
  if (record.match === "possible" && tone === "good") tone = "warn";
  return { tone, short, lines };
}

// ---------------------------------------------------------------------------
// the row marks
// ---------------------------------------------------------------------------

/** yes: files it. maybe: a gap or a weak match. no: ruled out or never files it. unknown: not checked. */
export type MarkState = "yes" | "maybe" | "no" | "unknown";

export interface VisaMark {
  kind: "h1b" | "perm";
  label: string;
  state: MarkState;
  /** Why, for the hover text. */
  reason: string;
}

/**
 * One mark per thing this person needs from an employer: H-1B for OPT and
 * H-1B holders, PERM for anyone who wants a green card. A posting that rules
 * them out turns every mark to no; a government action turns its program's
 * mark to no, whatever the record shows.
 */
export function visaMarks(
  job: Pick<Job, "visa" | "sponsor">,
  profile: Pick<JobProfile, "workAuth" | "wantsGreenCard">,
  now: Date,
  active: VisaOverride[],
): VisaMark[] {
  if (!needsSponsorship(profile)) return [];
  const kinds: VisaMark["kind"][] = [];
  if (needsH1b(profile.workAuth)) kinds.push("h1b");
  if (wantsGreenCard(profile)) kinds.push("perm");

  const signals = job.visa ?? [];
  const blocking = blockingSignal(signals, profile);
  const record = job.sponsor;
  const possible = record?.match === "possible" ? ` (possible match: ${record.employer})` : "";

  return kinds.map((kind): VisaMark => {
    const label = kind === "h1b" ? "H-1B" : "PERM";
    if (blocking) return { kind, label, state: "no", reason: `Posting: ${SIGNAL_SHORT[blocking].toLowerCase()}` };
    const action = active.find((o) => o.kind === kind);
    if (action) return { kind, label, state: "no", reason: `${overrideHeadline(action)} (Department of Labor)` };
    if (kind === "h1b" && signals.includes("sponsors")) {
      return { kind, label, state: "yes", reason: "Posting says it sponsors visas" };
    }
    if (!record) return { kind, label, state: "unknown", reason: "Filings not checked yet" };
    if (record.match === "none") {
      return { kind, label, state: "unknown", reason: `No filings found under "${record.query}"` };
    }
    const weak = (state: MarkState): MarkState => (state === "yes" && record.match === "possible" ? "maybe" : state);

    if (kind === "h1b") {
      const lcas = record.h1bLcas ?? 0;
      return lcas > 0
        ? { kind, label, state: weak("yes"), reason: `${lcas.toLocaleString("en-US")} H-1B LCAs on record, all years${possible}` }
        : { kind, label, state: "no", reason: `No H-1B LCAs on record${possible}` };
    }
    const perm = record.perm;
    const filed = perm ? perm.decided + perm.pending : 0;
    if (!perm || filed === 0) return { kind, label, state: "no", reason: `No PERM filings on record${possible}` };
    const gap = permGap(perm, now);
    if (gap?.quiet) return { kind, label, state: "maybe", reason: `${quietLine(perm, gap)}${possible}` };
    return {
      kind,
      label,
      state: weak("yes"),
      reason: `${filed.toLocaleString("en-US")} PERM cases, ${perm.filingsLast12Months} filed in the last 12 months${possible}`,
    };
  });
}

// ---------------------------------------------------------------------------
// the row badge
// ---------------------------------------------------------------------------

const SIGNAL_SHORT: Record<VisaSignal, string> = {
  "no-sponsorship": "No sponsorship",
  "citizens-only": "Citizens only",
  "us-persons-only": "Citizens / green card only",
  clearance: "Clearance required",
  sponsors: "Sponsors visas",
};

/**
 * One badge per job for someone who needs sponsorship: what the posting rules
 * out comes first, then a government action, then the employer's record, then
 * a posting that says it sponsors.
 */
export function visaBadge(
  job: Pick<Job, "visa" | "sponsor">,
  profile: Pick<JobProfile, "workAuth" | "wantsGreenCard">,
  now: Date,
  active: VisaOverride[],
): { tone: SponsorSummary["tone"]; text: string } | null {
  if (!needsSponsorship(profile)) return null;
  const signals = job.visa ?? [];
  const blocking = blockingSignal(signals, profile);
  if (blocking) return { tone: "bad", text: SIGNAL_SHORT[blocking] };
  const summary = sponsorSummary(job.sponsor ?? noRecord(now), profile, now, active);
  const acted = (needsH1b(profile.workAuth) && active.some((o) => o.kind === "h1b")) ||
    (wantsGreenCard(profile) && active.some((o) => o.kind === "perm"));
  if (acted) return { tone: summary.tone, text: summary.short };
  // The posting's own word beats a missing or weak record.
  if (signals.includes("sponsors") && (!job.sponsor || summary.tone !== "good")) return { tone: "good", text: SIGNAL_SHORT.sponsors };
  return job.sponsor ? { tone: summary.tone, text: summary.short } : null;
}
