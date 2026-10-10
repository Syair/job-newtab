import Anthropic from "@anthropic-ai/sdk";
import {
  mergeJobs,
  pipelineForAgent,
  profileProblems,
  runJobScout,
  trackedJobs,
  type RunPhase,
} from "@job-newtab/agent-core";
import { rebuildIntervalHours, rebuildIntervalMs, shouldAutoRebuild } from "./auto-rebuild";
import { browserBridge } from "./browser-bridge";
import {
  INITIAL_BUILD_STATE,
  LOG_RETENTION,
  stepForPhase,
  type BuildMsg,
  type BuildState,
  type PageMsg,
} from "./protocol";
import {
  KEYS,
  extensionStore,
  loadJobs,
  loadLastBuild,
  loadProfile,
  loadSettings,
  loadStatuses,
  type LastBuild,
} from "./storage";

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

/**
 * While a turn is active, ping a cheap chrome API on this interval to reset the
 * ~30s MV3 idle-unload timer. The ~1 min alarm heartbeat is the slower safety
 * net that reattaches after an unexpected kill.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;

/** Storage snapshots are throttled so narration deltas don't flood chrome.storage. */
const SNAPSHOT_THROTTLE_MS = 2_000;
/** A late-joining tab doesn't need the whole narration, just enough to look alive. */
const NARRATION_STORAGE_CAP = 2_000;

/**
 * Owns the single build. Runs `runJobScout` in the worker, holds live state,
 * enforces a single-flight lock, broadcasts progress to every connected tab,
 * mirrors a throttled snapshot to storage, and reattaches to an interrupted run
 * on wake.
 *
 * There is one instance per service worker — i.e. one per browser profile — so
 * single-flight is per-profile, which is the right grain.
 */
export class BuildManager {
  private state: BuildState = { ...INITIAL_BUILD_STATE };
  private readonly ports = new Set<Port>();
  private controller: AbortController | null = null;
  private running = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- port lifecycle ------------------------------------------------------

