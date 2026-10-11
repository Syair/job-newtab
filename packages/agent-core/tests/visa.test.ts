import { describe, expect, it } from "vitest";
import { DEALBREAKER_CAP, type Job } from "../jobs";
import { EMPTY_PROFILE, normalizeProfile, type JobProfile } from "../profile";
import { buildKickoffMessage } from "../prompt";
import {
  PERM_TRACKER,
  SPONSOR_CACHE_KEY,
  companiesToRefresh,
  lookupSponsors,
  withSponsors,
  parseSponsorLookup,
  sponsorSummary,
  visaBadge,
  visaMarks,
  type SponsorRecord,
} from "../sponsors";
import type { KVStore } from "../types";
import { applyVisaSignals, visaDealbreaker, visaSignals } from "../visa";

const NOW = new Date("2026-10-10T12:00:00Z");
const profile = (over: Partial<JobProfile> = {}): JobProfile => ({ ...EMPTY_PROFILE, roles: ["Engineer"], ...over });

describe("visaSignals", () => {
  it.each([
    ["We are unable to sponsor visas for this position.", "no-sponsorship"],
    ["Applicants must be authorized to work in the U.S. without the need for current or future sponsorship.", "no-sponsorship"],
    ["This role is not eligible for visa sponsorship.", "no-sponsorship"],
    ["Visa sponsorship is not available for this role.", "no-sponsorship"],
    ["Candidates requiring sponsorship will not be considered.", "no-sponsorship"],
    ["Must be a U.S. citizen.", "citizens-only"],
    ["This position requires US citizenship.", "citizens-only"],
    ["Must be a U.S. citizen or lawful permanent resident.", "us-persons-only"],
    [
      "To conform to U.S. Government export regulations, applicant must be a (i) U.S. citizen or national, (ii) U.S. lawful, permanent resident",
      "us-persons-only",
    ],
    ["Applicants must be a U.S. person as defined by ITAR.", "us-persons-only"],
    ["Active Secret clearance required.", "clearance"],
    ["Ability to obtain and maintain a Top Secret security clearance.", "clearance"],
    ["Visa sponsorship is available for this role.", "sponsors"],
    ["We offer H-1B sponsorship and green card support.", "sponsors"],
    ["Visa sponsorship: We do sponsor visas! However, we aren't able to successfully sponsor visas for every role.", "sponsors"],
    // Real lines from preset companies' boards.
    [
      "Please note the Company may not be able to employ candidates who have United States work authorization related to certain U.S. visa categories, or support future H-1B sponsorship at this time.",
      "no-sponsorship",
    ],
    ["This role does not include employment sponsorship or relocation assistance.", "no-sponsorship"],
    ["Required - Active Secret clearance — non-negotiable; candidates without an active Secret clearance will not be considered", "clearance"],
  ])("reads %j", (text, signal) => {
    expect(visaSignals(text)).toContain(signal);
  });

  it.each([
    "Benefits include, but are not limited to, visa sponsorship and a 401k.",
    "U.S. citizenship is not required.",
    "A security clearance is a plus.",
    "We are a corporate sponsor of local hackathons.",
    "Must be authorized to work in the United States.",
    "",
    "Your authorization to receive technology controlled under these U.S. export laws without sponsorship for an export license.",
    "Clearance: An active U.S. government security clearance is preferred but not required.",
    "TS/SCI clearance (preferred but not required).",
    "Active UK Security clearance, or eligibility and willingness to obtain one, is beneficial but not necessary.",
  ])("finds no blocking rule in %j", (text) => {
    const found = visaSignals(text);
    expect(found).not.toContain("no-sponsorship");
    expect(found).not.toContain("citizens-only");
    expect(found).not.toContain("clearance");
  });

  it("does not read clearance sponsorship as visa sponsorship", () => {
    expect(visaSignals("You don't need to hold a clearance already, we will sponsor your clearance.")).not.toContain("sponsors");
  });

  it("lets a refusal win over a sponsorship mention", () => {
    expect(visaSignals("We will not sponsor. Sponsorship is available for other teams.")).toEqual(["no-sponsorship"]);
  });
});

describe("visaDealbreaker", () => {
  it("ignores everything when no sponsorship is needed", () => {
    expect(visaDealbreaker(["no-sponsorship", "citizens-only"], { workAuth: "none" })).toBeNull();
  });
  it("treats a refusal as a concern only for EAD holders", () => {
    expect(visaDealbreaker(["no-sponsorship"], { workAuth: "ead" })).toBeNull();
    expect(visaDealbreaker(["no-sponsorship"], { workAuth: "opt" })).toMatch(/does not sponsor/);
    expect(visaDealbreaker(["citizens-only"], { workAuth: "ead" })).toMatch(/citizens only/);
  });
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "greenhouse:acme:1",
  title: "Engineer",
  company: "Acme",
  companyDomain: null,
  location: "Seattle, WA",
  url: "https://boards.greenhouse.io/acme/jobs/1",
  source: "greenhouse",
  remote: false,
  postedAt: null,
  salary: null,
  matchScore: 85,
  scoreBreakdown: { role: 38, skills: 30, location: 12, freshness: 5, dealbreaker: null },
  matchReasons: [],
  concerns: ["Hybrid 3 days"],
  ...over,
});

