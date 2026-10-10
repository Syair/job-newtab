import type Anthropic from "@anthropic-ai/sdk";
import { collectAtsJobs, type FetchLike } from "./ats";
import {
  DETAIL_DEFAULTS,
  detailUrl,
  extractBoardCards,
  extractDetail,
  extractPublicPosting,
  pickDetailCards,
  publicPostingUrl,
  type BoardCard,
  type BoardDetail,
} from "./board-details";
import { parseJobsFile } from "./jobs";
import type { JobProfile } from "./profile";
import { OUTPUT_PATH, buildKickoffMessage } from "./prompt";
import { DEFAULTS } from "./schemas";
import { SEARCH_DEFAULTS, buildSearchTargets } from "./search-urls";
import { STORAGE_KEYS, ensureAgent, ensureEnvironment, type ScoutModel } from "./setup";
import type {
  BoardPageRef,
  BrowserBridge,
  GetJobSourcesResult,
  JobScoutResult,
  KVStore,
  MountedFile,
  RunCallbacks,
  RunPhase,
} from "./types";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type CustomToolUse = Anthropic.Beta.Sessions.BetaManagedAgentsAgentCustomToolUseEvent;

/** Callbacks with the optionality resolved, so call sites don't repeat `?.`. */
interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(chunk: string): void;
  log(line: string): void;
}

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

/** Files mount under this root no matter what path you ask for. Ask for it directly. */
const UPLOAD_ROOT = "/mnt/session/uploads";

export interface RunOptions {
  client: Anthropic;
  bridge: BrowserBridge;
  store: KVStore;
  profile: JobProfile;
  /** Job IDs already shown in earlier builds; skipped so each build is about new openings. */
  seenJobIds?: Iterable<string>;
  /** How far back board searches look. Matches the rebuild interval. */
  freshnessHours?: number;
  /** Advances each build so board searches cycle through every role × place combination. */
  rotation?: number;
  /** Ignored when resuming: the session keeps the agent (and model) it started with. */
  model?: ScoutModel;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  /** Reattach to an existing session instead of creating one (e.g. after the host was killed mid-run). */
  resumeSessionId?: string;
  /** The user's tracker as text (`pipelineForAgent`), so the agent skips jobs already in it. */
  pipeline?: string | null;
  now?: Date;
}

