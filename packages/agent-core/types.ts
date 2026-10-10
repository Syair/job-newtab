/**
 * Contracts shared by every host that can drive the job-scout agent.
 *
 * The orchestrator is deliberately ignorant of *where* it runs. The extension
 * supplies a bridge backed by `chrome.tabs`; the Node harness supplies one backed
 * by plain `fetch`. Nothing in this package may import `chrome`, `browser`, or
 * `node:*`.
 */
import type { CompanyStat, FetchLike } from "./ats";
import type { JobsFile } from "./jobs";
import type { SearchTarget } from "./search-urls";

/** A file that now lives in the session sandbox rather than in context. */
export interface MountedFile {
  /**
   * The path the sandbox actually resolved, read back off the `resources.add()`
   * response. Never the path we asked for — the API re-roots every file resource
   * under `/mnt/session/uploads/`.
   */
  mountPath: string;
  /** Lets the model choose grep-first over read-whole. */
  bytes: number;
}

export interface BoardPageRef extends MountedFile {
  board: SearchTarget["board"];
  role: string;
  where: string;
  url: string;
  title: string;
}

export interface GetJobSourcesResult {
  candidates: (MountedFile & { count: number }) | null;
  companies: CompanyStat[];
  boardPages: BoardPageRef[];
  /** Descriptions from LinkedIn / Indeed job pages, keyed by job id. */
  boardDetails: (MountedFile & { count: number }) | null;
  /** Surfaced, never swallowed: partial failure is information the model needs. */
  failed: Array<{ url: string; reason: string }>;
  /** How many already-shown jobs were skipped, so the model knows the list is the new ones only. */
  skippedAlreadySeen: number;
}

export interface ScrapedPage {
  url: string;
  title: string;
  html: string;
}

/** The one capability only a real browser has: loading pages with the user's sign-ins. */
export interface BrowserBridge {
  getPageHtml(args: {
    urls: string[];
    loadDelayMs?: number;
  }): Promise<{ pages: ScrapedPage[]; failed: Array<{ url: string; reason: string }> }>;

  /** `fetch` for the public ATS APIs. Defaults to the global one. */
  fetch?: FetchLike;

  /**
   * Fetch a public page as text *without* the user's cookies. Used for LinkedIn
   * job postings: the signed-out posting has the description in its HTML, while
   * the signed-in page only renders it in a visible tab. Defaults to the global
   * `fetch` with `credentials: "omit"`.
   */
  fetchPublicText?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/** Minimal persistence. `chrome.storage.local` in the extension, a JSON file in Node. */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export type RunPhase =
  | "setup"
  | "session-create"
  | "thinking"
  | "collecting"
  | "scraping"
  | "analyzing"
  | "writing"
  | "cleanup"
  | "done"
  | "error";

export interface RunCallbacks {
  onPhase?(phase: RunPhase, detail?: string): void;
  /** Streamed assistant prose, for a progress panel. */
  onText?(text: string): void;
  onLog?(line: string): void;
}

export interface JobScoutResult {
  jobs: JobsFile;
  /** Entries in jobs.json that failed validation. */
  dropped: string[];
  sessionId: string;
  /** Where the file came from: a session output, or a fenced block in the final message. */
  source: "session-output" | "message-fence";
}
