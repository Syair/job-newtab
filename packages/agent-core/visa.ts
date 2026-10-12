/**
 * What a posting says about visas, read with fixed patterns. A line like "we do
 * not sponsor" decides the job for someone who needs sponsorship, so it counts
 * the same way every time instead of depending on how the model reads it.
 *
 * Patterns run on the full description, before it is cut to an excerpt: the
 * sponsorship line is usually in the boilerplate at the end.
 */
import { DEALBREAKER_CAP, totalScore, type Job } from "./jobs";
import type { JobProfile, WorkAuth } from "./profile";

export type VisaSignal =
  /** "We are unable to sponsor", "authorized to work without sponsorship". */
  | "no-sponsorship"
  /** "Must be a U.S. citizen". */
  | "citizens-only"
  /** "Must be a U.S. citizen or permanent resident", ITAR / export-control rules. */
  | "us-persons-only"
  /** An active or obtainable security clearance is required. */
  | "clearance"
  /** "Visa sponsorship is available". */
  | "sponsors";

export const VISA_SIGNAL_LABEL: Record<VisaSignal, string> = {
  "no-sponsorship": "Says it does not sponsor visas",
  "citizens-only": "U.S. citizens only",
  "us-persons-only": "U.S. citizens and green card holders only",
  clearance: "Needs a security clearance",
  sponsors: "Says it sponsors visas",
};

/** Whether the profile needs anything from an employer for work authorization. */
export function needsSponsorship(profile: Pick<JobProfile, "workAuth">): boolean {
  return profile.workAuth !== "none";
}

/** Statuses that need an H-1B petition from the employer. */
export function needsH1b(workAuth: WorkAuth): boolean {
  return workAuth === "opt" || workAuth === "h1b-new" || workAuth === "h1b-transfer";
}

export function wantsGreenCard(profile: Pick<JobProfile, "workAuth" | "wantsGreenCard">): boolean {
  return profile.workAuth === "ead" || (profile.workAuth !== "none" && profile.wantsGreenCard);
}

// ---------------------------------------------------------------------------
// reading the posting
// ---------------------------------------------------------------------------

const US = String.raw`(?:u\.?\s?s\.?|united states)`;
/** Words that turn a requirement into a preference or its opposite, in the match or the rest of its clause. */
const SOFTENERS = /\b(?:not|preferred|a plus|bonus|nice to have|desired|helpful|advantage|beneficial)\b/i;

const CITIZENS_ONLY = [
  new RegExp(String.raw`\bmust\s+(?:be|hold)\s+(?:an?\s+)?${US}\s+citizen`, "gi"),
  new RegExp(String.raw`\brequires?\s+${US}\s+citizenship`, "gi"),
  new RegExp(String.raw`\b${US}\s+citizenship\b[^.\n]{0,30}\b(?:required|mandatory|a requirement)`, "gi"),
  new RegExp(String.raw`\b(?:only|exclusively)\s+(?:open\s+to\s+)?${US}\s+citizens`, "gi"),
];

const US_PERSONS_ONLY = [
  new RegExp(String.raw`\bmust\s+be\s+an?\s+${US}\s+person`, "gi"),
  new RegExp(String.raw`\b${US}\s+persons?\b[^.\n]{0,40}\b(?:required|only|as defined)`, "gi"),
  /\bitar\b[^.\n]{0,80}\b(?:required|requires|must|restrict)/gi,
  /\bexport\s+(?:control\s+)?(?:laws|regulations)\b[^.\n]{0,80}\bmust\s+be\b/gi,
];

const CLEARANCE = [
  /\b(?:active|current|existing|obtain|maintain|must have|must hold|must possess|eligib\w+ for)\b[^.\n]{0,40}\b(?:secret|top secret|ts\/sci|security|dod|government)\s+clearance/gi,
  /\bclearance\s+(?:is\s+)?required\b/gi,
  /\bts\/sci\b/gi,
];

/** A citizenship rule that also names green card holders is a U.S.-person rule. */
const ALSO_RESIDENTS = /permanent resident|green card|lawful/i;

// Sponsorship is read a sentence at a time: the refusal can be far from the
// word "sponsor" ("may not be able to … support future H-1B sponsorship").
const SENTENCE = /[^.!?\n]+[.!?]?/g;
const SPONSOR_WORD = /\bsponsor(?:ship|s|ing)?\b/i;
const NEGATION = /\b(?:not|no longer|unable|cannot|can't|won't|don't|doesn't|never|ineligible)\b/i;
const VISA_WORD = /\b(?:visas?|h-?1b|immigration|work permits?)\b/i;
/** A refusal next to the word, or anywhere in a sentence about visas. */
const REFUSALS = [
  /\b(?:not|unable|cannot|can't|won't|don't|doesn't|never|no longer|ineligible)\b(?:\W+[\w-]+){0,6}?\W+sponsor(?:ship)?\b/i,
  /\bsponsor(?:ship)?\b(?:\W+[\w-]+){0,5}?\W+(?:is|are|will|would|can|be|was)\s+(?:not|unavailable)\b/i,
  /\bsponsorship\s+(?:is\s+)?(?:unavailable|not available)\b/i,
  /\bwithout\b(?:\W+[\w-]+){0,8}?\W+sponsorship\b/i,
  /\bno\s+(?:visa\s+|h-?1b\s+|immigration\s+|employment\s+)?sponsorship\b/i,
];
/** "Not … for every role" is a caveat, not a refusal. */
const PARTIAL = /\bevery\b|\ball (?:roles|positions|candidates)\b/i;
/** Sponsorship of something other than a visa. */
const OTHER_SPONSORSHIP = /export licen|clearance|corporate sponsor/i;
/** An offer, phrased as one: not a duty in an immigration team's job description. */
const OFFERS = [
  /\b(?:visa|h-?1b|immigration)\s+sponsorship\s+(?:is\s+|will\s+be\s+)?(?:available|offered|provided|possible|supported)\b/i,
  /\bwe\s+(?:[\w-]+\s+){0,4}?(?:sponsor|offer|provide|support)\s+(?:[\w-]+\s+){0,2}?(?:visas?|h-?1b|immigration)\b/i,
  /\b(?:this|the)\s+(?:role|position)\s+(?:[\w-]+\s+){0,3}?(?:offers?|provides?|supports?|is eligible for)\s+(?:[\w-]+\s+){0,2}?(?:visa|h-?1b|immigration)\s+sponsorship\b/i,
];

