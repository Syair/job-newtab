import {
  DEFAULT_MODEL,
  MODEL_CHOICES,
  STORAGE_KEYS as AGENT_KEYS,
  normalizeProfile,
  type JobProfile,
  type JobStatus,
  applyStatus,
  type KVStore,
  type LastBuild,
  type ScoutModel,
  type StatusEntry,
  type StoredJob,
} from "@job-newtab/agent-core";

export type { LastBuild, StatusEntry };

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key and the resume, which anyone with
 * access to the browser profile can read. Fine for a tool you run yourself (see
 * README → Privacy).
 */
export const KEYS = {
  ...AGENT_KEYS,
  profile: "profile",
  model: "model",
  autoRebuild: "autoRebuild",
  rebuildIntervalHours: "autoRebuildIntervalHours",
  /** ISO timestamp of the last auto-build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
  /** Every job found, keyed by job id. Written only by the worker. */
  jobs: "jobs",
  /** What the user did with each job. Written only by the new-tab page. */
  statuses: "jobStatuses",
  /** The latest build's summary. */
  lastBuild: "lastBuild",
  /** Completed builds so far; drives the rotation through board searches. */
  buildCount: "buildCount",
} as const;

export interface Settings {
  apiKey: string | null;
  model: ScoutModel;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
  rebuildIntervalHours: number | null;
}

/** The `KVStore` agent-core persists its agent/environment/session IDs through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([KEYS.apiKey, KEYS.model, KEYS.autoRebuild, KEYS.rebuildIntervalHours]);
  const model = s[KEYS.model] as string | undefined;
  return {
    apiKey: (s[KEYS.apiKey] as string | undefined) ?? null,
    // Fall back if a stored model is no longer offered.
    model: MODEL_CHOICES.find((m) => m.id === model)?.id ?? DEFAULT_MODEL,
    autoRebuild: s[KEYS.autoRebuild] !== false,
    rebuildIntervalHours: (s[KEYS.rebuildIntervalHours] as number | undefined) ?? null,
  };
}

export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

export async function loadProfile(): Promise<JobProfile | null> {
  const raw = await extensionStore.get<Partial<JobProfile>>(KEYS.profile);
  return raw ? normalizeProfile(raw) : null;
}

export async function saveProfile(profile: JobProfile): Promise<void> {
  await extensionStore.set(KEYS.profile, profile);
}

export async function loadJobs(): Promise<Record<string, StoredJob>> {
  return (await extensionStore.get<Record<string, StoredJob>>(KEYS.jobs)) ?? {};
}

export async function loadStatuses(): Promise<Record<string, StatusEntry>> {
  return (await extensionStore.get<Record<string, StatusEntry>>(KEYS.statuses)) ?? {};
}

/**
 * Read-modify-write of one entry, keeping its history and a copy of the job's
 * title and company. Only the page writes statuses, so this can't race the worker.
 */
export async function setJobStatus(id: string, status: JobStatus | null): Promise<Record<string, StatusEntry>> {
  const [statuses, jobs] = await Promise.all([loadStatuses(), loadJobs()]);
  const next = applyStatus(statuses[id], status, jobs[id], new Date());
  if (next) statuses[id] = next;
  else delete statuses[id];
  await extensionStore.set(KEYS.statuses, statuses);
  return statuses;
}

/** The user's note on a tracked job. */
export async function setJobNote(id: string, note: string): Promise<Record<string, StatusEntry>> {
  const statuses = await loadStatuses();
  if (statuses[id]) {
    statuses[id] = { ...statuses[id], note: note.slice(0, 2000) };
    await extensionStore.set(KEYS.statuses, statuses);
  }
  return statuses;
}

export async function loadLastBuild(): Promise<LastBuild | undefined> {
  return extensionStore.get<LastBuild>(KEYS.lastBuild);
}
