import { describe, expect, it } from "vitest";
import {
  DEALBREAKER_CAP,
  cleanDomain,
  freshnessPoints,
  jobKey,
  mergeJobs,
  parseJobsFile,
  totalScore,
  type Job,
  type StoredJob,
} from "../jobs";
import { EMPTY_PROFILE } from "../profile";
import { isCardOnly, jobConcerns } from "../prompt";
import { buildSearchTargets } from "../search-urls";

const job = (over: Partial<Job>): Job => ({
  id: "greenhouse:figma:1",
  title: "Software Engineer",
  company: "Figma",
  companyDomain: "figma.com",
  location: "San Francisco, CA",
  url: "https://boards.greenhouse.io/figma/jobs/1",
  source: "greenhouse",
  remote: false,
  postedAt: null,
  salary: null,
  matchScore: 80,
  matchReasons: [],
  concerns: [],
  ...over,
});

describe("jobKey", () => {
  it("derives ids from board URLs", () => {
    expect(jobKey({ url: "https://www.linkedin.com/jobs/view/software-engineer-at-figma-4012345678/?trk=x" })).toBe(
      "linkedin:4012345678",
    );
    expect(jobKey({ url: "https://www.linkedin.com/jobs/search/?currentJobId=42" })).toBe("linkedin:42");
    expect(jobKey({ url: "https://www.indeed.com/viewjob?jk=abc123&from=serp" })).toBe("indeed:abc123");
    expect(jobKey({ id: "lever:palantir:x", url: "https://jobs.lever.co/palantir/x" })).toBe("lever:palantir:x");
  });
});

describe("cleanDomain", () => {
  it.each([
    ["figma.com", "figma.com"],
    ["https://www.Figma.com/careers", "figma.com"],
    ["linear.app", "linear.app"],
    ["not a domain", null],
    ["localhost", null],
    [null, null],
  ])("%s -> %s", (input, expected) => {
    expect(cleanDomain(input)).toBe(expected);
  });
});

describe("parseJobsFile", () => {
  it("prefers the known domain for preset companies over the agent's guess", () => {
    const { file } = parseJobsFile(
      JSON.stringify({
        jobs: [
          { title: "A", company: "Datadog", companyDomain: "datadog.com", url: "https://www.linkedin.com/jobs/view/1" },
          { title: "B", company: "Acme Robotics", companyDomain: "https://acme-robotics.com", url: "https://www.linkedin.com/jobs/view/2" },
          { title: "C", company: "Nobody", companyDomain: "??", url: "https://www.linkedin.com/jobs/view/3" },
        ],
      }),
    );
    expect(file.jobs.map((j) => j.companyDomain)).toEqual(["datadoghq.com", "acme-robotics.com", null]);
  });

  it("accepts a fenced file, clamps scores, drops invalid entries and duplicates", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        summary: "Two new matches.",
        jobs: [
          { title: "A", company: "X", url: "https://www.linkedin.com/jobs/view/1", matchScore: 140, matchReasons: ["r"] },
          { title: "B", company: "Y", url: "not a url", matchScore: 50 },
          { title: "A again", company: "X", url: "https://www.linkedin.com/jobs/view/1", matchScore: 60 },
          { title: "C", company: "Z", url: "https://jobs.ashbyhq.com/z/1", matchScore: "70" },
        ],
      }) +
      "\n```";
    const { file, dropped } = parseJobsFile(text);
    expect(file.summary).toBe("Two new matches.");
    expect(file.jobs.map((j) => [j.id, j.matchScore, j.source])).toEqual([
      ["linkedin:1", 100, "linkedin"],
      ["jobs.ashbyhq.com/z/1", 70, "ashby"],
    ]);
    expect(dropped).toHaveLength(1);
  });

  it("keeps the agent's take and ignores a front page from older prompts", () => {
    const { file } = parseJobsFile(
      JSON.stringify({
        summary: "s",
        jobs: [{ title: "A", company: "Figma", url: "https://boards.greenhouse.io/figma/jobs/1", take: "Your design-system work is the job." }],
        frontPage: { lead: null, sections: [], skipped: [] },
      }),
    );
    expect(file.jobs[0].take).toBe("Your design-system work is the job.");
    expect(Object.keys(file)).toEqual(["summary", "jobs"]);
  });

  it("throws on non-JSON", () => {
    expect(() => parseJobsFile("sorry")).toThrow(/not valid JSON/);
  });
});

describe("score breakdown", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const parseOne = (fields: Record<string, unknown>) =>
    parseJobsFile(
      JSON.stringify({ jobs: [{ title: "A", company: "X", url: "https://www.linkedin.com/jobs/view/1", ...fields }] }),
      now,
    ).file.jobs[0];

  it.each([
    ["2026-10-09T02:00:00Z", 10],
    ["2026-10-07", 8],
    ["2026-10-03", 6],
    ["2026-09-28", 4],
    ["2026-09-15", 2],
    ["2026-06-01", 0],
    [null, 5],
    ["last week", 5],
  ])("freshness for %s is %i", (postedAt, points) => {
    expect(freshnessPoints(postedAt, now)).toBe(points);
  });

  it("adds the agent's parts to computed freshness, ignoring any total it sent", () => {
    const j = parseOne({ postedAt: "2026-10-09", score: { role: 38, skills: 29, location: 15 }, matchScore: 12 });
    expect(j.scoreBreakdown).toEqual({ role: 38, skills: 29, location: 15, freshness: 10, dealbreaker: null });
    expect(j.matchScore).toBe(92);
  });

  it("clamps each part to its range", () => {
    const j = parseOne({ score: { role: 55, skills: -3, location: "15" } });
    expect(j.scoreBreakdown).toMatchObject({ role: 40, skills: 0, location: 15 });
    expect(j.matchScore).toBe(40 + 0 + 15 + 5);
  });

  it("scales to 100 without a resume", () => {
    const j = parseOne({ postedAt: "2026-10-09", score: { role: 40, skills: null, location: 15 } });
    expect(j.scoreBreakdown?.skills).toBeNull();
    expect(j.matchScore).toBe(100);
    expect(totalScore({ role: 26, skills: null, location: 8, freshness: 5, dealbreaker: null })).toBe(60);
  });

  it("caps a dealbreaker and leads the concerns with it", () => {
    const j = parseOne({
      score: { role: 38, skills: 31, location: 15 },
      dealbreaker: "Crypto company; you said no crypto",
      concerns: ["On-site"],
    });
    expect(j.matchScore).toBe(DEALBREAKER_CAP);
    expect(j.concerns).toEqual(["Crypto company; you said no crypto", "On-site"]);
  });

  it("falls back to the legacy total when the parts are missing", () => {
    const j = parseOne({ matchScore: 77, score: { role: "high" } });
    expect(j.scoreBreakdown).toBeNull();
    expect(j.matchScore).toBe(77);
  });
});