export async function runJobScout(opts: RunOptions): Promise<JobScoutResult> {
  const { client, store, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };
  const now = opts.now ?? new Date();

  emit.phase("setup");
  const [agentId, environmentId] = await Promise.all([
    ensureAgent(client, store, opts.model),
    ensureEnvironment(client, store),
  ]);
  emit.log(`agent=${agentId} environment=${environmentId}`);

  let sessionId = opts.resumeSessionId;
  if (!sessionId) {
    emit.phase("session-create");
    const session = await client.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
      title: `Job scout ${now.toISOString().slice(0, 10)}`,
    });
    sessionId = session.id;
    await store.set(STORAGE_KEYS.activeSessionId, sessionId);
  }
  emit.log(`session=${sessionId}`);

  // Persist upload IDs so cleanup can still find them after a reattach.
  const uploadedFileIds: string[] = (await store.get<string[]>(STORAGE_KEYS.uploadedFileIds)) ?? [];
  const rememberUpload = async (id: string) => {
    uploadedFileIds.push(id);
    await store.set(STORAGE_KEYS.uploadedFileIds, uploadedFileIds);
  };

  let finalMessage = "";

  /**
   * Every path out of here must send a result. An `agent.custom_tool_use` that
   * never receives one leaves the session idle forever — the single
   * unrecoverable bug in this design.
   */
  const dispatch = async (event: CustomToolUse): Promise<void> => {
    try {
      if (event.name !== "getJobSources") throw new Error(`Unknown custom tool: ${event.name}`);
      const result = await runGetJobSources({
        ...opts,
        now,
        sessionId: sessionId!,
        rememberUpload,
        emit,
      });
      await client.beta.sessions.events.send(sessionId!, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        ],
      });
    } catch (err) {
      emit.log(`tool ${event.name} failed: ${String(err)}`);
      await client.beta.sessions.events.send(sessionId!, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            is_error: true,
            content: [{ type: "text", text: String(err) }],
          },
        ],
      });
    }
  };

  const observe = (event: SessionEvent) => {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            finalMessage += block.text;
            emit.text(block.text);
          }
        }
        break;
      case "agent.thinking":
        emit.phase("thinking");
        break;
      case "agent.tool_use":
        emit.phase("analyzing", event.name);
        emit.log(`sandbox:${event.name}`);
        break;
      case "session.error":
        emit.log(`session.error: ${JSON.stringify(event)}`);
        break;
    }
  };

  try {
    // ---- Open the stream BEFORE anything else. It only delivers events emitted
    // ---- after it opens; send first and the early transitions are gone.
    const stream = await client.beta.sessions.events.stream(sessionId, undefined, { signal });

    // ---- Then replay history. Covers the gap before the stream attached, and
    // ---- is what makes a reattach lossless.
    const history: SessionEvent[] = [];
    for await (const event of client.beta.sessions.events.list(sessionId)) {
      history.push(event);
    }

    const seen = new Set(history.map((e) => e.id));
    const answered = new Set(
      history
        .filter((e): e is Extract<SessionEvent, { type: "user.custom_tool_result" }> =>
          e.type === "user.custom_tool_result",
        )
        .map((e) => e.custom_tool_use_id),
    );
    const kickedOff = history.some((e) => e.type === "user.message");
    const alreadyDone = history.some(
      (e) => e.type === "session.status_idle" && e.stop_reason.type === "end_turn",
    );

    for (const event of history) observe(event);

    if (!alreadyDone) {
      // Re-answer any tool call that was left hanging when the stream dropped.
      for (const event of history) {
        if (event.type === "agent.custom_tool_use" && !answered.has(event.id)) {
          emit.log(`re-answering orphaned tool call ${event.id}`);
          await dispatch(event);
        }
      }

      if (!kickedOff) {
        await client.beta.sessions.events.send(sessionId, {
          events: [
            {
              type: "user.message",
              content: [{ type: "text", text: buildKickoffMessage({ now, profile: opts.profile, pipeline: opts.pipeline }) }],
            },
          ],
        });
      }

      for await (const event of stream) {
        if (signal?.aborted) throw new Error("aborted");

        // Live-preview events carry no `id` and are never terminal. They only
        // arrive if `event_deltas` was requested, but the stream union includes
        // them either way — reading `.id` off one would throw.
        if (event.type === "event_start" || event.type === "event_delta") continue;

        if (!seen.has(event.id)) {
          seen.add(event.id);
          observe(event);
          if (event.type === "agent.custom_tool_use") {
            await dispatch(event);
          }
        }

        // Terminal checks run for *every* event, including ones we've already
        // seen. `continue`-ing on a duplicate above would skip the terminal
        // event that arrived in the history fetch, and the loop would never end.
        if (event.type === "session.status_terminated") break;
        if (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") {
          emit.log(`idle: ${event.stop_reason.type}`);
          break;
        }
      }
    }

    emit.phase("writing");
    const deliverable = await collectDeliverable(client, sessionId, finalMessage, emit, signal);
    const parsed = parseJobsFile(deliverable.text, now);
    for (const reason of parsed.dropped) emit.log(`dropped job ${reason}`);
    emit.phase("done");
    return { jobs: parsed.file, dropped: parsed.dropped, sessionId, source: deliverable.source };
  } finally {
    // Privacy: the event log holds the resume, the profile and every page body
    // we sent, and uploads persist independently of the session. Delete both, always.
    emit.phase("cleanup");
    await Promise.allSettled(uploadedFileIds.map((id) => client.beta.files.delete(id)));
    await store.remove(STORAGE_KEYS.uploadedFileIds);
    await deleteSessionWhenSettled(client, sessionId!).catch(() => {});
    await store.remove(STORAGE_KEYS.activeSessionId);
  }
}

// ---------------------------------------------------------------------------
// the custom tool
// ---------------------------------------------------------------------------

interface ToolContext extends RunOptions {
  now: Date;
  sessionId: string;
  rememberUpload: (id: string) => Promise<void>;
  emit: Emit;
}

/** `relativePath` may include a folder (`boards/linkedin_0.html`); the upload gets the base name. */
async function mountFile(ctx: ToolContext, relativePath: string, body: string, type: string): Promise<MountedFile> {
  const filename = relativePath.split("/").pop()!;
  const upload = await ctx.client.beta.files.upload({ file: new File([body], filename, { type }) });
  await ctx.rememberUpload(upload.id);
  // Mount mid-session, while the session idles awaiting this very result.
  const resource = await ctx.client.beta.sessions.resources.add(ctx.sessionId, {
    type: "file",
    file_id: upload.id,
    mount_path: `${UPLOAD_ROOT}/${relativePath}`,
  });
  // The API re-roots every mount under /mnt/session/uploads. Report what it
  // resolved, not what we asked for, or the model greps a path that isn't there.
  ctx.emit.log(`mounted ${relativePath} -> ${resource.mount_path} (${body.length}b)`);
  return { mountPath: resource.mount_path, bytes: body.length };
}

