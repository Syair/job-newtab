/**
 * Government actions that filing records cannot show yet: a PERM suspension
 * leaves an employer's history looking healthy for months. The list is kept by
 * hand in visa-overrides.json, ships with the extension, and is fetched from the
 * repository once a day so an update reaches people without a release.
 *
 * The fetch is a plain GET of a public file; nothing about the user is sent.
 */
import bundled from "./visa-overrides.json";
import type { Job } from "./jobs";
import type { KVStore } from "./types";

export interface VisaOverride {
  id: string;
  /** The program the action covers. */
  kind: "h1b" | "perm";
  status: "suspended" | "debarred";
  /** ISO date the action took effect. */
  since: string;
  /** ISO date it ends, when announced. */
  until: string | null;
  /** One or two sentences for the job's details. */
  summary: string;
  sources: { title: string; url: string }[];
  employers: { name: string; aliases: string[] }[];
}

export interface OverridesFile {
  version: 1;
  /** ISO date of the last edit; the newer of the bundled and fetched copies wins. */
  updated: string;
  overrides: VisaOverride[];
}

export const OVERRIDES_URL =
  "https://raw.githubusercontent.com/Syair/job-newtab/main/packages/agent-core/visa-overrides.json";
export const OVERRIDES_KEY = "visaOverrides";
/** Fetch at most this often. */
export const OVERRIDES_REFRESH_HOURS = 12;

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function httpsUrl(v: unknown): string | null {
  const s = str(v, 500);
  if (!s) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** The file as overrides, dropping any entry that is malformed. Null when the file itself is not one. */
export function parseOverridesFile(body: unknown): OverridesFile | null {
  const root = body as Partial<OverridesFile> | null;
  if (!root || root.version !== 1 || !isDate(root.updated) || !Array.isArray(root.overrides)) return null;
  const overrides: VisaOverride[] = [];
  for (const raw of root.overrides as unknown[]) {
    const o = raw as Record<string, unknown>;
    const id = str(o?.id, 100);
    const summary = str(o?.summary, 600);
    if (!id || !summary || (o.kind !== "h1b" && o.kind !== "perm")) continue;
    if (o.status !== "suspended" && o.status !== "debarred") continue;
    if (!isDate(o.since) || (o.until !== null && o.until !== undefined && !isDate(o.until))) continue;
    const employers = (Array.isArray(o.employers) ? o.employers : [])
      .map((e: { name?: unknown; aliases?: unknown }) => ({
        name: str(e?.name, 120) ?? "",
        aliases: (Array.isArray(e?.aliases) ? e.aliases : []).map((a: unknown) => str(a, 120)).filter((a): a is string => !!a),
      }))
      .filter((e) => e.name);
    if (employers.length === 0) continue;
    const sources = (Array.isArray(o.sources) ? o.sources : [])
      .map((s: { title?: unknown; url?: unknown }) => ({ title: str(s?.title, 200), url: httpsUrl(s?.url) }))
      .filter((s): s is { title: string; url: string } => !!s.title && !!s.url);
    overrides.push({
      id,
      kind: o.kind,
      status: o.status,
      since: o.since as string,
      until: (o.until as string | undefined) ?? null,
      summary,
      sources,
      employers,
    });
  }
  return { version: 1, updated: root.updated, overrides };
}

export const BUNDLED_OVERRIDES: OverridesFile = parseOverridesFile(bundled) ?? { version: 1, updated: "1970-01-01", overrides: [] };

/** The newer of the shipped list and the last fetched one. */
export function pickOverrides(fetched: OverridesFile | null | undefined): OverridesFile {
  return fetched && Date.parse(fetched.updated) >= Date.parse(BUNDLED_OVERRIDES.updated) ? fetched : BUNDLED_OVERRIDES;
}

/** Legal suffixes differ between a posting ("Adobe") and a filing ("Adobe Inc."). */
const SUFFIX = /\s+(?:inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|lp|llp|us|usa|america)$/;

export function employerKey(name: string): string {
  let key = name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  for (let prev = ""; prev !== key; ) {
    prev = key;
    key = key.replace(SUFFIX, "").trim();
  }
  return key;
}

/**
 * The overrides in effect today for a job's employer, matched by the name the
 * posting printed and the name PERM Tracker matched it to. Names must match
 * whole: a subsidiary that files under its own name is not covered.
 */
export function activeOverrides(
  job: Pick<Job, "company" | "sponsor">,
  file: OverridesFile,
  now: Date,
): VisaOverride[] {
  const keys = new Set(
    [job.company, job.sponsor?.match === "exact" ? job.sponsor.employer : null]
      .filter((n): n is string => !!n)
      .map(employerKey)
      .filter(Boolean),
  );
  if (keys.size === 0) return [];
  const t = now.getTime();
  return file.overrides.filter(
    (o) =>
      Date.parse(o.since) <= t &&
      (!o.until || Date.parse(o.until) > t) &&
      o.employers.some((e) => [e.name, ...e.aliases].some((n) => keys.has(employerKey(n)))),
  );
}

interface StoredOverrides {
  /** When to fetch again: OVERRIDES_REFRESH_HOURS after a success, an hour after a failure. */
  nextCheck: string;
  file: OverridesFile | null;
}

/** The list to use: the stored copy when it is newer than the one shipped. */
export async function loadOverrides(store: KVStore): Promise<OverridesFile> {
  const stored = await store.get<StoredOverrides>(OVERRIDES_KEY);
  return pickOverrides(stored?.file ? parseOverridesFile(stored.file) : null);
}

/**
 * Fetch the list when it is due. Never throws; a failed fetch keeps what is
 * stored and tries again in an hour.
 */
export async function refreshOverrides(opts: {
  fetchImpl: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  store: KVStore;
  now?: Date;
  log?: (line: string) => void;
}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const stored = await opts.store.get<StoredOverrides>(OVERRIDES_KEY);
  if (stored && now.getTime() < Date.parse(stored.nextCheck)) return false;
  const later = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  try {
    const res = await opts.fetchImpl(OVERRIDES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = parseOverridesFile(await res.json());
    if (!file) throw new Error("not an overrides file");
    await opts.store.set(OVERRIDES_KEY, { nextCheck: later(OVERRIDES_REFRESH_HOURS), file } satisfies StoredOverrides);
    return true;
  } catch (err) {
    opts.log?.(`visa overrides fetch failed: ${String(err)}`);
    await opts.store.set(OVERRIDES_KEY, { nextCheck: later(1), file: stored?.file ?? null } satisfies StoredOverrides);
    return false;
  }
}
