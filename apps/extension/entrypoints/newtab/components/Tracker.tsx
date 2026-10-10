import { useMemo, useState } from "react";
import {
  FOLLOW_UP_DAYS,
  applicationsByWeek,
  daysBetween,
  isFollowUpDue,
  trackedJobs,
  weekStart,
  type JobStatus,
  type StatusEntry,
  type StoredJob,
  type TrackedJob,
} from "@job-newtab/agent-core";
import { CompanyMark } from "./CompanyMark";

type OnStatus = (id: string, status: JobStatus | null) => void;
type OnNote = (id: string, note: string) => void;

const STATUS_LABEL: Record<JobStatus, string> = {
  saved: "Saved",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Closed",
  dismissed: "Not for me",
};

const FILTERS: { id: string; label: string; match: (s: JobStatus) => boolean }[] = [
  { id: "active", label: "Active", match: (s) => s === "saved" || s === "applied" || s === "interviewing" || s === "offer" },
  { id: "saved", label: "Saved", match: (s) => s === "saved" },
  { id: "applied", label: "Applied", match: (s) => s === "applied" },
  { id: "interviewing", label: "Interviewing", match: (s) => s === "interviewing" },
  { id: "offer", label: "Offers", match: (s) => s === "offer" },
  { id: "rejected", label: "Closed", match: (s) => s === "rejected" },
  { id: "dismissed", label: "Not for me", match: (s) => s === "dismissed" },
  { id: "all", label: "All", match: () => true },
];

/** Saved this long without applying gets a nudge. */
const SAVED_NUDGE_DAYS = 3;

