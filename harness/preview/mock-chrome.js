// Stands in for the chrome.* APIs so the built new-tab page can be previewed in
// a plain browser tab. ?state=key | onboarding | first | board | running
// ?visa=none previews a profile from before work authorization was a field.
(() => {
  const params = new URLSearchParams(location.search);
  const requested = params.get("state") || "board";
  const legacyVisa = params.get("visa") === "none";
  const running = requested === "running";
  const state = running ? "board" : requested;
  const day = 86400000;
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString();
  const profile = {
    roles: ["Software Engineer", "Frontend Engineer"],
    seniority: ["mid", "senior"],
    locations: ["San Francisco, CA", "New York, NY"],
    remoteOk: true,
    anywhereInUS: false,
    boards: { linkedin: true, indeed: true },
    companies: [{ ats: "greenhouse", slug: "figma", name: "Figma" }],
    resume: "Senior frontend engineer, 6 years React/TypeScript…",
    workAuth: legacyVisa ? "none" : "opt",
    wantsGreenCard: !legacyVisa,
    notes: legacyVisa ? "No crypto. Needs H-1B sponsorship." : "No crypto.",
  };
  // Illustrative filing records in PERM Tracker's shape; not real counts.
  const rec = (query, employer, lcas, decided, pending, newestDaysAgo, last12, match = "exact") => ({
    query, match, employer, url: "https://permtracker.app/perm-employers", h1bLcas: lcas,
    perm: decided + pending ? { decided, certified: Math.round(decided * 0.98), denied: Math.round(decided * 0.005), pending, newestFiling: iso(newestDaysAgo).slice(0, 10), filingsLast12Months: last12 } : null,
    asOf: "2026-06-30", checkedAt: iso(0),
  });
  const none = (query) => ({ query, match: "none", employer: null, url: "https://permtracker.app/perm-employers", h1bLcas: null, perm: null, asOf: "2026-06-30", checkedAt: iso(0) });
  // Same arithmetic as agent-core's freshnessPoints / totalScore.
  const freshness = (age) => (age <= 1 ? 10 : age <= 3 ? 8 : age <= 7 ? 6 : age <= 14 ? 4 : age <= 30 ? 2 : 0);
  const job = (id, title, company, location, source, [role, skills, place], extra = {}) => {
    const age = extra.age ?? 1;
    const breakdown = { role, skills, location: place, freshness: freshness(age), dealbreaker: extra.dealbreaker ?? null };
    const total = role + skills + place + breakdown.freshness;
    return {
      id, title, company, location, source, url: "https://example.com/" + id, remote: /remote/i.test(location),
      postedAt: iso(age), salary: extra.salary ?? null,
      matchScore: extra.dealbreaker ? Math.min(total, 29) : total, scoreBreakdown: extra.legacy ? undefined : breakdown,
      matchReasons: extra.reasons ?? ["6 yrs React + TypeScript matches the frontend platform focus", "Design-systems work lines up with the team"],
      concerns: [extra.dealbreaker, ...(extra.concerns ?? [])].filter(Boolean), take: extra.take ?? "", firstSeen: iso(extra.age ?? 0), lastSeen: iso(0),
      visa: extra.visa, sponsor: extra.sponsor,
    };
  };
  const jobs = [
    job("greenhouse:figma:1", "Senior Software Engineer, Editor Platform", "Figma", "San Francisco, CA • New York, NY", "greenhouse", [39, 30, 15], { salary: "$200K – $280K", sponsor: rec("Figma", "Figma, Inc.", 1420, 210, 18, 6, 41), take: "Your design-system rewrite is this team's roadmap; WebGL is the one gap." }),
    // PERM suspended by DOL on 2026-10-08 (visa-overrides.json); counts from PERM Tracker on 2026-10-12.
    job("linkedin:15", "Software Engineer II, Edge Web Platform", "Microsoft", "Redmond, WA", "linkedin", [33, 26, 15], { age: 1, sponsor: rec("Microsoft", "Microsoft Corporation", 58652, 6875, 598, 26, 617), take: "Browser platform work on your stack; check the green card timeline first." }),
    job("ashby:openai:2", "Frontend Software Engineer, ChatGPT", "OpenAI", "San Francisco", "ashby", [37, 29, 10], { salary: "$245K – $385K", sponsor: rec("OpenAI", "OpenAI OpCo, LLC", 2310, 160, 44, 3, 88), concerns: ["On-site 3 days a week"], take: "Product frontend at your level and top pay, if three office days work." }),
    job("linkedin:3", "Software Engineer II, Web", "Affirm", "Remote US", "linkedin", [28, 24, 15], { age: 2, sponsor: rec("Affirm", "Affirm, Inc.", 1650, 240, 12, 9, 30), concerns: ["Only the listing card was read", "Pay not listed"], take: "Mid level and fully remote: a solid fallback with a fast loop." }),
    job("greenhouse:coinbase:4", "Senior Frontend Engineer, Wallet", "Coinbase", "Remote - USA", "greenhouse", [38, 31, 15], { dealbreaker: "Crypto company; you said no crypto" }),
    job("indeed:5", "Staff Frontend Engineer", "Notion", "New York, NY", "indeed", [24, 28, 15], { age: 3, sponsor: rec("Notion", "Notion Labs, Inc.", 610, 64, 2, 170, 3, "possible"), concerns: ["Only the listing card was read"] }),
    job("lever:palantir:6", "Forward Deployed Software Engineer", "Palantir", "New York, NY", "lever", [22, 20, 15], { age: 5, visa: ["us-persons-only", "clearance"], dealbreaker: "U.S. citizens and green card holders only" }),
    job("greenhouse:stripe:7", "Software Engineer, Dashboard", "Stripe", "San Francisco, CA", "greenhouse", [34, 28, 15], { age: 9 }),
    job("greenhouse:reddit:8", "Senior Software Engineer, Web Platform", "Reddit", "San Francisco, CA", "greenhouse", [36, 22, 15], { age: 12 }),
    job("greenhouse:anthropic:9", "Staff+ Fullstack Software Engineer, Safeguards", "Anthropic", "San Francisco, CA | New York City, NY", "greenhouse", [26, 25, 10], { visa: ["sponsors"], sponsor: rec("Anthropic", "Anthropic, PBC", 980, 120, 31, 4, 64), concerns: ["One level above your target"], take: "Staff+ is a stretch, but the frontend share is large." }),
    job("greenhouse:dropbox:10", "Principal Software Engineer", "Dropbox", "Remote - US", "greenhouse", [18, 14, 15], { age: 2, visa: ["no-sponsorship"], dealbreaker: "Says it does not sponsor visas", concerns: ["Backend-leaning"] }),
    job("greenhouse:asana:11", "Software Engineer, AI Teammates Experience", "Asana", "San Francisco", "greenhouse", [30, 16, 10], { age: 1, sponsor: rec("Asana", "Asana, Inc.", 540, 70, 5, 30, 12) }),
    job("ashby:ramp:12", "Frontend Engineer, Bill Pay", "Ramp", "New York, NY", "ashby", [30, 18, 10], { age: 4, salary: "$190K – $250K" }),
    job("greenhouse:discord:13", "Senior Software Engineer, Web Client", "Discord", "Remote (US)", "greenhouse", [34, 14, 7], { age: 6 }),
    job("linkedin:14", "Frontend Engineer, Design Tools", "Northwind Labs", "New York, NY", "linkedin", [30, 15, 5], { age: 3, legacy: true, sponsor: none("Northwind Labs") }),
  ];
  const store = {};
  if (state !== "key") store.apiKey = "sk-ant-preview";
  if (state === "first" || state === "board") store.profile = profile;
  if (state === "board") {
    store.jobs = Object.fromEntries(jobs.map((j) => [j.id, j]));
    const entry = (steps, extra = {}) => {
      const history = steps.map(([status, daysAgo]) => ({ status, at: iso(daysAgo) }));
      const last = history[history.length - 1];
      return { status: last.status, updatedAt: last.at, history, ...extra };
    };
    store.jobStatuses = {
      "greenhouse:stripe:7": entry([["saved", 4], ["applied", 2]]),
      "greenhouse:reddit:8": entry([["applied", 12], ["interviewing", 1]], { note: "Recruiter screen Thu 2pm with Dana" }),
      "lever:palantir:6": entry([["saved", 5]]),
      "greenhouse:discord:13": entry([["applied", 9]], { note: "Referral from Sam" }),
      "ashby:ramp:12": entry([["applied", 16], ["rejected", 6]]),
      // Pruned from jobs since: the entry's own copy names it.
      "greenhouse:vercel:99": entry([["applied", 23]], { title: "Senior Frontend Engineer, Dashboard", company: "Vercel", url: "https://example.com/vercel" }),
      "greenhouse:plaid:98": entry([["applied", 30]], { title: "Software Engineer, Link", company: "Plaid", url: "https://example.com/plaid" }),
      "greenhouse:coinbase:4": entry([["dismissed", 1]]),
    };
    store.lastBuild = {
      timestamp: iso(0),
      summary: "5 new matches today. Figma's Editor Platform role is the standout: senior, frontend-heavy and in SF or NYC. OpenAI posted a ChatGPT frontend role yesterday — apply early.",
      added: ["greenhouse:figma:1", "ashby:openai:2", "linkedin:3", "greenhouse:coinbase:4", "indeed:5", "greenhouse:anthropic:9", "greenhouse:asana:11"],
    };
  }
  const listeners = [];
  const event = () => ({ addListener() {}, removeListener() {} });
  const chrome = {
    runtime: {
      id: "preview",
      connect() {
        const msgL = [];
        return {
          onMessage: { addListener: (f) => msgL.push(f), removeListener() {} },
          onDisconnect: event(),
          postMessage(m) {
            (globalThis.__posted ??= []).push(m.kind);
            if (m.kind === "subscribe") setTimeout(() => msgL.forEach((f) => f({ kind: "snapshot", state: running
              ? { running: true, phase: "analyzing", stepIndex: 3, detail: "read", narration: "Read 96 career-board candidates and 4 LinkedIn result pages. Scoring against the resume now — the Figma and OpenAI frontend roles look strongest so far.", logs: ["career boards: 96 new candidates from 46 companies", "mounted candidates.json -> /mnt/session/uploads/candidates.json (182311b)", "mounted boards/linkedin_0.html", "job pages: 8 of 10 descriptions read", "mounted boards/details.json", "sandbox:grep", "sandbox:read"], error: null }
              : { running: false, phase: null, stepIndex: 0, detail: "", narration: "", logs: [], error: null } })), 0);
          },
          disconnect() {},
        };
      },
      getURL: (p) => p,
      onMessage: event(),
    },
    storage: {
      local: {
        async get(keys) {
          const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(store);
          return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        async set(obj) {
          Object.assign(store, structuredClone(obj));
          const changes = Object.fromEntries(Object.keys(obj).map((k) => [k, { newValue: obj[k] }]));
          listeners.forEach((f) => f(changes, "local"));
        },
        async remove(k) { delete store[k]; },
      },
      onChanged: { addListener: (f) => listeners.push(f), removeListener() {} },
    },
  };
  globalThis.chrome = chrome;
  globalThis.browser = chrome;
})();
