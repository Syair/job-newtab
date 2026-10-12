import { describe, expect, it } from "vitest";
import {
  BUNDLED_OVERRIDES,
  OVERRIDES_KEY,
  OVERRIDES_URL,
  activeOverrides,
  employerKey,
  loadOverrides,
  parseOverridesFile,
  pickOverrides,
  refreshOverrides,
  type OverridesFile,
} from "../overrides";
import { parseSponsorLookup, permGap, sponsorSummary, visaBadge, visaMarks, type SponsorRecord } from "../sponsors";
import type { KVStore } from "../types";

const NOW = new Date("2026-10-12T12:00:00Z");

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

function record(name: string, perm: Partial<NonNullable<SponsorRecord["perm"]>> & { newestFiling: string | null }, over: Partial<SponsorRecord> = {}): SponsorRecord {
  return {
    ...parseSponsorLookup(name, { data: { match: "exact", employer: { name, h1bLcas: 1000, perm: { published: 300 } } } }, NOW),
    perm: { decided: 300, certified: 290, denied: 2, pending: 20, filingsLast12Months: 50, ...perm },
    ...over,
  };
}

/** Live PERM Tracker numbers from 2026-10-12. */
const microsoft = record("Microsoft Corporation", { decided: 6875, pending: 598, newestFiling: "2026-09-16", filingsLast12Months: 617 });
const stripe = record("Stripe, Inc.", { decided: 323, pending: 25, newestFiling: "2026-10-09", filingsLast12Months: 55 });
const google = record("Google LLC", { decided: 900, pending: 30, newestFiling: "2026-09-25", filingsLast12Months: 15 });

describe("the bundled list", () => {
  it("parses and names the eight employers suspended on Oct 8, 2026", () => {
    expect(BUNDLED_OVERRIDES.overrides).toHaveLength(1);
    const o = BUNDLED_OVERRIDES.overrides[0];
    expect(o).toMatchObject({ kind: "perm", status: "suspended", since: "2026-10-08", until: null });
    expect(o.employers.map((e) => e.name)).toEqual([
      "Microsoft",
      "Adobe",
      "Cognizant",
      "Infosys",
      "Tata Consultancy Services",
      "Wipro",
      "HCLTech",
      "Capgemini",
    ]);
    expect(o.sources.length).toBeGreaterThan(0);
  });
});

describe("parseOverridesFile", () => {
  it("drops malformed entries and non-https sources", () => {
    const file = parseOverridesFile({
      version: 1,
      updated: "2026-10-12",
      overrides: [
        { id: "a", kind: "visa", status: "suspended", since: "2026-10-08", summary: "x", employers: [{ name: "A" }] },
        { id: "b", kind: "perm", status: "suspended", since: "soon", summary: "x", employers: [{ name: "B" }] },
        { id: "c", kind: "perm", status: "suspended", since: "2026-10-08", summary: "x", employers: [] },
        {
          id: "d",
          kind: "h1b",
          status: "debarred",
          since: "2026-10-01",
          summary: "x",
          sources: [{ title: "ok", url: "https://example.org" }, { title: "plain", url: "http://example.org" }],
          employers: [{ name: "D Corp", aliases: ["D", 5] }],
        },
      ],
    });
    expect(file?.overrides.map((o) => o.id)).toEqual(["d"]);
    expect(file?.overrides[0].sources.map((s) => s.title)).toEqual(["ok"]);
    expect(file?.overrides[0].employers[0].aliases).toEqual(["D"]);
    expect(file?.overrides[0].until).toBeNull();
  });
  it("rejects a file that is not one", () => {
    expect(parseOverridesFile({ version: 2, updated: "2026-10-12", overrides: [] })).toBeNull();
    expect(parseOverridesFile("<html>")).toBeNull();
  });
});

describe("activeOverrides", () => {
  const file = BUNDLED_OVERRIDES;
  it("matches the posting's name and the filing name, without legal suffixes", () => {
    expect(activeOverrides({ company: "Microsoft" }, file, NOW)).toHaveLength(1);
    expect(activeOverrides({ company: "MSFT jobs", sponsor: microsoft }, file, NOW)).toHaveLength(1);
    expect(activeOverrides({ company: "HCL America, Inc." }, file, NOW)).toHaveLength(1);
    expect(activeOverrides({ company: "Cognizant Technology Solutions US Corp" }, file, NOW)).toHaveLength(1);
  });
  it("does not match a subsidiary, a lookalike or a possible match", () => {
    expect(activeOverrides({ company: "LinkedIn" }, file, NOW)).toEqual([]);
    expect(activeOverrides({ company: "Microsoft Research Ventures" }, file, NOW)).toEqual([]);
    const tcsLookalike = { ...stripe, match: "possible" as const, employer: "Tata Consultancy Services Limited" };
    expect(activeOverrides({ company: "TCS John Huxley", sponsor: tcsLookalike }, file, NOW)).toEqual([]);
  });
  it("applies only between since and until", () => {
    expect(activeOverrides({ company: "Adobe" }, file, new Date("2026-10-07T12:00:00Z"))).toEqual([]);
    const ended: OverridesFile = { ...file, overrides: [{ ...file.overrides[0], until: "2026-10-10" }] };
    expect(activeOverrides({ company: "Adobe" }, ended, NOW)).toEqual([]);
  });
  it("strips suffixes repeatedly", () => {
    expect(employerKey("Capgemini America, Inc.")).toBe("capgemini");
    expect(employerKey("AT&T Services, Inc.")).toBe("at and t services");
  });
});

