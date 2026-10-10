/**
 * Cheap, deterministic pre-filtering for ATS listings. A big company exposes
 * hundreds of openings; only the few that plausibly fit the profile go to the
 * agent, so the model spends tokens scoring candidates, not discarding noise.
 *
 * Errs on the side of keeping: anything ambiguous passes and the agent decides.
 */
import type { JobProfile } from "./profile";

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** Big US job markets that listings often name without a state. */
const US_CITIES = [
  "San Francisco", "New York", "Seattle", "Austin", "Boston", "Chicago", "Los Angeles",
  "Denver", "Atlanta", "Washington", "San Jose", "Palo Alto", "Mountain View",
  "Sunnyvale", "Menlo Park", "Redwood City", "San Mateo", "Oakland", "San Diego",
  "Portland", "Miami", "Dallas", "Houston", "Phoenix", "Philadelphia", "Pittsburgh",
  "Salt Lake City", "Minneapolis", "Detroit", "Raleigh", "Nashville", "Bellevue",
  "Kirkland", "Cambridge", "Brooklyn", "Hawthorne", "Irvine", "Boulder",
];

/** Abbreviations listings use for metros, keyed by the canonical city name. */
const CITY_ALIASES: Record<string, string[]> = {
  "san francisco": ["SF", "Bay Area", "SF Bay Area", "SFO"],
  "new york": ["NYC", "New York City", "Manhattan", "Brooklyn"],
  seattle: ["SEA", "Bellevue", "Kirkland"],
  chicago: ["CHI"],
  "los angeles": ["LA", "L.A."],
  "washington": ["DC", "D.C."],
  boston: ["BOS", "Cambridge"],
};

const NON_US_COUNTRY_HINTS =
  /\b(canada|toronto|vancouver|montreal|uk|united kingdom|london|dublin|ireland|germany|berlin|munich|france|paris|india|bangalore|bengaluru|singapore|japan|tokyo|australia|sydney|netherlands|amsterdam|spain|madrid|mexico|brazil|poland|warsaw|israel|tel aviv|emea|apac|latam|europe)\b/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWord(haystack: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle.toLowerCase())}($|[^a-z0-9])`, "i").test(
    haystack.toLowerCase(),
  );
}

export function isUsLocation(location: string, country?: string): boolean {
  if (country) return normalizeCountry(country) === "US";
  const text = location.trim();
  if (!text) return false;
  if (/\b(united states|usa|u\.s\.a?\.?)\b/i.test(text) || /(^|[^a-z])US($|[^a-z])/.test(text)) {
    return true;
  }
  if (/,\s*([A-Z]{2})\b/.test(text)) {
    const abbrs = [...text.matchAll(/,\s*([A-Z]{2})\b/g)].map((m) => m[1]);
    if (abbrs.some((a) => a in US_STATES)) return true;
  }
  if (Object.values(US_STATES).some((state) => containsWord(text, state))) return true;
  return US_CITIES.some((city) => containsWord(text, city));
}

export function normalizeCountry(country: string): string {
  const c = country.trim();
  if (/^(us|usa|united states( of america)?)$/i.test(c)) return "US";
  return c.toUpperCase();
}

export function isRemoteText(text: string): boolean {
  return /\bremote\b/i.test(text);
}

export interface LocatedJob {
  location: string;
  remote: boolean;
  country?: string;
}

export function matchesLocation(job: LocatedJob, profile: JobProfile): boolean {
  const us = isUsLocation(job.location, job.country);

  if (profile.anywhereInUS && us) return true;

  if (profile.remoteOk && job.remote) {
    // "Remote" with no country is common on US-first boards; keep it unless the
    // text names somewhere else.
    if (us) return true;
    if (!job.country && !NON_US_COUNTRY_HINTS.test(job.location)) return true;
  }

  return profile.locations.some((wanted) => {
    const city = wanted.split(",")[0].trim();
    if (!city) return false;
    if (containsWord(job.location, city)) return true;
    return (CITY_ALIASES[city.toLowerCase()] ?? []).some((alias) => containsWord(job.location, alias));
  });
}

/** Spelling variants collapsed before title matching, applied to both sides. */
const TITLE_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/\bfront[\s-]+end\b/g, "frontend"],
  [/\bback[\s-]+end\b/g, "backend"],
  [/\bfull[\s-]+stack\b/g, "fullstack"],
  [/\bmachine learning\b/g, "ml"],
  [/\bartificial intelligence\b/g, "ai"],
  [/\bswe\b/g, "software engineer"],
  [/\bsde\b/g, "software engineer"],
  [/\bsoftware development engineer\b/g, "software engineer"],
  [/\bdeveloper\b/g, "engineer"],
  [/\bpm\b/g, "product manager"],
  [/\bux\b/g, "user experience"],
  [/\bsr\.?\b/g, "senior"],
];

const STOP_WORDS = new Set(["and", "or", "of", "the", "a", "an", "for", "in", "at", "to", "&", "-", "/", ","]);

function normalizeTitle(title: string): string {
  let t = ` ${title.toLowerCase()} `;
  for (const [pattern, replacement] of TITLE_NORMALIZATIONS) t = t.replace(pattern, replacement);
  return t.replace(/[^a-z0-9+#]+/g, " ").trim();
}

function words(text: string): string[] {
  return normalizeTitle(text)
    .split(" ")
    .filter((w) => w && !STOP_WORDS.has(w));
}

/**
 * A title matches a role when every significant word of the role appears in the
 * title as a word prefix: "Software Engineer" matches "Senior Software
 * Engineering Manager, Payments" but not "Software Sales".
 */
export function matchesRole(title: string, roles: string[]): boolean {
  const titleWords = words(title);
  return roles.some((role) => {
    const roleWords = words(role);
    return roleWords.length > 0 && roleWords.every((rw) => titleWords.some((tw) => tw.startsWith(rw)));
  });
}

const INTERN_TITLE = /\b(intern|internship|co-?op)\b/i;

/** Only the hard seniority split is enforced here; finer levels are the agent's call. */
export function matchesSeniority(title: string, seniority: JobProfile["seniority"]): boolean {
  if (seniority.length === 0) return true;
  const isIntern = INTERN_TITLE.test(title);
  if (isIntern) return seniority.includes("intern");
  return seniority.some((s) => s !== "intern");
}