async function runGetJobSources(ctx: ToolContext): Promise<GetJobSourcesResult> {
  const { profile, bridge, emit } = ctx;
  const seenIds = new Set(ctx.seenJobIds ?? []);
  const fetchImpl: FetchLike = bridge.fetch ?? ((url) => fetch(url));
  const failed: GetJobSourcesResult["failed"] = [];

  // ---- Company career boards: public JSON APIs, read directly.
  emit.phase("collecting", `${profile.companies.length} companies`);
  const ats = await collectAtsJobs(profile, { fetchImpl, seenIds, now: ctx.now });
  const listedNew = ats.jobs.length;
  for (const stat of ats.stats) {
    if (stat.error) failed.push({ url: `${stat.ats}:${stat.company}`, reason: stat.error });
  }
  emit.log(
    `career boards: ${listedNew} new candidates from ${ats.stats.length} companies` +
      (seenIds.size ? ` (${seenIds.size} known jobs skipped)` : ""),
  );

  let candidates: GetJobSourcesResult["candidates"] = null;
  if (ats.jobs.length > 0) {
    const body = JSON.stringify(ats.jobs, null, 1);
    candidates = { ...(await mountFile(ctx, "candidates.json", body, "application/json")), count: ats.jobs.length };
  }

  // ---- Job boards: search pages opened in the user's logged-in browser.
  const targets = buildSearchTargets(profile, {
    freshnessHours: ctx.freshnessHours ?? 24,
    max: SEARCH_DEFAULTS.max,
    rotation: ctx.rotation,
  });
  const boardPages: BoardPageRef[] = [];
  const cardsByPage: BoardCard[][] = [];
  if (targets.length > 0) {
    emit.phase("scraping", `${targets.length} search pages`);
    const scraped = await bridge.getPageHtml({ urls: targets.map((t) => t.url), loadDelayMs: DEFAULTS.loadDelayMs });
    failed.push(...scraped.failed);
    for (const [i, page] of scraped.pages.entries()) {
      const target = targets.find((t) => t.url === page.url);
      if (!target) continue;
      cardsByPage.push(extractBoardCards(target.board, page.html));
      try {
        const filename = `boards/${target.board}_${i}.html`;
        const mounted = await mountFile(ctx, filename, page.html, "text/html");
        boardPages.push({ ...mounted, board: target.board, role: target.role, where: target.where, url: page.url, title: page.title });
      } catch (err) {
        failed.push({ url: page.url, reason: `mount failed: ${String(err)}` });
      }
    }
  }

  // ---- Job pages for the most relevant board cards, so skills can be scored
  // from the description rather than the title alone.
  let boardDetails: GetJobSourcesResult["boardDetails"] = null;
  const picks = pickDetailCards(cardsByPage, { roles: profile.roles, seenIds, max: DETAIL_DEFAULTS.max });
  if (picks.length > 0) {
    emit.phase("scraping", `${picks.length} job pages`);
    const details: BoardDetail[] = [];
    const keep = (card: BoardCard, url: string, html: string) => {
      const detail = extractDetail(card, html);
      if (detail) details.push(detail);
      else failed.push({ url, reason: "no job description on the page (sign-in wall or removed posting?)" });
    };

    // LinkedIn: the public posting, fetched without cookies, one at a time. The
    // endpoint rate-limits signed-out reads, so back off on 429 and stop after
    // a second one rather than keep asking.
    const fetchPublic = bridge.fetchPublicText ?? ((url: string) => fetch(url, { credentials: "omit" }));
    let rateLimited = false;
    for (const card of picks) {
      const url = publicPostingUrl(card);
      if (!url) continue;
      if (rateLimited) {
        failed.push({ url, reason: "skipped: LinkedIn rate limit" });
        continue;
      }
      try {
        let res = await fetchPublic(url);
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, DETAIL_DEFAULTS.rateLimitBackoffMs));
          res = await fetchPublic(url);
          if (res.status === 429) rateLimited = true;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const detail = extractPublicPosting(card, await res.text());
        if (detail) details.push(detail);
        else failed.push({ url, reason: "no job description in the posting" });
      } catch (err) {
        failed.push({ url, reason: String(err) });
      }
      await new Promise((r) => setTimeout(r, DETAIL_DEFAULTS.publicFetchGapMs));
    }

    // Indeed: rendered on the server but behind bot checks, so read in the user's browser.
    const inTabs = picks.filter((c) => !publicPostingUrl(c));
    if (inTabs.length > 0) {
      const scraped = await bridge.getPageHtml({ urls: inTabs.map(detailUrl), loadDelayMs: DETAIL_DEFAULTS.loadDelayMs });
      failed.push(...scraped.failed);
      for (const page of scraped.pages) {
        const card = inTabs.find((c) => detailUrl(c) === page.url);
        if (card) keep(card, page.url, page.html);
      }
    }
    emit.log(`job pages: ${details.length} of ${picks.length} descriptions read`);
    if (details.length > 0) {
      try {
        const mounted = await mountFile(ctx, "boards/details.json", JSON.stringify(details, null, 1), "application/json");
        boardDetails = { ...mounted, count: details.length };
      } catch (err) {
        failed.push({ url: "boards/details.json", reason: `mount failed: ${String(err)}` });
      }
    }
  }

  if (!candidates && boardPages.length === 0) {
    throw new Error(
      `No job sources could be loaded. ` +
        (failed.length ? `Failures: ${failed.map((f) => `${f.url} (${f.reason})`).join("; ")}` : `No new matching openings today.`),
    );
  }

  return { candidates, companies: ats.stats, boardPages, boardDetails, failed, skippedAlreadySeen: seenIds.size };
}

