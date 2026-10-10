import type { AtsKind, CompanySource } from "./profile";

/**
 * Companies whose public job boards answered on their ATS API (checked 2026-10-09),
 * with the website domain their logo is looked up by.
 * Offered as one-click picks during onboarding; users can add any other board
 * by its slug.
 */
export const PRESET_COMPANIES: CompanySource[] = [
  ...greenhouse({
    affirm: ["Affirm", "affirm.com"],
    airbnb: ["Airbnb", "airbnb.com"],
    anthropic: ["Anthropic", "anthropic.com"],
    asana: ["Asana", "asana.com"],
    brex: ["Brex", "brex.com"],
    chime: ["Chime", "chime.com"],
    cloudflare: ["Cloudflare", "cloudflare.com"],
    coinbase: ["Coinbase", "coinbase.com"],
    databricks: ["Databricks", "databricks.com"],
    datadog: ["Datadog", "datadoghq.com"],
    discord: ["Discord", "discord.com"],
    doordashusa: ["DoorDash", "doordash.com"],
    dropbox: ["Dropbox", "dropbox.com"],
    duolingo: ["Duolingo", "duolingo.com"],
    elastic: ["Elastic", "elastic.co"],
    figma: ["Figma", "figma.com"],
    flexport: ["Flexport", "flexport.com"],
    gitlab: ["GitLab", "gitlab.com"],
    gusto: ["Gusto", "gusto.com"],
    instacart: ["Instacart", "instacart.com"],
    lyft: ["Lyft", "lyft.com"],
    mongodb: ["MongoDB", "mongodb.com"],
    nuro: ["Nuro", "nuro.ai"],
    okta: ["Okta", "okta.com"],
    pinterest: ["Pinterest", "pinterest.com"],
    reddit: ["Reddit", "reddit.com"],
    robinhood: ["Robinhood", "robinhood.com"],
    roblox: ["Roblox", "roblox.com"],
    samsara: ["Samsara", "samsara.com"],
    scaleai: ["Scale AI", "scale.com"],
    spacex: ["SpaceX", "spacex.com"],
    stripe: ["Stripe", "stripe.com"],
    twilio: ["Twilio", "twilio.com"],
    waymo: ["Waymo", "waymo.com"],
  }),
  ...lever({
    palantir: ["Palantir", "palantir.com"],
    shieldai: ["Shield AI", "shield.ai"],
    spotify: ["Spotify", "spotify.com"],
  }),
  ...ashby({
    benchling: ["Benchling", "benchling.com"],
    cursor: ["Cursor", "cursor.com"],
    linear: ["Linear", "linear.app"],
    notion: ["Notion", "notion.com"],
    openai: ["OpenAI", "openai.com"],
    perplexity: ["Perplexity", "perplexity.ai"],
    plaid: ["Plaid", "plaid.com"],
    ramp: ["Ramp", "ramp.com"],
    supabase: ["Supabase", "supabase.com"],
  }),
].sort((a, b) => a.name.localeCompare(b.name));

type Preset = Record<string, [name: string, domain: string]>;

function greenhouse(map: Preset) {
  return entries("greenhouse", map);
}
function lever(map: Preset) {
  return entries("lever", map);
}
function ashby(map: Preset) {
  return entries("ashby", map);
}
function entries(ats: AtsKind, map: Preset): CompanySource[] {
  return Object.entries(map).map(([slug, [name, domain]]) => ({ ats, slug, name, domain }));
}

/** Website domain for a company name we know, for logos on jobs found on LinkedIn / Indeed. */
export function knownCompanyDomain(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  return PRESET_COMPANIES.find((c) => c.name.toLowerCase() === key)?.domain;
}

export function companyKey(c: Pick<CompanySource, "ats" | "slug">): string {
  return `${c.ats}:${c.slug.toLowerCase()}`;
}

/**
 * Accept a pasted careers URL or `ats:slug`, so users can add any company:
 *   https://boards.greenhouse.io/figma, https://job-boards.greenhouse.io/figma
 *   https://jobs.lever.co/palantir, https://jobs.ashbyhq.com/openai
 *   greenhouse:figma
 */
export function parseCompanyInput(input: string): Pick<CompanySource, "ats" | "slug"> | null {
  const text = input.trim();
  const prefixed = text.match(/^(greenhouse|lever|ashby)\s*:\s*([\w.-]+)$/i);
  if (prefixed) return { ats: prefixed[1].toLowerCase() as AtsKind, slug: prefixed[2].toLowerCase() };

  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }
  const slug = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!slug) return null;
  if (/(^|\.)greenhouse\.io$/.test(url.hostname)) return { ats: "greenhouse", slug };
  if (url.hostname === "jobs.lever.co") return { ats: "lever", slug };
  if (url.hostname === "jobs.ashbyhq.com") return { ats: "ashby", slug };
  return null;
}