describe("applyVisaSignals", () => {
  it("caps a job whose posting rules the person out", () => {
    const out = applyVisaSignals(job(), ["no-sponsorship"], profile({ workAuth: "h1b-new" }));
    expect(out.matchScore).toBe(DEALBREAKER_CAP);
    expect(out.scoreBreakdown?.dealbreaker).toMatch(/does not sponsor/);
    expect(out.concerns[0]).toMatch(/does not sponsor/);
    expect(out.visa).toEqual(["no-sponsorship"]);
  });
  it("keeps the agent's wording when it already named the rule", () => {
    const named = job({ concerns: ["No visa sponsorship per posting"] });
    const out = applyVisaSignals(named, ["no-sponsorship"], profile({ workAuth: "opt" }));
    expect(out.concerns).toEqual(["No visa sponsorship per posting"]);
    expect(out.matchScore).toBe(DEALBREAKER_CAP);
  });
  it("leaves the job alone when no sponsorship is needed", () => {
    const j = job();
    expect(applyVisaSignals(j, ["no-sponsorship"], profile())).toBe(j);
  });
  it("adds a concern but no cap for an EAD holder", () => {
    const out = applyVisaSignals(job(), ["no-sponsorship"], profile({ workAuth: "ead" }));
    expect(out.matchScore).toBe(85);
    expect(out.concerns[0]).toMatch(/green card/);
  });
});

const lookupBody = (over: Record<string, unknown> = {}) => ({
  data: {
    query: "Meta",
    match: "possible",
    employer: {
      name: "Meta Platforms, Inc.",
      url: "https://permtracker.app/perm-employers/meta-platforms-inc",
      perm: { published: 1257, certified: 1198, denied: 6, pending: 19, newestFiling: "2026-05-08", filingsLast12Months: 26 },
      h1bLcas: 27542,
      ...over,
    },
  },
  meta: { asOf: "2026-06-30", url: "https://permtracker.app/perm-employers/meta-platforms-inc" },
});

describe("parseSponsorLookup", () => {
  it("reads a match", () => {
    const r = parseSponsorLookup("Meta", lookupBody(), NOW);
    expect(r).toMatchObject({ match: "possible", employer: "Meta Platforms, Inc.", h1bLcas: 27542, asOf: "2026-06-30" });
    expect(r.perm).toMatchObject({ decided: 1257, pending: 19, newestFiling: "2026-05-08" });
  });
  it("reads no match", () => {
    const r = parseSponsorLookup("Zq", { data: { match: "none", employer: null }, meta: { url: "https://permtracker.app/perm-employers?q=Zq" } }, NOW);
    expect(r).toMatchObject({ match: "none", employer: null, h1bLcas: null, perm: null });
  });
  it("never keeps a link to another site", () => {
    const r = parseSponsorLookup("Meta", lookupBody({ url: "https://evil.example/x" }), NOW);
    expect(r.url.startsWith(PERM_TRACKER.site)).toBe(true);
  });
});

describe("sponsorSummary", () => {
  const meta = parseSponsorLookup("Meta", lookupBody(), NOW);
  it("flags a PERM pause for someone who wants a green card", () => {
    const s = sponsorSummary(meta, { workAuth: "h1b-transfer", wantsGreenCard: true }, NOW);
    expect(s.tone).toBe("warn");
    expect(s.short).toMatch(/PERM quiet$/);
    expect(s.lines.join(" ")).toMatch(/No new PERM filing since May 2026/);
    expect(s.lines.join(" ")).toMatch(/possible match/);
  });
  it("calls an employer with no H-1B filings bad for an H-1B need", () => {
    const none = parseSponsorLookup("Tiny", lookupBody({ h1bLcas: 0, perm: null }), NOW);
    expect(sponsorSummary(none, { workAuth: "opt", wantsGreenCard: false }, NOW).tone).toBe("bad");
  });
  it("lets the posting's own word beat a weak record in the badge", () => {
    const none = parseSponsorLookup("Tiny", lookupBody({ h1bLcas: 0, perm: null }), NOW);
    expect(visaBadge({ visa: ["sponsors"], sponsor: none }, { workAuth: "opt", wantsGreenCard: false }, NOW)).toEqual({
      tone: "good",
      text: "Sponsors visas",
    });
    expect(visaBadge({ visa: ["citizens-only"], sponsor: meta }, { workAuth: "opt", wantsGreenCard: false }, NOW)?.tone).toBe(
      "bad",
    );
    expect(visaBadge({ sponsor: meta }, { workAuth: "none", wantsGreenCard: false }, NOW)).toBeNull();
  });
});

function memoryStore(init: Record<string, unknown> = {}): KVStore & { data: Record<string, unknown> } {
  const data = { ...init };
  return {
    data,
    async get<T>(k: string) {
      return data[k] as T | undefined;
    },
    async set(k: string, v: unknown) {
      data[k] = v;
    },
    async remove(k: string) {
      delete data[k];
    },
  };
}

