import { useEffect, useMemo, useState } from "react";
import {
  daysBetween,
  isCardOnly,
  isFollowUpDue,
  jobConcerns,
  trackedJobs,
  weekStart,
  type JobStatus,
  type StoredJob,
  type TrackedJob,
} from "@job-newtab/agent-core";
import type { LastBuild, StatusEntry } from "@/lib/storage";
import { CompanyMark } from "./CompanyMark";
import { ScoreParts } from "./Fit";
import { SOURCE_LABEL, shortAge } from "./format";

type OnStatus = (id: string, status: JobStatus | null) => void;

/** Rows shown before "Show more". */
const PAGE = 30;

/** Jobs opened with Apply and not yet answered, so the question survives a reload. */
const PENDING_KEY = "job-newtab:pending-apply";

function loadPending(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function savePending(ids: string[]) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: the question just won't survive a reload.
  }
}

/**
 * The daily view: what to follow up on, what you saved, then every open match
 * as one line each, best fit first. Apply opens the posting and asks on return
 * whether you applied; Save and Skip clear the row. The day is done when the
 * list is empty.
 */
export function Today({
  jobs,
  statuses,
  lastBuild,
  onStatus,
}: {
  jobs: Record<string, StoredJob>;
  statuses: Record<string, StatusEntry>;
  lastBuild?: LastBuild;
  onStatus: OnStatus;
}) {
  const now = useMemo(() => new Date(), [statuses]);
  const tracked = useMemo(() => trackedJobs(jobs, statuses), [jobs, statuses]);
  const added = useMemo(() => new Set(lastBuild?.added ?? []), [lastBuild]);
  const [pending, setPending] = useState<string[]>(loadPending);
  const [undo, setUndo] = useState<{ id: string; label: string; previous: JobStatus | null } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => savePending(pending), [pending]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);

  const act = (job: StoredJob, status: JobStatus | null, label: string) => {
    setUndo({ id: job.id, label: `${label}: ${job.company}`, previous: statuses[job.id]?.status ?? null });
    setPending((p) => p.filter((id) => id !== job.id));
    onStatus(job.id, status);
  };
  const handlers: RowHandlers = {
    apply: (job) => setPending((p) => (p.includes(job.id) ? p : [...p, job.id])),
    applied: (job) => act(job, "applied", "Applied"),
    notYet: (job) => setPending((p) => p.filter((id) => id !== job.id)),
    save: (job) => act(job, "saved", "Saved"),
    skip: (job) => act(job, "dismissed", "Skipped"),
  };

  const byFit = (a: StoredJob, b: StoredJob) => b.matchScore - a.matchScore;
  const queue = Object.values(jobs)
    .filter((j) => !statuses[j.id])
    .sort(byFit);
  const saved = Object.values(jobs)
    .filter((j) => statuses[j.id]?.status === "saved")
    .sort(byFit);
  const followUps = tracked.filter((t) => isFollowUpDue(t, now));
  const appliedThisWeek = tracked.filter(
    (t) => t.appliedAt && Date.parse(t.appliedAt) >= weekStart(now).getTime(),
  ).length;
  const newCount = queue.filter((j) => added.has(j.id)).length;
  const shown = showAll ? queue : queue.slice(0, PAGE);

  return (
    <div className="today">
      <section className="today-head">
        <div className="stats">
          <Stat value={newCount} label="new" />
          <Stat value={queue.length} label="to review" />
          <Stat value={followUps.length} label={followUps.length === 1 ? "follow-up due" : "follow-ups due"} alert={followUps.length > 0} />
          <Stat value={appliedThisWeek} label="applied this week" />
        </div>
        {lastBuild?.summary && <p className="today-summary">{lastBuild.summary}</p>}
      </section>

      {followUps.length > 0 && (
        <section className="block">
          <h2 className="block-head">
            Follow up <span>{followUps.length}</span>
          </h2>
          <ol className="queue">
            {followUps.map((t) => (
              <FollowUpRow key={t.id} t={t} now={now} onStatus={onStatus} />
            ))}
          </ol>
        </section>
      )}

      {saved.length > 0 && (
        <section className="block">
          <h2 className="block-head">
            Saved, ready to apply <span>{saved.length}</span>
          </h2>
          <ol className="queue">
            {saved.map((job) => (
              <JobRow key={job.id} job={job} isNew={false} pending={pending.includes(job.id)} saved {...handlers} />
            ))}
          </ol>
        </section>
      )}

      <section className="block">
        <h2 className="block-head">
          To review <span>{queue.length}</span>
        </h2>
        {queue.length === 0 ? (
          <p className="quiet-note">All caught up. New matches appear after the next search.</p>
        ) : (
          <ol className="queue">
            {shown.map((job) => (
              <JobRow key={job.id} job={job} isNew={added.has(job.id)} pending={pending.includes(job.id)} {...handlers} />
            ))}
          </ol>
        )}
        {queue.length > shown.length && (
          <button className="text-btn more-btn" onClick={() => setShowAll(true)}>
            Show {queue.length - shown.length} more
          </button>
        )}
      </section>

      {undo && (
        <div className="toast" role="status">
          <span>{undo.label}</span>
          <button
            onClick={() => {
              onStatus(undo.id, undo.previous);
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, alert }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className={alert ? "stat alert" : "stat"}>
      <b>{value}</b> {label}
    </div>
  );
}

interface RowHandlers {
  apply: (job: StoredJob) => void;
  applied: (job: StoredJob) => void;
  notYet: (job: StoredJob) => void;
  save: (job: StoredJob) => void;
  skip: (job: StoredJob) => void;
}

function JobRow({
  job,
  isNew,
  pending,
  saved,
  apply,
  applied,
  notYet,
  save,
  skip,
}: { job: StoredJob; isNew: boolean; pending: boolean; saved?: boolean } & RowHandlers) {
  const [open, setOpen] = useState(false);
  const concerns = jobConcerns(job.concerns);
  const age = shortAge(job.postedAt);
  return (
    <li className={open ? "q-row open" : "q-row"}>
      <button type="button" className="q-main" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <CompanyMark company={job.company} domain={job.companyDomain} size={28} />
        <span className="q-name">
          <span className="q-co">{job.company}</span>
          <span className="q-title">{job.title}</span>
        </span>
        <span className="q-meta">{[job.location, job.salary].filter(Boolean).join(" · ")}</span>
        <span className="q-when">{isNew ? <span className="mark">New</span> : age}</span>
        <span className="q-fit" title="Fit score out of 100. Open the row for its parts.">
          <small>fit</small>
          {job.matchScore}
        </span>
      </button>
      <div className="q-actions">
        {pending ? (
          <>
            <span className="q-ask">Applied?</span>
            <button className="q-btn primary" onClick={() => applied(job)}>
              Yes
            </button>
            <button className="q-btn" onClick={() => notYet(job)}>
              Not yet
            </button>
          </>
        ) : (
          <>
            <a className="q-btn primary" href={job.url} target="_blank" rel="noreferrer" onClick={() => apply(job)}>
              Apply ↗
            </a>
            {!saved && (
              <button className="q-btn" onClick={() => save(job)}>
                Save
              </button>
            )}
            <button className="q-btn quiet" onClick={() => skip(job)} title="Not for me. The agent ranks similar jobs lower.">
              Skip
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="q-detail">
          <div>
            {job.take && <p className="q-take">{job.take}</p>}
            {job.matchReasons.length > 0 && (
              <ul className="q-list">
                {job.matchReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {concerns.length > 0 && (
              <ul className="q-list concerns">
                {concerns.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            <p className="q-source">
              {[
                age ? `Posted ${age}` : "",
                `via ${SOURCE_LABEL[job.source]}`,
                isCardOnly(job.concerns) ? "scored from the listing card" : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {job.scoreBreakdown && <ScoreParts breakdown={job.scoreBreakdown} />}
        </div>
      )}
    </li>
  );
}

function FollowUpRow({ t, now, onStatus }: { t: TrackedJob; now: Date; onStatus: OnStatus }) {
  const days = daysBetween(t.updatedAt, now);
  return (
    <li className="q-row">
      <div className="q-main static">
        <CompanyMark company={t.company} domain={t.job?.companyDomain} size={28} />
        <span className="q-name">
          <span className="q-co">{t.company}</span>
          <a className="q-title" href={t.url} target="_blank" rel="noreferrer">
            {t.title}
          </a>
        </span>
        <span className="q-meta alert">Applied {days} days ago, no reply</span>
      </div>
      <div className="q-actions">
        {/* Same status again restarts the clock: the next nudge comes a week later. */}
        <button className="q-btn" onClick={() => onStatus(t.id, "applied")} title="Ask again in a week">
          Followed up
        </button>
        <button className="q-btn" onClick={() => onStatus(t.id, "interviewing")}>
          Got a reply
        </button>
        <button className="q-btn quiet" onClick={() => onStatus(t.id, "rejected")}>
          Closed
        </button>
      </div>
    </li>
  );
}