describe("mergeJobs", () => {
  const now = new Date("2026-10-09T12:00:00Z");

  it("keeps firstSeen for re-found jobs and reports only new ids as added", () => {
    const stored: Record<string, StoredJob> = {
      [job({}).id]: { ...job({ matchScore: 50 }), firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-01T00:00:00Z" },
    };
    const { jobs, added } = mergeJobs(stored, [job({ matchScore: 90 }), job({ id: "ashby:x:2", company: "X" })], {
      now,
      statuses: {},
    });
    expect(jobs["greenhouse:figma:1"]).toMatchObject({ firstSeen: "2026-10-01T00:00:00Z", matchScore: 90 });
    expect(added).toEqual(["ashby:x:2"]);
  });

  it("replaces a board copy with the career-board copy of the same opening", () => {
    const board = job({ id: "linkedin:9", source: "linkedin", url: "https://www.linkedin.com/jobs/view/9" });
    const stored = { [board.id]: { ...board, firstSeen: "2026-10-08T00:00:00Z", lastSeen: "2026-10-08T00:00:00Z" } };
    const { jobs, added } = mergeJobs(stored, [job({})], { now, statuses: {} });
    expect(Object.keys(jobs)).toEqual(["greenhouse:figma:1"]);
    expect(jobs["greenhouse:figma:1"].firstSeen).toBe("2026-10-08T00:00:00Z");
    expect(added).toEqual([]);
  });

  it("prunes stale unreviewed jobs but keeps tracked ones", () => {
    const old = "2026-08-01T00:00:00Z";
    const stored = {
      a: { ...job({ id: "a", title: "A" }), firstSeen: old, lastSeen: old },
      b: { ...job({ id: "b", title: "B" }), firstSeen: old, lastSeen: old },
    };
    const { jobs } = mergeJobs(stored, [], { now, statuses: { b: "applied" } });
    expect(Object.keys(jobs)).toEqual(["b"]);
  });

  it("maps an incoming twin to the stored id and keeps its new take", () => {
    const ats = job({});
    const stored = { [ats.id]: { ...ats, firstSeen: "2026-10-08T00:00:00Z", lastSeen: "2026-10-08T00:00:00Z" } };
    const board = job({ id: "linkedin:9", source: "linkedin", url: "https://www.linkedin.com/jobs/view/9", take: "new take" });
    const { idMap, jobs } = mergeJobs(stored, [board], { now, statuses: {} });
    expect(idMap).toEqual({ "linkedin:9": ats.id });
    expect(jobs[ats.id].take).toBe("new take");
  });
});

describe("buildSearchTargets", () => {
  const p = {
    ...EMPTY_PROFILE,
    roles: ["Software Engineer", "Product Designer"],
    seniority: ["mid" as const, "senior" as const],
    locations: ["Seattle, WA", "Austin, TX"],
    remoteOk: true,
  };

  it("builds LinkedIn and Indeed searches with the place in LinkedIn's keywords", () => {
    const targets = buildSearchTargets(p, { freshnessHours: 24, max: 100 });
    expect(targets).toHaveLength(2 * 3 * 2);
    const li = (where: string) => new URL(targets.find((t) => t.board === "linkedin" && t.where === where)!.url);
    expect(li("Remote").pathname).toBe("/jobs/search-results/");
    expect(li("Remote").searchParams.get("keywords")).toBe("Software Engineer remote in United States");
    expect(li("Seattle, WA").searchParams.get("keywords")).toBe("Software Engineer in Seattle, WA");
    expect(li("Remote").searchParams.get("f_TPR")).toBe("r86400");
    const indeed = new URL(targets.find((t) => t.board === "indeed")!.url);
    expect(indeed.searchParams.get("fromage")).toBe("1");
  });

  it("caps pages per build and rotates through the rest", () => {
    const first = buildSearchTargets(p, { freshnessHours: 24, max: 4, rotation: 0 });
    const second = buildSearchTargets(p, { freshnessHours: 24, max: 4, rotation: 1 });
    expect(first).toHaveLength(4);
    expect(new Set([...first, ...second].map((t) => t.url)).size).toBe(8);
    // The first slice already spans both roles.
    expect(new Set(first.map((t) => t.role)).size).toBe(2);
  });
});

describe("card-only concern", () => {
  it("is kept out of the job's own concerns", () => {
    const concerns = ["Only the listing card was read.", "Requires a security clearance"];
    expect(jobConcerns(concerns)).toEqual(["Requires a security clearance"]);
    expect(isCardOnly(concerns)).toBe(true);
    expect(isCardOnly(["Requires a security clearance"])).toBe(false);
  });
});
