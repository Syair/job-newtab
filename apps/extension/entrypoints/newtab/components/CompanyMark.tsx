import { useState } from "react";
import { knownCompanyDomain } from "@job-newtab/agent-core";

/** Muted inks that sit on newsprint in both themes. */
const MONOGRAM_COLORS = ["#8a5a44", "#5b6f52", "#4f6274", "#7a5c7a", "#8a7440", "#56707a", "#7d4f4f", "#5f5b8a"];

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function initials(company: string): string {
  const words = company.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

/**
 * The company's logo, looked up by website domain through Google's favicon
 * service (only the domain is sent). Falls back to a monogram when the domain is
 * unknown or the service has no real icon for it.
 */
export function CompanyMark({ company, domain, size = 28 }: { company: string; domain?: string | null; size?: number }) {
  const resolved = domain ?? knownCompanyDomain(company);
  const [failed, setFailed] = useState(false);

  if (resolved && !failed) {
    return (
      <img
        className="mark-logo"
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(resolved)}&sz=64`}
        width={size}
        height={size}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        // Unknown domains come back as a 16px placeholder globe rather than an error.
        onLoad={(e) => e.currentTarget.naturalWidth < 32 && setFailed(true)}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="mark-mono"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.4, background: MONOGRAM_COLORS[hash(company) % MONOGRAM_COLORS.length] }}
    >
      {initials(company)}
    </span>
  );
}