describe("fetching the list", () => {
  const remote: OverridesFile = { ...BUNDLED_OVERRIDES, updated: "2026-11-01", overrides: [] };
  it("fetches when due, then waits", async () => {
    const store = memoryStore();
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url);
      return { ok: true, status: 200, json: async () => remote };
    };
    expect(await refreshOverrides({ fetchImpl, store, now: NOW })).toBe(true);
    expect(await refreshOverrides({ fetchImpl, store, now: new Date(NOW.getTime() + 3_600_000) })).toBe(false);
    expect(asked).toEqual([OVERRIDES_URL]);
    expect((await loadOverrides(store)).updated).toBe("2026-11-01");
  });
  it("keeps the stored list on failure and retries in an hour", async () => {
    const store = memoryStore({ [OVERRIDES_KEY]: { nextCheck: "2026-10-01T00:00:00Z", file: remote } });
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 404, json: async () => ({}) };
    };
    expect(await refreshOverrides({ fetchImpl, store, now: NOW })).toBe(false);
    expect(await refreshOverrides({ fetchImpl, store, now: new Date(NOW.getTime() + 30 * 60_000) })).toBe(false);
    expect(await refreshOverrides({ fetchImpl, store, now: new Date(NOW.getTime() + 61 * 60_000) })).toBe(false);
    expect(calls).toBe(2);
    expect((await loadOverrides(store)).updated).toBe("2026-11-01");
  });
  it("prefers the shipped list when the fetched one is older", () => {
    expect(pickOverrides({ ...remote, updated: "2026-01-01" })).toBe(BUNDLED_OVERRIDES);
    expect(pickOverrides(null)).toBe(BUNDLED_OVERRIDES);
  });
});

describe("permGap", () => {
  it("reads silence against the employer's own pace", () => {
    // 617 a year is one every ~0.6 days: 26 days without one is a pause.
    expect(permGap(microsoft.perm, NOW)).toMatchObject({ days: 26, quiet: true });
    expect(permGap(stripe.perm, NOW)?.quiet).toBe(false);
    // 15 a year is one every ~24 days: 17 days is normal.
    expect(permGap(google.perm, NOW)?.quiet).toBe(false);
  });
  it("never calls a gap under three weeks quiet, and always one over 120 days", () => {
    expect(permGap({ ...microsoft.perm!, newestFiling: "2026-09-25" }, NOW)?.quiet).toBe(false);
    const rare = { ...google.perm!, filingsLast12Months: 2, newestFiling: "2026-06-01" };
    expect(permGap(rare, NOW)?.quiet).toBe(true);
  });
  it("needs some history", () => {
    expect(permGap({ ...microsoft.perm!, decided: 5, pending: 2 }, NOW)?.quiet).toBe(false);
    expect(permGap({ ...microsoft.perm!, newestFiling: null }, NOW)).toBeNull();
  });
});

describe("a suspension on screen", () => {
  const active = activeOverrides({ company: "Microsoft", sponsor: microsoft }, BUNDLED_OVERRIDES, NOW);
  const opt = { workAuth: "opt" as const, wantsGreenCard: true };
  const ead = { workAuth: "ead" as const, wantsGreenCard: false };

  it("turns PERM to no and leaves H-1B alone", () => {
    const marks = visaMarks({ sponsor: microsoft }, opt, NOW, active);
    expect(marks.map((m) => `${m.label}:${m.state}`)).toEqual(["H-1B:yes", "PERM:no"]);
    expect(marks[1].reason).toBe("PERM suspended since Oct 8, 2026 (Department of Labor)");
    expect(marks[0].reason).toMatch(/LCAs on record, all years/);
  });
  it("applies before the company is looked up", () => {
    expect(visaMarks({}, opt, NOW, active).map((m) => m.state)).toEqual(["unknown", "no"]);
    expect(visaBadge({}, ead, NOW, active)).toEqual({ tone: "bad", text: "PERM suspended" });
  });
  it("hides the job for an EAD holder and warns an OPT student", () => {
    expect(visaBadge({ sponsor: microsoft }, ead, NOW, active)?.tone).toBe("bad");
    const badge = visaBadge({ sponsor: microsoft, visa: ["sponsors"] }, opt, NOW, active);
    expect(badge).toEqual({ tone: "warn", text: "H-1B 1.0k · PERM 7.5k · PERM suspended" });
  });
  it("does not matter to someone who only needs an H-1B", () => {
    const h1b = { workAuth: "h1b-transfer" as const, wantsGreenCard: false };
    expect(sponsorSummary(microsoft, h1b, NOW, active).tone).toBe("good");
  });
  it("replaces the quiet note with the suspension", () => {
    const s = sponsorSummary(microsoft, opt, NOW, active);
    expect(s.lines.join(" ")).not.toMatch(/No new PERM filing/);
    const without = sponsorSummary(microsoft, opt, NOW, []);
    expect(without.short).toMatch(/PERM quiet$/);
    expect(without.lines.join(" ")).toMatch(/No new PERM filing in 26 days, after 617 in the last 12 months/);
  });
});