export interface VisaEvidence {
  signal: VisaSignal;
  /** The words that triggered it. */
  quote: string;
}

function hardHits(text: string, patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const end = m.index + m[0].length;
      const rest = text.slice(end, end + 100);
      const stop = rest.search(/[.;\n]/);
      const clause = stop >= 0 ? rest.slice(0, stop) : rest;
      if (!SOFTENERS.test(m[0] + clause)) out.push(text.slice(m.index, end + Math.min(clause.length, 80)).trim());
    }
  }
  return out;
}

/** Every visa rule a posting states, with the words behind it. */
export function visaEvidence(raw: string): VisaEvidence[] {
  if (!raw) return [];
  // "U.S." would end every sentence early.
  const text = raw.replace(/\bU\.\s?S\.(?:\s?A\.)?/gi, "US");
  const out: VisaEvidence[] = [];

  for (const quote of hardHits(text, CITIZENS_ONLY)) {
    out.push({ signal: ALSO_RESIDENTS.test(quote) ? "us-persons-only" : "citizens-only", quote });
  }
  for (const quote of hardHits(text, US_PERSONS_ONLY)) out.push({ signal: "us-persons-only", quote });
  for (const quote of hardHits(text, CLEARANCE)) out.push({ signal: "clearance", quote });

  for (const [sentence] of text.matchAll(SENTENCE)) {
    if (!SPONSOR_WORD.test(sentence) || OTHER_SPONSORSHIP.test(sentence)) continue;
    const plain = sentence.replace(/\bnot limited to\b/gi, "");
    const quote = sentence.trim().slice(0, 240);
    const refused = REFUSALS.some((re) => re.test(plain)) || (NEGATION.test(plain) && VISA_WORD.test(plain));
    if (refused) {
      if (!PARTIAL.test(plain)) out.push({ signal: "no-sponsorship", quote });
    } else if (OFFERS.some((re) => re.test(plain))) {
      out.push({ signal: "sponsors", quote });
    }
  }
  return out;
}

/** The visa rules a posting states. Empty when it says nothing about them. */
export function visaSignals(text: string): VisaSignal[] {
  const found = new Set(visaEvidence(text).map((e) => e.signal));
  if (found.has("us-persons-only")) found.delete("citizens-only");
  // A refusal anywhere outweighs a general "we sponsor".
  if (found.has("no-sponsorship")) found.delete("sponsors");
  return [...found];
}

// ---------------------------------------------------------------------------
// applying it to a scored job
// ---------------------------------------------------------------------------

const BLOCKING: VisaSignal[] = ["citizens-only", "us-persons-only", "clearance", "no-sponsorship"];

/**
 * The rule a job breaks for this person, from what the posting says. Someone on
 * an EAD can start without sponsorship, so "we don't sponsor" is only a concern
 * for them, not a dealbreaker.
 */
export function visaDealbreaker(signals: VisaSignal[], profile: Pick<JobProfile, "workAuth">): string | null {
  const hit = blockingSignal(signals, profile);
  return hit ? VISA_SIGNAL_LABEL[hit] : null;
}

/** The first signal that rules this person out, if any. */
export function blockingSignal(signals: VisaSignal[], profile: Pick<JobProfile, "workAuth">): VisaSignal | null {
  if (!needsSponsorship(profile)) return null;
  return BLOCKING.find((s) => signals.includes(s) && !(s === "no-sponsorship" && profile.workAuth === "ead")) ?? null;
}

const VISA_WORDS = /sponsor|visa|h-?1b|citizen|clearance|green card|itar|u\.?s\.? person/i;

/**
 * The job with its posting's visa signals attached and, when one of them breaks
 * the profile, capped like any other dealbreaker. The agent may have already
 * named the same rule; then its wording stays.
 */
export function applyVisaSignals(job: Job, signals: VisaSignal[], profile: JobProfile): Job {
  if (!needsSponsorship(profile)) return job;
  const next: Job = { ...job, visa: signals };
  const rule = visaDealbreaker(signals, profile);
  const soft =
    profile.workAuth === "ead" && signals.includes("no-sponsorship")
      ? "Says it does not sponsor; ask about green card support"
      : null;
  const note = rule ?? soft;
  if (note && !job.concerns.some((c) => VISA_WORDS.test(c))) {
    next.concerns = [note, ...job.concerns].slice(0, 3);
  }
  if (!rule) return next;

  const b = job.scoreBreakdown;
  if (b && !b.dealbreaker) {
    next.scoreBreakdown = { ...b, dealbreaker: rule };
    next.matchScore = totalScore(next.scoreBreakdown);
  } else if (!b) {
    next.matchScore = Math.min(job.matchScore, DEALBREAKER_CAP);
  }
  return next;
}
