import { PRESET_COMPANIES } from "./companies";

/**
 * What the job seeker tells us during onboarding. Everything downstream — search
 * URLs, ATS filtering, the agent's scoring — is derived from this one object.
 */

export type AtsKind = "greenhouse" | "lever" | "ashby";
export type JobBoard = "linkedin" | "indeed";
export type JobSource = AtsKind | JobBoard;

export type Seniority = "intern" | "entry" | "mid" | "senior" | "staff" | "manager";

export const SENIORITY_CHOICES: { id: Seniority; label: string }[] = [
  { id: "intern", label: "Internship" },
  { id: "entry", label: "Entry level / New grad" },
  { id: "mid", label: "Mid level" },
  { id: "senior", label: "Senior" },
  { id: "staff", label: "Staff / Principal" },
  { id: "manager", label: "Manager / Director" },
];

/** What the person needs from an employer to work in the US. */
export type WorkAuth = "none" | "opt" | "h1b-new" | "h1b-transfer" | "ead";

export const WORK_AUTH_CHOICES: { id: WorkAuth; label: string }[] = [
  { id: "none", label: "No sponsorship needed (US citizen or green card)" },
  { id: "opt", label: "F-1 OPT / STEM OPT: will need an H-1B" },
  { id: "h1b-new", label: "Need a new H-1B (no US work authorization yet)" },
  { id: "h1b-transfer", label: "On an H-1B now: need a transfer" },
  { id: "ead", label: "Have an EAD (H-4, L-2 …): need green card sponsorship" },
];

/** A company whose public job board we read through its ATS API. */
export interface CompanySource {
  ats: AtsKind;
  /** The board token in the ATS URL, e.g. `figma` in boards-api.greenhouse.io/v1/boards/figma. */
  slug: string;
  name: string;
  /** Website domain, for the logo. Known for presets; absent for companies added by link. */
  domain?: string;
}

export interface JobProfile {
  /** Job titles to search for, e.g. "Software Engineer", "Product Designer". */
  roles: string[];
  seniority: Seniority[];
  /** US metros, written "City, ST". */
  locations: string[];
  remoteOk: boolean;
  /** Accept any US location, not only the listed metros. */
  anywhereInUS: boolean;
  boards: Record<JobBoard, boolean>;
  companies: CompanySource[];
  /** Pasted resume text. Optional, but it is what makes the match scores meaningful. */
  resume: string;
  /** Visa status. Anything but "none" turns on the posting checks and the employer filing lookup. */
  workAuth: WorkAuth;
  /** Also wants green card (PERM) sponsorship. Implied by "ead". */
  wantsGreenCard: boolean;
  /** Free-text preferences: "no crypto", "prefer Series B+". */
  notes: string;
}

export const EMPTY_PROFILE: JobProfile = {
  roles: [],
  seniority: [],
  locations: [],
  remoteOk: true,
  anywhereInUS: false,
  boards: { linkedin: true, indeed: true },
  companies: [],
  resume: "",
  workAuth: "none",
  wantsGreenCard: false,
  notes: "",
};

/** The three things a build cannot run without: what, where, and from which sources. */
export function profileProblems(p: JobProfile): string[] {
  const problems: string[] = [];
  if (p.roles.length === 0) problems.push("Add at least one job title.");
  if (p.locations.length === 0 && !p.remoteOk && !p.anywhereInUS) {
    problems.push("Add a location, or allow remote / anywhere in the US.");
  }
  if (!p.boards.linkedin && !p.boards.indeed && p.companies.length === 0) {
    problems.push("Pick at least one job board or company.");
  }
  return problems;
}

/** Fill fields a stored profile from an older version may be missing. */
export function normalizeProfile(raw: Partial<JobProfile> | undefined): JobProfile {
  const companies = (raw?.companies ?? []).map((c) => ({
    ...c,
    domain: c.domain ?? PRESET_COMPANIES.find((p) => p.ats === c.ats && p.slug === c.slug)?.domain,
  }));
  return {
    ...EMPTY_PROFILE,
    ...raw,
    boards: { ...EMPTY_PROFILE.boards, ...raw?.boards },
    roles: raw?.roles ?? [],
    seniority: raw?.seniority ?? [],
    locations: raw?.locations ?? [],
    workAuth: WORK_AUTH_CHOICES.some((c) => c.id === raw?.workAuth) ? raw!.workAuth! : "none",
    wantsGreenCard: raw?.wantsGreenCard === true,
    companies,
  };
}