const shortDate = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function Tracker({
  jobs,
  statuses,
  onStatus,
  onNote,
}: {
  jobs: Record<string, StoredJob>;
  statuses: Record<string, StatusEntry>;
  onStatus: OnStatus;
  onNote: OnNote;
}) {
  const now = useMemo(() => new Date(), [statuses]);
  const tracked = useMemo(() => trackedJobs(jobs, statuses), [jobs, statuses]);
  const [filter, setFilter] = useState("active");

  const thisWeek = weekStart(now).getTime();
  const lastWeek = thisWeek - 7 * 86_400_000;
  const appliedIn = (from: number, to: number) =>
    tracked.filter((t) => t.appliedAt && Date.parse(t.appliedAt) >= from && Date.parse(t.appliedAt) < to).length;
  const count = (s: JobStatus) => tracked.filter((t) => t.status === s).length;
  const followUps = tracked.filter((t) => isFollowUpDue(t, now));
  const staleSaved = tracked.filter((t) => t.status === "saved" && daysBetween(t.updatedAt, now) >= SAVED_NUDGE_DAYS);
  const interviewing = tracked.filter((t) => t.status === "interviewing");
  const applications = tracked.filter((t) => t.appliedAt).length;
  const replies = tracked.filter((t) => t.status === "interviewing" || t.status === "offer").length;

  const activeFilter = FILTERS.find((f) => f.id === filter)!;
  const rows = tracked.filter((t) => activeFilter.match(t.status));

  if (tracked.length === 0) {
    return (
      <section className="tracker-empty">
        <h2>Nothing tracked yet</h2>
        <p>
          Use <b>Save</b> or <b>Mark applied</b> on any job. This page then shows what you applied to, what is waiting
          for a reply, and how many applications go out each week. The agent reads it before every search.
        </p>
      </section>
    );
  }

  return (
    <div className="tracker">
      <div className="tiles">
        <Tile label="Applied this week" value={appliedIn(thisWeek, Infinity)} sub={`${appliedIn(lastWeek, thisWeek)} last week`} />
        <Tile label="Applications" value={applications} sub={applications ? `${replies} got an interview or offer` : "none yet"} />
        <Tile label="Interviewing" value={count("interviewing")} sub={`${count("offer")} ${count("offer") === 1 ? "offer" : "offers"}`} />
        <Tile
          label="Follow-ups due"
          value={followUps.length}
          sub={`applied ${FOLLOW_UP_DAYS}+ days ago, no reply`}
          alert={followUps.length > 0}
        />
        <Tile label="Saved, not applied" value={count("saved")} sub={staleSaved.length ? `${staleSaved.length} waiting ${SAVED_NUDGE_DAYS}+ days` : " "} />
      </div>

      <div className="tracker-grid">
        <WeeklyChart tracked={tracked} now={now} />
        <section className="attention">
          <h2 className="rule-head">Needs attention</h2>
          {followUps.length + staleSaved.length + interviewing.length === 0 && (
            <p className="quiet-note">Nothing waiting on you.</p>
          )}
          {followUps.map((t) => (
            <AttentionRow key={t.id} t={t} note={`Applied ${daysBetween(t.updatedAt, now)} days ago, no reply. Follow up.`}>
              <button onClick={() => onStatus(t.id, "applied")}>Followed up</button>
              <button onClick={() => onStatus(t.id, "interviewing")}>Got a reply</button>
              <button onClick={() => onStatus(t.id, "rejected")}>Closed</button>
            </AttentionRow>
          ))}
          {interviewing.map((t) => (
            <AttentionRow key={t.id} t={t} note={t.note || `Interviewing since ${shortDate(t.updatedAt)}.`}>
              <button onClick={() => onStatus(t.id, "offer")}>Offer</button>
              <button onClick={() => onStatus(t.id, "rejected")}>Closed</button>
            </AttentionRow>
          ))}
          {staleSaved.map((t) => (
            <AttentionRow key={t.id} t={t} note={`Saved ${daysBetween(t.updatedAt, now)} days ago. Apply or let it go.`}>
              <button onClick={() => onStatus(t.id, "applied")}>Mark applied</button>
              <button onClick={() => onStatus(t.id, "dismissed")}>Not for me</button>
            </AttentionRow>
          ))}
        </section>
      </div>

      <section className="tracked">
        <div className="tracked-head">
          <h2 className="rule-head">
            Every job you acted on <span>{tracked.length}</span>
          </h2>
          <button className="text-btn" onClick={() => downloadCsv(tracked)}>
            Download CSV
          </button>
        </div>
        <div className="chips" role="tablist">
          {FILTERS.map((f) => {
            const n = tracked.filter((t) => f.match(t.status)).length;
            return (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                className={filter === f.id ? "chip on" : "chip"}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span>{n}</span>
              </button>
            );
          })}
        </div>
        {rows.length === 0 ? (
          <p className="quiet-note">No jobs here.</p>
        ) : (
          <table className="track-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Applied</th>
                <th>Last change</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="tt-job">
                    <CompanyMark company={t.company} domain={t.job?.companyDomain} size={24} />
                    <div>
                      <b>{t.company}</b>
                      {t.url ? (
                        <a href={t.url} target="_blank" rel="noreferrer">
                          {t.title}
                        </a>
                      ) : (
                        <span>{t.title}</span>
                      )}
                    </div>
                  </td>
                  <td data-label="Status">
                    <select
                      className="tt-status"
                      value={t.status}
                      aria-label={`Status for ${t.title}`}
                      onChange={(e) => onStatus(t.id, e.target.value === "untrack" ? null : (e.target.value as JobStatus))}
                    >
                      {(Object.keys(STATUS_LABEL) as JobStatus[]).map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                      <option value="untrack">Stop tracking</option>
                    </select>
                  </td>
                  <td data-label="Applied">{t.appliedAt ? shortDate(t.appliedAt) : "—"}</td>
                  <td data-label="Last change">{ageLabel(daysBetween(t.updatedAt, now))}</td>
                  <td data-label="Note" className="tt-note">
                    <NoteField id={t.id} value={t.note} onNote={onNote} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, sub, alert }: { label: string; value: number; sub: string; alert?: boolean }) {
  return (
    <div className={alert ? "tile alert" : "tile"}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

/** One series, so no legend: the title names it. Every bar has a hover label; this week's is labeled. */
function WeeklyChart({ tracked, now }: { tracked: TrackedJob[]; now: Date }) {
  const weeks = applicationsByWeek(tracked, now, 8);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  return (
    <section className="weekly">
      <h2 className="rule-head">Applications per week</h2>
      <div className="bars" role="img" aria-label={weeks.map((w) => `Week of ${shortDate(w.week)}: ${w.count}`).join("; ")}>
        {weeks.map((w, i) => {
          const current = i === weeks.length - 1;
          return (
            <div key={w.week.toISOString()} className="bar-col" title={`Week of ${shortDate(w.week)}: ${w.count}`}>
              <span className="bar-value">{current || w.count === max ? w.count : ""}</span>
              <div className="bar-track">
                <div className={current ? "bar now" : "bar"} style={{ height: `${(w.count / max) * 100}%` }} />
              </div>
              <span className="bar-label">{current ? "This week" : shortDate(w.week)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AttentionRow({ t, note, children }: { t: TrackedJob; note: string; children: React.ReactNode }) {
  return (
    <div className="att-row">
      <CompanyMark company={t.company} domain={t.job?.companyDomain} size={26} />
      <div className="att-body">
        <div>
          <b>{t.company}</b>{" "}
          {t.url ? (
            <a href={t.url} target="_blank" rel="noreferrer">
              {t.title}
            </a>
          ) : (
            t.title
          )}
        </div>
        <div className="att-note">{note}</div>
        <div className="quick att-actions">{children}</div>
      </div>
    </div>
  );
}

/** Saves when the field loses focus or on Enter, so typing doesn't write storage per keystroke. */
function NoteField({ id, value, onNote }: { id: string; value: string; onNote: OnNote }) {
  const [draft, setDraft] = useState(value);
  // Read the field itself, not `draft`: a blur can arrive before the last keystroke's render.
  const save = (text: string) => text.trim() !== value && onNote(id, text.trim());
  return (
    <input
      className="tt-note-input"
      value={draft}
      placeholder="Add a note"
      aria-label="Note"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => save(e.currentTarget.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function ageLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function downloadCsv(tracked: TrackedJob[]) {
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    ["Company", "Title", "Status", "Applied", "Last change", "Note", "Link"].join(","),
    ...tracked.map((t) =>
      [t.company, t.title, STATUS_LABEL[t.status], t.appliedAt?.slice(0, 10) ?? "", t.updatedAt.slice(0, 10), t.note, t.url]
        .map(cell)
        .join(","),
    ),
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `job-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
