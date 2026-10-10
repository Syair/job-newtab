/**
 * The application tracker: what the user did with each job, when, and the
 * summaries built from it — for the Tracker view and for the agent, which reads
 * the pipeline before each search.
 */
import type { JobStatus, StoredJob } from "./jobs";

export interface StatusChange {
  status: JobStatus;
  at: string;
}

/** What the user did with a job. Written only by the new-tab page. */
export interface StatusEntry {
  status: JobStatus;
  updatedAt: string;
  /** Every change, oldest first. Missing on entries saved before history existed. */
  history?: StatusChange[];
  /** The user's own note: recruiter name, referral, next step. */
  note?: string;
  /**
   * The job's title, company and link at the time, so the tracker and the agent
   * still know what it was after the job itself is pruned from storage.
   */
  title?: string;
  company?: string;
  url?: string;
}

/** Statuses that mean an application went out. */
export const APPLIED_STATUSES: JobStatus[] = ["applied", "interviewing", "offer", "rejected"];

/** Days after applying with no change before a follow-up is due. */
export const FOLLOW_UP_DAYS = 7;

const DAY = 86_400_000;

/** The entry after a status change, with history. Null status removes the entry. */
export function applyStatus(
  previous: StatusEntry | undefined,
  status: JobStatus | null,
  job: Pick<StoredJob, "title" | "company" | "url"> | undefined,
  now: Date,
): StatusEntry | null {
  if (!status) return null;
  const at = now.toISOString();
  const history = [...(previous?.history ?? seedHistory(previous)), { status, at }];
  return {
    ...previous,
    status,
    updatedAt: at,
    history,
    title: job?.title ?? previous?.title,
    company: job?.company ?? previous?.company,
    url: job?.url ?? previous?.url,
  };
}

/** Entries from before history existed: treat the last change as the only one. */
function seedHistory(entry: StatusEntry | undefined): StatusChange[] {
  return entry ? [{ status: entry.status, at: entry.updatedAt }] : [];
}

/** When the application went out, or null if it hasn't. */
export function appliedAt(entry: StatusEntry): string | null {
  const first = (entry.history ?? seedHistory(entry)).find((h) => APPLIED_STATUSES.includes(h.status));
  return first?.at ?? null;
}

export function daysBetween(fromIso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / DAY));
}

/** A tracked job joined with what we know about it. */
export interface TrackedJob {
  id: string;
  title: string;
  company: string;
  url: string;
  status: JobStatus;
  updatedAt: string;
  appliedAt: string | null;
  note: string;
  /** The stored job, when it hasn't been pruned. */
  job?: StoredJob;
}

export function trackedJobs(jobs: Record<string, StoredJob>, statuses: Record<string, StatusEntry>): TrackedJob[] {
  return Object.entries(statuses)
    .map(([id, entry]) => {
      const job = jobs[id];
      return {
        id,
        title: job?.title ?? entry.title ?? "(job no longer stored)",
        company: job?.company ?? entry.company ?? "",
        url: job?.url ?? entry.url ?? "",
        status: entry.status,
        updatedAt: entry.updatedAt,
        appliedAt: appliedAt(entry),
        note: entry.note ?? "",
        job,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Applied, no change since, and long enough ago to nudge. */
export function isFollowUpDue(t: TrackedJob, now: Date): boolean {
  return t.status === "applied" && daysBetween(t.updatedAt, now) >= FOLLOW_UP_DAYS;
}

/** Monday 00:00 local time of the week `date` falls in. */
export function weekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** Applications sent per week, oldest first, for the last `weeks` weeks including this one. */
export function applicationsByWeek(tracked: TrackedJob[], now: Date, weeks = 8): Array<{ week: Date; count: number }> {
  const thisWeek = weekStart(now);
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const week = new Date(thisWeek);
    week.setDate(week.getDate() - 7 * (weeks - 1 - i));
    return { week, count: 0 };
  });
  for (const t of tracked) {
    if (!t.appliedAt) continue;
    const start = weekStart(new Date(t.appliedAt)).getTime();
    const bucket = buckets.find((b) => b.week.getTime() === start);
    if (bucket) bucket.count++;
  }
  return buckets;
}

/**
 * The pipeline as the agent reads it in the kickoff message: what is in flight
 * (don't list again), what the user turned down (a signal, not a rule), and
 * which follow-ups are due. Capped so a long history stays a short message.
 */
export function pipelineForAgent(tracked: TrackedJob[], now: Date): string | null {
  const line = (t: TrackedJob, extra = "") => `  - ${t.title} — ${t.company}${extra}`;
  const by = (s: JobStatus) => tracked.filter((t) => t.status === s);
  const parts: string[] = [];

  const inFlight = [...by("applied"), ...by("interviewing"), ...by("offer")].slice(0, 40);
  if (inFlight.length) {
    parts.push(
      "Applied or further (do not list these again):",
      ...inFlight.map((t) =>
        line(t, ` (${t.status}${t.appliedAt ? `, applied ${daysBetween(t.appliedAt, now)}d ago` : ""})`),
      ),
    );
  }
  const saved = by("saved").slice(0, 20);
  if (saved.length) parts.push("Saved, not applied yet (do not list again):", ...saved.map((t) => line(t)));
  const dismissed = by("dismissed").slice(0, 30);
  if (dismissed.length) {
    parts.push(
      "Marked “Not for me” (a signal about taste: rank similar openings lower, but they are not hard rules):",
      ...dismissed.map((t) => line(t)),
    );
  }
  const closed = by("rejected").slice(0, 20);
  if (closed.length) parts.push("Applied and closed:", ...closed.map((t) => line(t)));
  const due = tracked.filter((t) => isFollowUpDue(t, now));
  if (due.length) parts.push(`Follow-ups due (applied ${FOLLOW_UP_DAYS}+ days ago, no reply): ${due.length}`);

  return parts.length ? parts.join("\n") : null;
}
