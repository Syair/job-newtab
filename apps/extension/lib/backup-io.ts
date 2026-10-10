import { makeBackup, mergeBackup, parseBackup, type BackupData } from "@job-newtab/agent-core";
import { KEYS, loadJobs, loadLastBuild, loadProfile, loadSettings, loadStatuses, extensionStore } from "./storage";

/** Everything worth keeping, read from chrome.storage.local. Never the API key. */
async function readBackupData(): Promise<BackupData> {
  const [profile, settings, jobs, statuses, lastBuild, buildCount] = await Promise.all([
    loadProfile(),
    loadSettings(),
    loadJobs(),
    loadStatuses(),
    loadLastBuild(),
    extensionStore.get<number>(KEYS.buildCount),
  ]);
  return {
    profile,
    settings: {
      model: settings.model,
      autoRebuild: settings.autoRebuild,
      rebuildIntervalHours: settings.rebuildIntervalHours,
    },
    jobs,
    statuses,
    lastBuild: lastBuild ?? null,
    buildCount: buildCount ?? 0,
  };
}

/** Save a backup file through the browser's normal download. */
export async function downloadBackup(): Promise<void> {
  const now = new Date();
  const file = makeBackup(await readBackupData(), now);
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `job-newtab-backup-${now.toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface RestoreResult {
  jobs: number;
  tracked: number;
  exportedAt: string;
}

/**
 * Restore a backup file: profile and settings come from the file, jobs and the
 * tracker are merged with what is here. Throws a readable message on a bad file.
 */
export async function restoreBackup(file: File): Promise<RestoreResult> {
  const incoming = parseBackup(await file.text());
  const merged = mergeBackup(await readBackupData(), incoming);
  const write: Record<string, unknown> = {
    [KEYS.jobs]: merged.jobs,
    [KEYS.statuses]: merged.statuses,
    [KEYS.buildCount]: merged.buildCount,
  };
  if (merged.profile) write[KEYS.profile] = merged.profile;
  if (merged.lastBuild) write[KEYS.lastBuild] = merged.lastBuild;
  if (typeof merged.settings.model === "string") write[KEYS.model] = merged.settings.model;
  if (typeof merged.settings.autoRebuild === "boolean") write[KEYS.autoRebuild] = merged.settings.autoRebuild;
  if (typeof merged.settings.rebuildIntervalHours === "number") {
    write[KEYS.rebuildIntervalHours] = merged.settings.rebuildIntervalHours;
  }
  await browser.storage.local.set(write);
  return {
    jobs: Object.keys(incoming.jobs).length,
    tracked: Object.keys(incoming.statuses).length,
    exportedAt: incoming.exportedAt,
  };
}

/** Open the file picker and restore the chosen file. Resolves null if the user cancels. */
export function pickAndRestoreBackup(): Promise<RestoreResult | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      restoreBackup(file).then(resolve, reject);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