describe("lookupSponsors", () => {
  it("uses fresh cache entries and looks up the rest", async () => {
    const cached: SponsorRecord = { ...parseSponsorLookup("Meta", lookupBody(), NOW), checkedAt: "2026-10-08T00:00:00Z" };
    const store = memoryStore({ [SPONSOR_CACHE_KEY]: { meta: cached } });
    const asked: string[] = [];
    const out = await lookupSponsors(["Meta", "Stripe", "Stripe", " "], {
      store,
      now: NOW,
      fetchImpl: async (url) => {
        asked.push(new URL(url).searchParams.get("name")!);
        return { ok: true, status: 200, json: async () => lookupBody({ name: "Stripe, Inc." }) };
      },
    });
    expect(asked).toEqual(["Stripe"]);
    expect(out.get("Meta")).toBe(cached);
    expect(out.get("Stripe")?.employer).toBe("Stripe, Inc.");
    expect(Object.keys(store.data[SPONSOR_CACHE_KEY] as object).sort()).toEqual(["meta", "stripe"]);
  });

  it("stops after a second rate limit and never throws", async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await lookupSponsors(["A Co", "B Co", "C Co"], {
      store: memoryStore(),
      now: NOW,
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: async () => {
        calls++;
        return { ok: false, status: 429, json: async () => ({}), headers: { get: () => "2" } };
      },
    });
    expect(out.size).toBe(0);
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it("skips a failed name and keeps going", async () => {
    let n = 0;
    const out = await lookupSponsors(["A Co", "B Co"], {
      store: memoryStore(),
      now: NOW,
      fetchImpl: async () => {
        if (n++ === 0) throw new Error("offline");
        return { ok: true, status: 200, json: async () => lookupBody() };
      },
    });
    expect([...out.keys()]).toEqual(["B Co"]);
  });
});

describe("visaMarks", () => {
  const meta = parseSponsorLookup("Meta", lookupBody(), NOW);
  const recent = lookupBody({
    perm: { published: 323, certified: 298, denied: 1, pending: 25, newestFiling: "2026-10-09", filingsLast12Months: 55 },
  });
  const stripe = parseSponsorLookup("Stripe", { ...recent, data: { ...recent.data, match: "exact" } }, NOW);
  const opt = { workAuth: "opt" as const, wantsGreenCard: true };
  const states = (m: ReturnType<typeof visaMarks>) => m.map((x) => `${x.label}:${x.state}`);

  it("shows only what the person needs", () => {
    expect(states(visaMarks({ sponsor: stripe }, { workAuth: "h1b-transfer", wantsGreenCard: false }, NOW))).toEqual(["H-1B:yes"]);
    expect(states(visaMarks({ sponsor: stripe }, { workAuth: "ead", wantsGreenCard: false }, NOW))).toEqual(["PERM:yes"]);
    expect(visaMarks({ sponsor: stripe }, { workAuth: "none", wantsGreenCard: true }, NOW)).toEqual([]);
  });
  it("turns every mark to no when the posting rules the person out", () => {
    expect(states(visaMarks({ visa: ["citizens-only"], sponsor: stripe }, opt, NOW))).toEqual(["H-1B:no", "PERM:no"]);
  });
  it("marks a weak match and a PERM pause as maybe, and unchecked as unknown", () => {
    expect(states(visaMarks({ sponsor: meta }, opt, NOW))).toEqual(["H-1B:maybe", "PERM:maybe"]);
    expect(states(visaMarks({}, opt, NOW))).toEqual(["H-1B:unknown", "PERM:unknown"]);
  });
});

describe("backfilling stored jobs", () => {
  const fresh = { ...parseSponsorLookup("Meta", lookupBody(), NOW), checkedAt: "2026-10-09T00:00:00Z" };
  const stale = { ...fresh, checkedAt: "2026-09-01T00:00:00Z" };
  it("lists companies with no record or a stale one, once each", () => {
    const names = companiesToRefresh(
      [
        { company: "Meta", sponsor: fresh },
        { company: "Stripe" },
        { company: "Stripe " },
        { company: "Figma", sponsor: stale },
      ],
      NOW,
    );
    expect(names).toEqual(["Stripe", "Figma"]);
  });
  it("attaches records by company and leaves the rest alone", () => {
    const jobs = { a: job({ id: "a", company: "Stripe" }), b: job({ id: "b", company: "Unknown" }) };
    const out = withSponsors(jobs, new Map([["Stripe", fresh]]));
    expect(out.a.sponsor).toBe(fresh);
    expect(out.b).toBe(jobs.b);
  });
});

describe("profile and kickoff", () => {
  it("defaults older profiles to no sponsorship", () => {
    expect(normalizeProfile({ roles: ["x"] })).toMatchObject({ workAuth: "none", wantsGreenCard: false });
    expect(normalizeProfile({ workAuth: "bogus" as never }).workAuth).toBe("none");
  });
  it("tells the agent the visa status", () => {
    const text = buildKickoffMessage({ now: NOW, profile: profile({ workAuth: "opt", wantsGreenCard: true }) });
    expect(text).toMatch(/Work authorization: F-1 OPT/);
    expect(text).toMatch(/Also wants green card/);
  });
});
