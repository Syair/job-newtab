import type { JobSource } from "@job-newtab/agent-core";

export const SOURCE_LABEL: Record<JobSource, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  linkedin: "LinkedIn",
  indeed: "Indeed",
};

const DAY = 86_400_000;

export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
}

/** "today", "yesterday", "4d", "2mo". */
export function shortAge(iso: string | null | undefined): string | null {
  const days = daysSince(iso);
  if (days === null) return null;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function longDate(date = new Date()): string {
  return date.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** "9:02 AM" for today, otherwise "yesterday" / "3d ago". */
export function updatedLabel(iso: string): string {
  if (daysSince(iso) === 0) return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return shortAge(iso) ?? "";
}
