/**
 * Protocol between the new-tab page(s) and the service worker.
 *
 * The worker owns exactly one build at a time and is the single source of truth
 * for its state (see build-manager.ts). Tabs are thin, disposable views: they
 * connect on AGENT_PORT, receive a snapshot, then stream deltas.
 */
import type { RunPhase } from "@job-newtab/agent-core";

export const AGENT_PORT = "job-scout";

/** Live build state. The worker holds the canonical copy; tabs reduce into a mirror. */
export interface BuildState {
  running: boolean;
  phase: RunPhase | null;
  /** High-water index into BUILD_STEPS — only advances, so interleaved phases don't rewind the stepper. */
  stepIndex: number;
  detail: string;
  narration: string;
  logs: string[];
  error: string | null;
}

export const INITIAL_BUILD_STATE: BuildState = {
  running: false,
  phase: null,
  stepIndex: 0,
  detail: "",
  narration: "",
  logs: [],
  error: null,
};

/** How many recent log lines are kept (and shown). */
export const LOG_RETENTION = 40;

// page → worker
export type PageMsg =
  | { kind: "subscribe" } //                    → replies with a snapshot
  | { kind: "startBuild"; resume?: boolean } // no-op if one is already running
  | { kind: "cancel" }
  | { kind: "refreshSponsors" }; // fill in employer filing records for jobs that lack them

// worker → page (broadcast to every connected tab)
export type BuildMsg =
  | { kind: "snapshot"; state: BuildState }
  | { kind: "phase"; phase: RunPhase; stepIndex: number; detail: string }
  | { kind: "text"; chunk: string } // narration delta
  | { kind: "log"; line: string }
  | { kind: "done"; added: number } // jobs saved; how many are new
  | { kind: "error"; message: string };

/**
 * The stages a person cares about. The agent emits finer-grained phases
 * that interleave (thinking ↔ analyzing fire repeatedly); each maps to a step
 * here. `thinking` and `error` deliberately map to none, so they never move the
 * stepper.
 */
export const BUILD_STEPS: { label: string; phases: RunPhase[] }[] = [
  { label: "Preparing agent", phases: ["setup", "session-create"] },
  { label: "Checking company career boards", phases: ["collecting"] },
  { label: "Reading LinkedIn and Indeed", phases: ["scraping"] },
  { label: "Scoring matches", phases: ["analyzing"] },
  { label: "Saving your jobs", phases: ["writing", "cleanup", "done"] },
];

/** Which step a phase belongs to, or `undefined` if it shouldn't move the stepper. */
export function stepForPhase(phase: RunPhase): number | undefined {
  const i = BUILD_STEPS.findIndex((step) => step.phases.includes(phase));
  return i === -1 ? undefined : i;
}
