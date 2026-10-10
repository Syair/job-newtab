/**
 * Backup files: everything a user would lose by removing the extension, except
 * the API key. A restore replaces the profile and settings and merges jobs and
 * the tracker, so restoring onto a browser that already has data loses nothing.
 */
import type { LastBuild, StoredJob } from "./jobs";
import { normalizeProfile, type JobProfile } from "./profile";
import type { StatusEntry } from "./tracker";

export const BACKUP_FORMAT = "job-newtab-backup";
export const BACKUP_VERSION = 1;

export interface BackupSettings {
  model?: string;
  autoRebuild?: boolean;
  rebuildIntervalHours?: number | null;
}

export interface BackupData {
  profile: JobProfile | null;
  settings: BackupSettings;
  jobs: Record<string, StoredJob>;
  statuses: Record<string, StatusEntry>;
  lastBuild: LastBuild | null;
  buildCount: number;
}

export interface BackupFile extends BackupData {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
}

export function makeBackup(data: BackupData, now: Date): BackupFile {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now.toISOString(), ...data };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Read a backup file, or throw a message the user can act on. */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file is not a job-newtab backup (it is not JSON).");
  }
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) throw new Error("This file is not a job-newtab backup.");
  if (typeof raw.version !== "number" || raw.version > BACKUP_VERSION) {
    throw new Error("This backup was made by a newer version of job-newtab. Update the extension and try again.");
  }
  const jobs = isRecord(raw.jobs) ? (raw.jobs as Record<string, StoredJob>) : {};
  const statuses = isRecord(raw.statuses) ? (raw.statuses as Record<string, StatusEntry>) : {};
  return {
    format: BACKUP_FORMAT,
    version: raw.version,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    profile: isRecord(raw.profile) ? normalizeProfile(raw.profile as Partial<JobProfile>) : null,
    settings: isRecord(raw.settings) ? (raw.settings as BackupSettings) : {},
    jobs: Object.fromEntries(Object.entries(jobs).filter(([, j]) => isRecord(j) && typeof j.title === "string")),
    statuses: Object.fromEntries(
      Object.entries(statuses).filter(([, s]) => isRecord(s) && typeof s.status === "string" && typeof s.updatedAt === "string"),
    ),
    lastBuild: isRecord(raw.lastBuild) ? (raw.lastBuild as unknown as LastBuild) : null,
    buildCount: typeof raw.buildCount === "number" ? raw.buildCount : 0,
  };
}

/** What restoring `incoming` onto `current` produces. */
export function mergeBackup(current: BackupData, incoming: BackupData): BackupData {
  const jobs = { ...current.jobs };
  for (const [id, job] of Object.entries(incoming.jobs)) {
    const mine = jobs[id];
    if (!mine || (job.lastSeen ?? "") > (mine.lastSeen ?? "")) jobs[id] = job;
  }
  const statuses = { ...current.statuses };
  for (const [id, entry] of Object.entries(incoming.statuses)) {
    const mine = statuses[id];
    if (!mine || entry.updatedAt > mine.updatedAt) statuses[id] = entry;
  }
  const newerBuild =
    !current.lastBuild || (incoming.lastBuild && incoming.lastBuild.timestamp > current.lastBuild.timestamp)
      ? incoming.lastBuild
      : current.lastBuild;
  return {
    profile: incoming.profile ?? current.profile,
    settings: { ...current.settings, ...incoming.settings },
    jobs,
    statuses,
    lastBuild: newerBuild,
    buildCount: Math.max(current.buildCount, incoming.buildCount),
  };
}
