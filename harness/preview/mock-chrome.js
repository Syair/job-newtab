// Stands in for the chrome.* APIs so the built new-tab page can be previewed in
// a plain browser tab. ?state=key | onboarding | first | board | running
(() => {
  const requested = new URLSearchParams(location.search).get("state") || "board";
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
    notes: "No crypto. Needs H-1B sponsorship.",
  };
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
    };
  };
  const jobs = [
    job("greenhouse:figma:1", "Senior Software Engineer, Editor Platform", "Figma", "San Francisco, CA • New York, NY", "greenhouse", [39, 30, 15], { salary: "$200K – $280K", take: "Your design-system rewrite is this team's roadmap; WebGL is the one gap." }),
    job("ashby:openai:2", "Frontend Software Engineer, ChatGPT", "OpenAI", "San Francisco", "ashby", [37, 29, 10], { salary: "$245K – $385K", concerns: ["On-site 3 days a week"], take: "Product frontend at your level and top pay, if three office days work." }),
    job("linkedin:3", "Software Engineer II, Web", "Affirm", "Remote US", "linkedin", [28, 24, 15], { age: 2, concerns: ["Only the listing card was read", "Pay not listed"], take: "Mid level and fully remote: a solid fallback with a fast loop." }),
    job("greenhouse:coinbase:4", "Senior Frontend Engineer, Wallet", "Coinbase", "Remote - USA", "greenhouse", [38, 31, 15], { dealbreaker: "Crypto company; you said no crypto" }),
    job("indeed:5", "Staff Frontend Engineer", "Notion", "New York, NY", "indeed", [24, 28, 15], { age: 3, concerns: ["Only the listing card was read"] }),
    job("lever:palantir:6", "Forward Deployed Software Engineer", "Palantir", "New York, NY", "lever", [22, 20, 15], { age: 5 }),
    job("greenhouse:stripe:7", "Software Engineer, Dashboard", "Stripe", "San Francisco, CA", "greenhouse", [34, 28, 15], { age: 9 }),
    job("greenhouse:reddit:8", "Senior Software Engineer, Web Platform", "Reddit", "San Francisco, CA", "greenhouse", [36, 22, 15], { age: 12 }),
    job("greenhouse:anthropic:9", "Staff+ Fullstack Software Engineer, Safeguards", "Anthropic", "San Francisco, CA | New York City, NY", "greenhouse", [26, 25, 10], { concerns: ["One level above your target"], take: "Staff+ is a stretch, but the frontend share is large." }),
    job("greenhouse:dropbox:10", "Principal Software Engineer", "Dropbox", "Remote - US", "greenhouse", [18, 14, 15], { age: 2, concerns: ["Backend-leaning"] }),
    job("greenhouse:asana:11", "Software Engineer, AI Teammates Experience", "Asana", "San Francisco", "greenhouse", [30, 16, 10], { age: 1 }),
    job("ashby:ramp:12", "Frontend Engineer, Bill Pay", "Ramp", "New York, NY", "ashby", [30, 18, 10], { age: 4, salary: "$190K – $250K" }),
    job("greenhouse:discord:13", "Senior Software Engineer, Web Client", "Discord", "Remote (US)", "greenhouse", [34, 14, 7], { age: 6 }),
    job("linkedin:14", "Frontend Engineer, Design Tools", "Northwind Labs", "New York, NY", "linkedin", [30, 15, 5], { age: 3, legacy: true }),
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
