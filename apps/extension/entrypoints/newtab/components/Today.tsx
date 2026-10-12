import { useEffect, useMemo, useState } from "react";
import {
  PERM_TRACKER,
  VISA_SIGNAL_LABEL,
  activeOverrides,
  daysBetween,
  isCardOnly,
  isFollowUpDue,
  jobConcerns,
  needsSponsorship,
  overrideHeadline,
  sponsorSummary,
  trackedJobs,
  visaBadge,
  visaMarks,
  weekStart,
  type JobProfile,
  type MarkState,
  type OverridesFile,
  type VisaOverride,
  type VisaMark,
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
/** Free-text notes that ask for sponsorship, from before work authorization was a profile field. */
const SPONSOR_NOTE = /\b(?:h-?1b|sponsor\w*|visa|opt|green card|perm)\b/i;

/** Whether jobs that rule out the user's visa status are hidden from the queue. */
const HIDE_BLOCKED_KEY = "job-newtab:hide-non-sponsors";

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Storage blocked: the toggle resets on reload.
  }
}

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
  profile,
  overrides,
  onStatus,
}: {
  jobs: Record<string, StoredJob>;
  statuses: Record<string, StatusEntry>;
  lastBuild?: LastBuild;
  profile: JobProfile;
  /** Government actions on visa programs, by employer. */
  overrides: OverridesFile;
  onStatus: OnStatus;
}) {
  const now = useMemo(() => new Date(), [statuses]);
  const tracked = useMemo(() => trackedJobs(jobs, statuses), [jobs, statuses]);
  const added = useMemo(() => new Set(lastBuild?.added ?? []), [lastBuild]);
  const [pending, setPending] = useState<string[]>(loadPending);
  const [undo, setUndo] = useState<{ id: string; label: string; previous: JobStatus | null } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [hideBlocked, setHideBlocked] = useState(() => loadFlag(HIDE_BLOCKED_KEY));
  const visa = needsSponsorship(profile);

  useEffect(() => savePending(pending), [pending]);
  useEffect(() => saveFlag(HIDE_BLOCKED_KEY, hideBlocked), [hideBlocked]);
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
  const unreviewed = Object.values(jobs)
    .filter((j) => !statuses[j.id])
    .sort(byFit);
  const blocked = (j: StoredJob) => visaBadge(j, profile, now, activeOverrides(j, overrides, now))?.tone === "bad";
  const hiddenCount = visa && hideBlocked ? unreviewed.filter(blocked).length : 0;
  const queue = hiddenCount ? unreviewed.filter((j) => !blocked(j)) : unreviewed;
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
        {!visa && SPONSOR_NOTE.test(profile.notes) && (
          <p className="quiet-note">
            Your notes mention visa sponsorship. Set <b>Work authorization</b> in Settings to see each employer's H-1B
            and PERM filings and to mark jobs that rule you out.
          </p>
        )}
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
              <JobRow
                key={job.id}
                job={job}
                profile={profile}
                overrides={overrides}
                now={now}
                isNew={false}
                pending={pending.includes(job.id)}
                saved
                {...handlers}
              />
            ))}
          </ol>
        </section>
      )}

      <section className="block">
        <h2 className="block-head">
          To review <span>{queue.length}</span>
          {visa && (
            <label
              className="head-toggle"
              title="Hide jobs whose posting rules out your visa status, or whose employer never files for it"
            >
              <input type="checkbox" checked={hideBlocked} onChange={(e) => setHideBlocked(e.target.checked)} />
              Hide non-sponsors{hiddenCount ? ` (${hiddenCount})` : ""}
            </label>
          )}
        </h2>
        {queue.length === 0 ? (
          <p className="quiet-note">All caught up. New matches appear after the next search.</p>
        ) : (
          <ol className="queue">
            {shown.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                profile={profile}
                overrides={overrides}
                now={now}
                isNew={added.has(job.id)}
                pending={pending.includes(job.id)}
                {...handlers}
              />
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
  profile,
  overrides,
  now,
  isNew,
  pending,
  saved,
  apply,
  applied,
  notYet,
  save,
  skip,
}: {
  job: StoredJob;
  profile: JobProfile;
  overrides: OverridesFile;
  now: Date;
  isNew: boolean;
  pending: boolean;
  saved?: boolean;
} & RowHandlers) {
  const [open, setOpen] = useState(false);
  const concerns = jobConcerns(job.concerns);
  const age = shortAge(job.postedAt);
  const visa = needsSponsorship(profile);
  const actions = activeOverrides(job, overrides, now);
  const marks = visaMarks(job, profile, now, actions);
  return (
    <li className={open ? "q-row open" : "q-row"}>
      <button
        type="button"
        className={visa ? "q-main with-visa" : "q-main"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <CompanyMark company={job.company} domain={job.companyDomain} size={28} />
        <span className="q-name">
          <span className="q-co">{job.company}</span>
          <span className="q-title">{job.title}</span>
        </span>
        <span className="q-meta">{[job.location, job.salary].filter(Boolean).join(" · ")}</span>
        {visa && (
          <span className="q-marks">
            {marks.map((m) => (
              <VisaMarkIcon key={m.kind} mark={m} />
            ))}
          </span>
        )}
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
            {needsSponsorship(profile) && <VisaDetail job={job} profile={profile} now={now} actions={actions} />}
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

const MARK_WORD: Record<MarkState, string> = { yes: "files", maybe: "check", no: "no", unknown: "unknown" };

/** One visa need as an icon and its name: ✓ files it, ! a gap, ✕ ruled out, ? not known. */
function VisaMarkIcon({ mark }: { mark: VisaMark }) {
  return (
    <span className={`vm ${mark.state}`} title={mark.reason}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="8" cy="8" r="7.25" />
        {mark.state === "yes" && <path d="M4.6 8.3l2.2 2.2 4.6-4.8" />}
        {mark.state === "no" && <path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" />}
        {mark.state === "maybe" && <path d="M8 4.3v4.6M8 11.4v.3" />}
        {mark.state === "unknown" && <path d="M6.1 6.2a1.95 1.95 0 1 1 2.6 1.85c-.45.17-.7.5-.7.95v.4M8 11.5v.2" />}
      </svg>
      <span className="vm-label">{mark.label}</span>
      <span className="sr-only">: {MARK_WORD[mark.state]}</span>
    </span>
  );
}

/** What the posting says about visas and what the employer has filed, with credit for the data. */
function VisaDetail({
  job,
  profile,
  now,
  actions,
}: {
  job: StoredJob;
  profile: JobProfile;
  now: Date;
  actions: VisaOverride[];
}) {
  const said = (job.visa ?? []).map((s) => VISA_SIGNAL_LABEL[s]);
  const summary = job.sponsor ? sponsorSummary(job.sponsor, profile, now, actions) : null;
  if (!said.length && !summary && !actions.length) return null;
  return (
    <div className="q-visa">
      <div className="q-visa-head">Visa sponsorship</div>
      <ul className="q-list">
        {actions.map((o) => (
          <li key={o.id} className="q-action">
            <b>{overrideHeadline(o)}.</b> {o.summary}{" "}
            {o.sources.map((src, i) => (
              <span key={src.url}>
                {i > 0 ? " · " : ""}
                <a href={src.url} target="_blank" rel="noreferrer">
                  {src.title}
                </a>
              </span>
            ))}
          </li>
        ))}
        {said.map((line) => (
          <li key={line}>Posting: {line.charAt(0).toLowerCase() + line.slice(1)}.</li>
        ))}
        {summary?.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {job.sponsor && (
        <p className="q-source">
          Filings from{" "}
          <a href={job.sponsor.url} target="_blank" rel="noreferrer">
            {PERM_TRACKER.name} (permtracker.app)
          </a>
          {job.sponsor.asOf ? `, decided cases through ${job.sponsor.asOf}` : ""}. Past filings, not a promise for
          this role. Not legal advice.
        </p>
      )}
    </div>
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
