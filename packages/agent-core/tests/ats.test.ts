import { describe, expect, it } from "vitest";
import {
  capFairly,
  collectAtsJobs,
  normalizeAshby,
  normalizeGreenhouse,
  normalizeLever,
  type FetchLike,
  type RawJob,
} from "../ats";
import { parseCompanyInput } from "../companies";
import { EMPTY_PROFILE } from "../profile";

const figma = { ats: "greenhouse" as const, slug: "figma", name: "Figma" };

describe("normalizers", () => {
  it("greenhouse: decodes escaped HTML content and builds a stable id", () => {
    const [job] = normalizeGreenhouse(figma, {
      jobs: [
        {
          id: 123,
          title: " Software Engineer ",
          absolute_url: "https://boards.greenhouse.io/figma/jobs/123",
          location: { name: "San Francisco, CA" },
          first_published: "2026-10-01T00:00:00Z",
          company_name: "Figma",
          content: "&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;",
        },
      ],
    });
    expect(job).toMatchObject({
      id: "greenhouse:figma:123",
      title: "Software Engineer",
      remote: false,
      description: "Build & ship",
    });
  });

  it("lever: joins all locations and keeps the country", () => {
    const [job] = normalizeLever({ ats: "lever", slug: "palantir", name: "Palantir" }, [
      {
        id: "abc",
        text: "Forward Deployed Engineer",
        hostedUrl: "https://jobs.lever.co/palantir/abc",
        createdAt: Date.parse("2026-10-02T00:00:00Z"),
        country: "US",
        workplaceType: "onsite",
        categories: { allLocations: ["New York, NY", "Washington, D.C."] },
        descriptionPlain: "Work with customers.",
      },
    ]);
    expect(job.location).toBe("New York, NY • Washington, D.C.");
    expect(job.country).toBe("US");
    expect(job.postedAt).toBe("2026-10-02T00:00:00.000Z");
  });

  it("ashby: counts a multi-country posting as US when any location is", () => {
    const [job] = normalizeAshby({ ats: "ashby", slug: "ramp", name: "Ramp" }, {
      jobs: [
        {
          id: "x",
          title: "Backend Engineer",
          jobUrl: "https://jobs.ashbyhq.com/ramp/x",
          location: "Remote (Canada)",
          secondaryLocations: [{ location: "Remote (US)", address: { postalAddress: { addressCountry: "United States" } } }],
          address: { postalAddress: { addressCountry: "Canada" } },
          isRemote: true,
          compensation: { compensationTierSummary: "$200K – $250K" },
        },
      ],
    });
    expect(job).toMatchObject({ country: "US", remote: true, salary: "$200K – $250K" });
  });
});

describe("collectAtsJobs", () => {
  const listing = (id: number, title: string, location: string, daysOld: number) => ({
    id,
    title,
    absolute_url: `https://boards.greenhouse.io/figma/jobs/${id}`,
    location: { name: location },
    first_published: new Date(Date.parse("2026-10-09T00:00:00Z") - daysOld * 86_400_000).toISOString(),
  });

  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("/boards/broken/")) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jobs: [
          listing(1, "Software Engineer", "San Francisco, CA", 2),
          listing(2, "Software Engineer", "London", 2),
          listing(3, "Account Executive", "San Francisco, CA", 2),
          listing(4, "Software Engineer, Infra", "San Francisco, CA", 200),
          listing(5, "Software Engineer, Web", "Remote", 1),
        ],
      }),
    };
  };

  it("filters by role, location, age and seen ids, and reports per-company errors", async () => {
    const profile = {
      ...EMPTY_PROFILE,
      roles: ["Software Engineer"],
      locations: ["San Francisco, CA"],
      remoteOk: true,
      companies: [figma, { ats: "greenhouse" as const, slug: "broken", name: "Broken" }],
    };
    const { jobs, stats } = await collectAtsJobs(profile, {
      fetchImpl,
      seenIds: new Set(["greenhouse:figma:5"]),
      now: new Date("2026-10-09T00:00:00Z"),
    });
    expect(jobs.map((j) => j.id)).toEqual(["greenhouse:figma:1"]);
    expect(stats.find((s) => s.company === "Broken")?.error).toContain("404");
  });
});

describe("capFairly", () => {
  it("does not let one company fill the cap", () => {
    const make = (company: string, n: number): RawJob[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `${company}${i}`,
        source: "greenhouse",
        company,
        title: "t",
        location: "",
        remote: false,
        url: "https://x",
        description: "",
        postedAt: new Date(2026, 9, 1 + i).toISOString(),
      }));
    const picked = capFairly([...make("Big", 50), ...make("Small", 2)], 6);
    expect(picked.filter((j) => j.company === "Small")).toHaveLength(2);
    expect(picked).toHaveLength(6);
  });
});

describe("parseCompanyInput", () => {
  it.each([
    ["https://boards.greenhouse.io/figma", { ats: "greenhouse", slug: "figma" }],
    ["job-boards.greenhouse.io/Figma/jobs/1", { ats: "greenhouse", slug: "figma" }],
    ["https://jobs.lever.co/palantir", { ats: "lever", slug: "palantir" }],
    ["https://jobs.ashbyhq.com/openai", { ats: "ashby", slug: "openai" }],
    ["ashby: linear", { ats: "ashby", slug: "linear" }],
    ["https://example.com/careers", null],
  ])("%s", (input, expected) => {
    expect(parseCompanyInput(input)).toEqual(expected);
  });
});
