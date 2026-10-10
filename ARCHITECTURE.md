# Architecture

There is no server. Three parties are involved, and you run one of them.

| | Runs where | Does what |
|---|---|---|
| **Extension** (service worker) | Your browser | Hosts the build: fetches ATS APIs, opens board searches, uploads files, merges results |
| **Extension** (new-tab page) | Your browser | Onboarding, the job board and tracker; a thin view onto the worker's build |
| **Orchestration layer** | Anthropic | Runs the agent loop, persists the session event log, emits `agent.custom_tool_use` |
| **Session sandbox** | Anthropic | Runs `read` / `grep` / `glob` / `write` over the mounted files |

## Data flow

```
profile (chrome.storage)
   │
   ├─▶ collectAtsJobs ──▶ Greenhouse / Lever / Ashby public APIs
   │      filter: role words, level, US location, age, already-seen ids
   │      capFairly: ≤120, round-robin across companies
   │                                   └─▶ candidates.json ─┐
   ├─▶ buildSearchTargets ──▶ LinkedIn / Indeed URLs        │  mounted into
   │      roles × places, freshness = rebuild interval      │  the session
   │      ≤6 per build, rotating                            │  sandbox
   │                └─▶ scraper (background window) ─▶ boards/*.html
   │                       │                                │
   │      extractBoardCards: job ids + titles from links    │
   │      pickDetailCards: role match, not seen, ≤10        │
   │                └─▶ LinkedIn public posting / Indeed tab ─▶ boards/details.json
   │                                                        │
   └─▶ kickoff message (profile + resume) ──▶ agent ◀───────┘
                                               │ grep / read / score
                                               ▼
                                   /mnt/session/outputs/jobs.json
                                               │
                         parseJobsFile (validate, clamp, dedupe)
                                               │
                         mergeJobs (firstSeen, cross-source twins, retention)
                                               ▼
                                   chrome.storage: jobs, lastBuild
```

The agent has exactly one custom tool, `getJobSources`, and it takes **no arguments**: which APIs are called and which pages are opened is decided in code from the profile. A prompt injection in a job description cannot steer the browser. The same holds for job pages: their ids are read from links on the search pages, and `detailUrl` rebuilds each URL from the id alone (`linkedin.com/jobs/view/<id>/`, `indeed.com/viewjob?jk=<id>`), so a page can only point at another job on the same board.

Search pages show cards only, so for up to 20 board jobs per search the code also reads the job's own posting and cuts out the description. LinkedIn's signed-in search (`/jobs/search-results/`) renders cards as `<div componentkey="job-card-component-ref-<id>">` with no links, so the scraper content script lists them as real `/jobs/view/<id>/` links at the end of the page HTML; it also scrolls the page's inner panels and waits for the text to stop growing. LinkedIn's signed-in job page only renders the description in a visible tab, and the scraper's tabs are hidden, so LinkedIn postings are read instead from LinkedIn's public posting endpoint (`/jobs-guest/jobs/api/jobPosting/<id>`), fetched without cookies, one per second, stopping after a repeated 429. `extractPublicPosting` reads its `show-more-less-html__markup` block, which does not depend on the page language. Indeed postings are server-rendered and open in a tab. Pages with no recognizable description (sign-in wall, captcha, removed posting) are reported as failed. A board job without a description gets at most 20 of 35 for skills.

The model never writes UI. It writes `jobs.json`: a one- or two-sentence summary and the scored jobs, each with a one-sentence `take` for this person, short reasons and concerns. `parseJobsFile` validates all of it (absolute http(s) URLs, known sources, text capped). The new-tab page's Today view is a fixed, hand-designed queue: every open match on one line, best fit first, with follow-ups due and saved jobs above it. The summary sits at the top; the take, reasons, concerns and score parts open inside each row.

### Fit score

The agent does not write the total. For each job it judges three parts and names any broken rule; the code adds the rest and does the arithmetic, so the total always matches the breakdown the page shows.

| Part | Points | From |
|---|---|---|
| Role | 0–40 | agent: title, function and level against the target roles |
| Skills | 0–35, or null | agent: resume against the description; null without a resume |
| Location | 0–15 | agent: place and work setup against the profile |
| Freshness | 0–10 | code: `postedAt` at build time (≤1 day 10, ≤3 8, ≤7 6, ≤14 4, ≤30 2, older 0, unknown 5) |

Without a resume the other three parts are scaled from 65 to 100. A `dealbreaker` caps the total at 29 and becomes the first concern. Each part is clamped to its range; jobs from before breakdowns existed (or a malformed `score`) keep a plain `matchScore`.

## Storage ownership

| Key | Written by | Read by |
|---|---|---|
| `profile`, settings | page | worker |
| `jobs`, `lastBuild`, `buildCount` | worker (after each build) | page |
| `jobStatuses` | page (save / apply / dismiss, notes) | worker (seen ids, retention, the agent's pipeline) |

Each key has a single writer, so a build that finishes while you are triaging cannot overwrite your statuses. Pages listen to `storage.onChanged`, so every open tab stays in sync.

### Tracker

A `StatusEntry` (`packages/agent-core/tracker.ts`) keeps the current status, every change (`history`), the user's note, and a copy of the job's title, company and link, so a tracked job is still named after the job itself is pruned. `appliedAt` is the first change into applied or later. The Tracker view (`#tracker`) builds its tiles, weekly chart, "needs attention" list and table from `trackedJobs`. Before each search the worker passes `pipelineForAgent` (in flight, saved, "Not for me", closed, follow-ups due; capped per group) into the kickoff message; the prompt says never to re-list those jobs and to treat "Not for me" as taste, not a rule.

### Backup

`packages/agent-core/backup.ts` defines the file (`format: "job-newtab-backup"`, `version: 1`): profile, settings, jobs, statuses, last build and build count, never the API key. A restore replaces profile and settings and merges the rest: jobs are unioned (later `lastSeen` wins) and for each status the later `updatedAt` wins, so restoring onto a browser with newer data loses nothing. `apps/extension/lib/backup-io.ts` reads and writes `chrome.storage.local` and downloads through a blob link, so no `downloads` permission is needed.

## Inherited from ai-newtab

The service-worker build host is unchanged in design (`lib/build-manager.ts`): single-flight builds, broadcast to every open tab over a port, a 20 s self-ping plus a 1-minute alarm heartbeat that reattaches to an interrupted session. The session loop is unchanged too (`packages/agent-core/orchestrator.ts`): open the stream before sending, replay history, re-answer orphaned tool calls, break only on a real idle. The gotchas documented in ai-newtab's ARCHITECTURE.md still apply:

- `mount_path` is re-rooted under `/mnt/session/uploads/`. Report `resource.mount_path`, never the requested path.
- The tool-result field is `custom_tool_use_id`.
- Never leave an `agent.custom_tool_use` unanswered: errors become `is_error: true` results.
- Don't break on `session.status_idle` when `stop_reason.type === "requires_action"`.

Agents are cached per model. When the prompt or tool list changes, bump `AGENT_CONFIG_VERSION` in `prompt.ts` and the cached agent is updated in place on the next build.