  attach(port: Port) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => this.onPageMessage(port, raw as PageMsg));
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  private onPageMessage(port: Port, msg: PageMsg) {
    switch (msg.kind) {
      case "subscribe":
        this.send(port, { kind: "snapshot", state: this.state });
        break;
      case "startBuild":
        void this.startBuild({ resume: msg.resume });
        break;
      case "cancel":
        this.cancel();
        break;
    }
  }

  private send(port: Port, msg: BuildMsg) {
    try {
      port.postMessage(msg);
    } catch {
      // Port went away between the has-check and the post; drop it.
      this.ports.delete(port);
    }
  }

  private broadcast(msg: BuildMsg) {
    for (const port of [...this.ports]) this.send(port, msg);
  }

  // ---- heartbeat -----------------------------------------------------------

  /**
   * Called on worker wake and on every alarm tick. If a session was left
   * mid-flight, reattach and continue (lossless — the orchestrator replays the
   * event log and re-answers orphaned tool calls). Otherwise, consider the daily
   * rebuild. The single-flight lock is the arbiter that keeps these from racing.
   */
  async tick() {
    if (this.running) {
      // A run is live but the worker may have just woken; make sure the
      // self-keepalive is ticking so the active turn stays warm.
      this.startKeepalive();
      return;
    }

    const sessionId = await extensionStore.get<string>(KEYS.activeSessionId);
    if (sessionId) {
      void this.startBuild({ resume: true });
      return;
    }

    await this.maybeAutoRebuild();
  }

  /** Whether opening the day's first tab should already show today's jobs. */
  private async maybeAutoRebuild() {
    const [settings, lastBuild, lastAttempt] = await Promise.all([
      loadSettings(),
      loadLastBuild(),
      extensionStore.get<string>(KEYS.lastAutoBuildAttempt),
    ]);
    const now = new Date();

    if (
      !shouldAutoRebuild({
        enabled: settings.autoRebuild,
        hasApiKey: Boolean(settings.apiKey),
        isRunning: this.running,
        lastBuildTimestamp: lastBuild?.timestamp,
        lastAutoAttemptTimestamp: lastAttempt,
        intervalMs: rebuildIntervalMs(settings.rebuildIntervalHours),
        now,
      })
    ) {
      return;
    }

    // Stamp the attempt before starting so a second wake (or a cancel/failure)
    // doesn't re-trigger it within the interval.
    await extensionStore.set(KEYS.lastAutoBuildAttempt, now.toISOString());
    void this.startBuild({ resume: false });
  }

  // ---- the build -----------------------------------------------------------

  async startBuild(opts: { resume?: boolean } = {}) {
    if (this.running) {
      console.log("[BuildManager] startBuild ignored — a build is already running");
      return; // single-flight: a second start just attaches.
    }

    const [{ apiKey, model, rebuildIntervalHours: intervalHours }, profile] = await Promise.all([
      loadSettings(),
      loadProfile(),
    ]);
    // Manual builds are gated behind key setup and onboarding, and auto-builds
    // need both, so these only trip if a key or profile was removed.
    const blocker = !apiKey
      ? "No Anthropic API key found. Add your key and try again."
      : !profile
        ? "Set up your job profile first."
        : profileProblems(profile)[0];
    if (blocker || !apiKey || !profile) {
      console.warn("[BuildManager] startBuild aborted —", blocker);
      const message = blocker ?? "Cannot start a build.";
      this.state = { ...INITIAL_BUILD_STATE, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      return;
    }

    this.running = true;
    this.controller = new AbortController();
    this.state = { ...INITIAL_BUILD_STATE, running: true, phase: "setup" };
    this.broadcast({ kind: "snapshot", state: this.state });
    this.startKeepalive();
    console.log("[BuildManager] build started", { resume: Boolean(opts.resume) });

    try {
      // The key is the user's own, read from local storage — there is no server
      // to hide it behind. See ARCHITECTURE.md → Privacy.
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

      const resumeSessionId = opts.resume
        ? await extensionStore.get<string>(KEYS.activeSessionId)
        : undefined;

      const [storedJobs, statuses, buildCount] = await Promise.all([
        loadJobs(),
        loadStatuses(),
        extensionStore.get<number>(KEYS.buildCount),
      ]);

      const result = await runJobScout({
        client,
        bridge: browserBridge,
        store: extensionStore,
        profile,
        // Anything shown before — or acted on and since pruned — is not new.
        seenJobIds: new Set([...Object.keys(storedJobs), ...Object.keys(statuses)]),
        // What the user applied to, saved and turned down, so the agent skips and learns from it.
        pipeline: pipelineForAgent(trackedJobs(storedJobs, statuses), new Date()),
        freshnessHours: rebuildIntervalHours(intervalHours),
        rotation: buildCount ?? 0,
        model,
        resumeSessionId,
        signal: this.controller.signal,
        callbacks: {
          onPhase: (phase, detail) => this.onPhase(phase, detail),
          onText: (chunk) => this.onText(chunk),
          onLog: (line) => this.onLog(line),
        },
      });

      // Re-read: a long build may overlap a previous tab's writes. Only this
      // worker writes jobs, and statuses are only read here.
      const now = new Date();
      const merged = mergeJobs(await loadJobs(), result.jobs.jobs, {
        now,
        statuses: Object.fromEntries(Object.entries(await loadStatuses()).map(([id, e]) => [id, e.status])),
      });
      const lastBuild: LastBuild = {
        timestamp: now.toISOString(),
        summary: result.jobs.summary,
        added: merged.added,
      };
      await browser.storage.local.set({
        [KEYS.jobs]: merged.jobs,
        [KEYS.lastBuild]: lastBuild,
        [KEYS.buildCount]: (buildCount ?? 0) + 1,
      });

      this.state = { ...this.state, running: false, phase: "done" };
      this.broadcast({ kind: "done", added: merged.added.length });
      this.notifyNewJobs(merged.added.length);
      await this.mirror(true);
      console.log("[BuildManager] build done", {
        jobs: result.jobs.jobs.length,
        added: merged.added.length,
        dropped: result.dropped.length,
        source: result.source,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, running: false, phase: "error", error: message };
      this.broadcast({ kind: "error", message });
      await this.mirror(true);
      this.notifyFailure(message);
      console.error("[BuildManager] build failed", error);
    } finally {
      this.running = false;
      this.controller = null;
      this.stopKeepalive();
    }
  }

  cancel() {
    this.controller?.abort();
  }

  // ---- callback fan-out ----------------------------------------------------

  private onPhase(phase: RunPhase, detail?: string) {
    const mapped = stepForPhase(phase);
    const stepIndex =
      mapped === undefined ? this.state.stepIndex : Math.max(this.state.stepIndex, mapped);
    this.state = { ...this.state, phase, stepIndex, detail: detail ?? "" };
    this.broadcast({ kind: "phase", phase, stepIndex, detail: detail ?? "" });
    void this.mirror(false);
  }

  private onText(chunk: string) {
    this.state = { ...this.state, narration: this.state.narration + chunk };
    this.broadcast({ kind: "text", chunk });
    void this.mirror(false);
  }

  private onLog(line: string) {
    this.state = { ...this.state, logs: [...this.state.logs.slice(-LOG_RETENTION), line] };
    this.broadcast({ kind: "log", line });
    void this.mirror(false);
  }

  // ---- storage mirror ------------------------------------------------------

  /**
   * Mirror a lightweight snapshot to storage so a tab that opens while the worker
   * is asleep paints last-known state instantly; the heartbeat then revives the
   * live run. Deltas go over the port; storage only gets a throttled snapshot.
   */
  private async mirror(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) {
      this.snapshotTimer ??= setTimeout(() => {
        this.snapshotTimer = null;
        void this.mirror(true);
      }, SNAPSHOT_THROTTLE_MS);
      return;
    }

    this.lastSnapshotAt = now;
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    const trimmed: BuildState = {
      ...this.state,
      narration: this.state.narration.slice(-NARRATION_STORAGE_CAP),
      logs: this.state.logs.slice(-LOG_RETENTION),
    };
    await extensionStore.set(KEYS.buildSnapshot, trimmed);
  }

  // ---- worker keepalive ----------------------------------------------------

  private startKeepalive() {
    this.keepalive ??= setInterval(() => {
      // A cheap chrome API call resets the ~30s idle-unload timer while a turn is
      // in flight (the in-flight session fetch does most of the work; this covers
      // the gaps between requests).
      void browser.runtime.getPlatformInfo();
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  // ---- headless results ----------------------------------------------------

  /** A scheduled build with no tab open would otherwise go unnoticed until the next new tab. */
  private notifyNewJobs(count: number) {
    if (this.ports.size > 0 || count === 0) return;
    try {
      browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: count === 1 ? "1 new job match" : `${count} new job matches`,
        message: "Open a new tab to see them.",
      });
    } catch {
      // notifications permission missing or API unavailable — the new tab still shows them.
    }
  }

  // ---- failure surfacing ---------------------------------------------------

  private notifyFailure(message: string) {
    // Only ping when nobody is watching — an open tab already shows the error
    // inline. A headless daily build that fails otherwise vanishes silently.
    if (this.ports.size > 0) return;
    try {
      browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: "Job search failed",
        message: message.slice(0, 200),
      });
    } catch {
      // notifications permission missing or API unavailable — nothing else to do.
    }
  }
}
