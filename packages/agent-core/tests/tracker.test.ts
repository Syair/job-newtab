import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, makeBackup, mergeBackup, parseBackup, type BackupData } from "../backup";
import { buildKickoffMessage } from "../prompt";
import { EMPTY_PROFILE } from "../profile";
import type { StoredJob } from "../jobs";
import {
  applicationsByWeek,
  applyStatus,
  appliedAt,
  isFollowUpDue,
  pipelineForAgent,
  trackedJobs,
  type StatusEntry,
} from "../tracker";

const day = (n: number) => new Date(Date.UTC(2026, 9, n, 15));
const stored = (id: string, title: string, company: string): StoredJob => ({
  id,
  title,
  company,
  companyDomain: null,
  location: "",
  url: `https://example.com/${id}`,
  source: "greenhouse",
  remote: false,
  postedAt: null,
  salary: null,
  matchScore: 80,
  matchReasons: [],
  concerns: [],
  firstSeen: day(1).toISOString(),
  lastSeen: day(1).toISOString(),
});

describe("applyStatus", () => {
  it("keeps a history and a copy of the job", () => {
    const job = stored("a", "Frontend Engineer", "Figma");
    const saved = applyStatus(undefined, "saved", job, day(1))!;
    const applied = applyStatus(saved, "applied", undefined, day(3))!;
    expect(applied.history?.map((h) => h.status)).toEqual(["saved", "applied"]);
    expect(applied).toMatchObject({ status: "applied", title: "Frontend Engineer", company: "Figma" });
    expect(appliedAt(applied)).toBe(day(3).toISOString());
    expect(applyStatus(applied, null, job, day(4))).toBeNull();
  });

  it("seeds history for entries saved before history existed", () => {
    const old: StatusEntry = { status: "applied", updatedAt: day(2).toISOString() };
    const next = applyStatus(old, "interviewing", undefined, day(5))!;
    expect(next.history?.map((h) => h.status)).toEqual(["applied", "interviewing"]);
    expect(appliedAt(next)).toBe(day(2).toISOString());
  });
});

describe("tracker summaries", () => {
  const jobs = { a: stored("a", "Frontend Engineer", "Figma"), b: stored("b", "Web Engineer", "Stripe") };
  const statuses: Record<string, StatusEntry> = {
    a: applyStatus(undefined, "applied", jobs.a, day(1))!,
    b: applyStatus(undefined, "saved", jobs.b, day(8))!,
    // Pruned from jobs; the entry's own copy still names it.
    c: applyStatus(undefined, "dismissed", stored("c", "Wallet Engineer", "Coinbase"), day(2))!,
  };
  const now = day(9);
  const tracked = trackedJobs(jobs, statuses);

  it("joins statuses with jobs, falling back to the entry's copy", () => {
    expect(tracked.map((t) => [t.id, t.company])).toEqual([
      ["b", "Stripe"],
      ["c", "Coinbase"],
      ["a", "Figma"],
    ]);
  });

  it("flags follow-ups a week after applying", () => {
    expect(tracked.filter((t) => isFollowUpDue(t, now)).map((t) => t.id)).toEqual(["a"]);
  });

  it("counts applications by week", () => {
    const weeks = applicationsByWeek(tracked, now, 3);
    expect(weeks.map((w) => w.count)).toEqual([0, 1, 0]);
  });

  it("writes the pipeline for the agent, and the kickoff message includes it", () => {
    const text = pipelineForAgent(tracked, now)!;
    expect(text).toContain("Frontend Engineer — Figma (applied, applied 8d ago)");
    expect(text).toContain("Saved, not applied yet");
    expect(text).toContain("Wallet Engineer — Coinbase");
    expect(text).toContain("Follow-ups due (applied 7+ days ago, no reply): 1");
    const kickoff = buildKickoffMessage({ now, profile: { ...EMPTY_PROFILE, roles: ["Frontend Engineer"] }, pipeline: text });
    expect(kickoff).toContain("## Pipeline\nApplied or further");
    expect(pipelineForAgent([], now)).toBeNull();
  });
});

describe("backup", () => {
  const empty: BackupData = { profile: null, settings: {}, jobs: {}, statuses: {}, lastBuild: null, buildCount: 0 };

  it("round-trips and rejects other files", () => {
    const file = makeBackup({ ...empty, profile: { ...EMPTY_PROFILE, roles: ["Designer"] }, buildCount: 3 }, day(9));
    const back = parseBackup(JSON.stringify(file));
    expect(back.format).toBe(BACKUP_FORMAT);
    expect(back.profile?.roles).toEqual(["Designer"]);
    expect(back.buildCount).toBe(3);
    expect(() => parseBackup("hello")).toThrow(/not JSON/);
    expect(() => parseBackup('{"jobs":{}}')).toThrow(/not a job-newtab backup/);
    expect(() => parseBackup(JSON.stringify({ ...file, version: 99 }))).toThrow(/newer version/);
  });

  it("does not carry an API key even if one is in the file", () => {
    const back = parseBackup(JSON.stringify({ ...makeBackup(empty, day(9)), apiKey: "sk-ant-x" }));
    expect(JSON.stringify(back)).not.toContain("sk-ant");
  });

  it("merges: newer status wins, jobs are unioned, profile comes from the backup", () => {
    const current: BackupData = {
      ...empty,
      profile: { ...EMPTY_PROFILE, roles: ["Old"] },
      jobs: { a: stored("a", "A", "X") },
      statuses: { a: { status: "interviewing", updatedAt: day(8).toISOString() } },
      buildCount: 5,
    };
    const incoming: BackupData = {
      ...empty,
      profile: { ...EMPTY_PROFILE, roles: ["New"] },
      jobs: { b: stored("b", "B", "Y") },
      statuses: {
        a: { status: "applied", updatedAt: day(2).toISOString() },
        b: { status: "saved", updatedAt: day(3).toISOString() },
      },
      buildCount: 2,
    };
    const merged = mergeBackup(current, incoming);
    expect(merged.profile?.roles).toEqual(["New"]);
    expect(Object.keys(merged.jobs).sort()).toEqual(["a", "b"]);
    expect(merged.statuses.a.status).toBe("interviewing");
    expect(merged.statuses.b.status).toBe("saved");
    expect(merged.buildCount).toBe(5);
  });
});