// ---------------------------------------------------------------------------
// deliverable retrieval
// ---------------------------------------------------------------------------

async function collectDeliverable(
  client: Anthropic,
  sessionId: string,
  finalMessage: string,
  emit: Emit,
  signal?: AbortSignal,
): Promise<{ text: string; source: JobScoutResult["source"] }> {
  const output = await readSessionOutput(client, sessionId, emit);
  if (output) return { text: output, source: "session-output" };

  // The model sometimes answers with the JSON inline instead of writing it.
  if (JOBS_FENCE.test(finalMessage)) {
    emit.log("deliverable recovered from message fence");
    return { text: finalMessage, source: "message-fence" };
  }

  // The agent says it wrote the file but the Files API never listed it. The file
  // is still in the sandbox, so ask for its contents instead of losing the run.
  emit.log("no session output listed; asking the agent for the file contents");
  const reply = await askAgent(
    client,
    sessionId,
    `The file did not reach me. Read ${OUTPUT_PATH} and reply with its full contents in one \`\`\`json fenced block and nothing else. If the file is missing, write the JSON in the fence now.`,
    signal,
  ).catch((err) => {
    emit.log(`follow-up failed: ${String(err)}`);
    return "";
  });
  if (JOBS_FENCE.test(reply)) {
    emit.log(`deliverable recovered from follow-up (${reply.length}b)`);
    return { text: reply, source: "message-fence" };
  }

  throw new Error(
    `The agent produced no job list. Expected a file at ${OUTPUT_PATH}. ` +
      `Final message: ${finalMessage.slice(0, 400)}`,
  );
}

const JOBS_FENCE = /```(?:json)?\s*\n[\s\S]*"jobs"/;

/**
 * Outputs appear in `files.list` a little after the session goes idle, usually
 * within seconds but sometimes much later, so retry for about half a minute.
 * The file holds the user's matches, so it is deleted once read.
 */
async function readSessionOutput(client: Anthropic, sessionId: string, emit: Emit): Promise<string | null> {
  const delays = [1, 2, 3, 4, 5, 6, 8];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      for await (const file of client.beta.files.list({
        scope_id: sessionId,
        betas: [MANAGED_AGENTS_BETA],
      })) {
        if (!/\.json$/.test(file.filename)) continue;
        const response = await client.beta.files.download(file.id);
        const text = await response.text();
        if (text.trim()) {
          emit.log(`deliverable from session output: ${file.filename} (${text.length}b, attempt ${attempt + 1})`);
          await client.beta.files.delete(file.id).catch(() => {});
          return text;
        }
      }
    } catch (err) {
      emit.log(`files.list attempt ${attempt + 1} failed: ${String(err)}`);
    }
    if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt] * 1000));
  }
  return null;
}

/** Send one more message to an idle session and return the agent's reply text. */
async function askAgent(client: Anthropic, sessionId: string, text: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(180_000);
  const stream = await client.beta.sessions.events.stream(sessionId, undefined, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  let reply = "";
  // Ignore an idle status that was already pending when the stream opened.
  let answered = false;
  for await (const event of stream) {
    if (event.type === "event_start" || event.type === "event_delta") continue;
    if (event.type === "agent.message") {
      answered = true;
      for (const block of event.content) if (block.type === "text") reply += block.text;
    }
    if (event.type === "agent.tool_use" || event.type === "agent.thinking") answered = true;
    if (event.type === "session.status_terminated") break;
    if (answered && event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") break;
  }
  return reply;
}

/**
 * The stream reports idle slightly before the session's queryable status catches
 * up; deleting immediately intermittently 400s with "cannot delete while running".
 */
async function deleteSessionWhenSettled(client: Anthropic, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const session = await client.beta.sessions.retrieve(sessionId);
    if (session.status !== "running") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await client.beta.sessions.delete(sessionId);
}
