/**
 * LinkedIn and Indeed search pages only show cards: title, company, place, age.
 * To score skills, the agent needs the description, which lives on each job's
 * own page. This module picks which job pages to open and cuts the description
 * out of them.
 *
 * As with the search URLs, everything here is decided in code: the job ids come
 * from links on pages we opened, and the detail URLs are rebuilt from those ids,
 * so a scraped page cannot send the browser anywhere else.
 */
import { matchesRole } from "./filter";
import type { JobBoard } from "./profile";
import { decodeEntities, htmlToText, truncate } from "./text";
import { visaSignals, type VisaSignal } from "./visa";

export const DETAIL_DEFAULTS = {
  /** Job pages read per search, across both boards. LinkedIn ones take about a second each. */
  max: 20,
  /** The content script also waits for the text to settle, so a short fixed delay is enough. */
  loadDelayMs: 2000,
  /** Pause between public LinkedIn posting fetches, to stay well under rate limits. */
  publicFetchGapMs: 1000,
  /** Wait before the one retry after a 429. */
  rateLimitBackoffMs: 5000,
  descriptionChars: 3500,
};

export interface BoardCard {
  /** jobKey form: `linkedin:4012345678`, `indeed:abc123`. */
  id: string;
  board: JobBoard;
  /** The link text, usually the job title. Empty when the card had none. */
  title: string;
}

export interface BoardDetail {
  id: string;
  board: JobBoard;
  url: string;
  /** The text above the description: title, company, place, pay, age. */
  header: string;
  description: string;
  /** Visa rules the full description states, when it states any. */
  visa?: VisaSignal[];
}

function withVisa(detail: BoardDetail, full: string): BoardDetail {
  const visa = visaSignals(full);
  return visa.length ? { ...detail, visa } : detail;
}

const LINK = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

/** The board's own id for a job link, or null for any other link. */
export function boardJobId(board: JobBoard, href: string): string | null {
  const url = decodeEntities(href);
  if (board === "linkedin") {
    const m = url.match(/\/jobs\/view\/(?:[^/?#"]*?-)?(\d{6,})(?:[/?#]|$)/) ?? url.match(/[?&]currentJobId=(\d{6,})/);
    return m ? `linkedin:${m[1]}` : null;
  }
  const m = url.match(/[?&](?:jk|vjk)=([0-9a-f]{8,})/i);
  return m ? `indeed:${m[1].toLowerCase()}` : null;
}

/** The job cards on a search page, in page order, one per job. */
export function extractBoardCards(board: JobBoard, html: string): BoardCard[] {
  const byId = new Map<string, BoardCard>();
  for (const [, , href, inner] of html.matchAll(LINK)) {
    const id = boardJobId(board, href);
    if (!id) continue;
    const title = htmlToText(inner).replace(/\s+/g, " ").slice(0, 200);
    const known = byId.get(id);
    if (!known) byId.set(id, { id, board, title });
    else if (title.length > known.title.length) known.title = title;
  }
  return [...byId.values()];
}

/** The page to open for a card. Rebuilt from the id, never taken from the page. */
export function detailUrl(card: Pick<BoardCard, "id" | "board">): string {
  const raw = card.id.slice(card.id.indexOf(":") + 1);
  return card.board === "linkedin"
    ? `https://www.linkedin.com/jobs/view/${raw}/`
    : `https://www.indeed.com/viewjob?jk=${encodeURIComponent(raw)}`;
}

/**
 * Where the code reads a LinkedIn posting from: LinkedIn's public posting
 * endpoint, fetched without cookies. Null for Indeed, which is read in a tab.
 */
export function publicPostingUrl(card: Pick<BoardCard, "id" | "board">): string | null {
  if (card.board !== "linkedin") return null;
  return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${card.id.slice("linkedin:".length)}`;
}

/**
 * Which job pages to open: cards whose title matches a target role (or has no
 * readable title), not already known, taken in turn from each search page so
 * one busy search doesn't use the whole budget.
 */
export function pickDetailCards(
  pages: BoardCard[][],
  opts: { roles: string[]; seenIds?: Iterable<string>; max?: number },
): BoardCard[] {
  const max = opts.max ?? DETAIL_DEFAULTS.max;
  const taken = new Set(opts.seenIds ?? []);
  const queues = pages.map((cards) => cards.filter((c) => !c.title || matchesRole(c.title, opts.roles)));
  const picked: BoardCard[] = [];
  for (let round = 0; picked.length < max && queues.some((q) => q.length > round); round++) {
    for (const queue of queues) {
      const card = queue[round];
      if (!card || taken.has(card.id)) continue;
      taken.add(card.id);
      picked.push(card);
      if (picked.length >= max) break;
    }
  }
  return picked;
}

/** Headings that open the description, by board layout. */
const START_MARKERS = ["About the job", "Full job description", "Job description", "Job details"];
/** Text that follows the description on LinkedIn (signed in or not) and Indeed. */
const END_MARKERS = [
  "… more",
  "…more",
  "Show more",
  "Show less",
  "See more",
  "See less",
  "Seniority level",
  "Set alert for similar jobs",
  "About the company",
  "Hiring trends",
  "People also viewed",
  "Similar jobs",
  "Report job",
];

/**
 * A LinkedIn posting from the public endpoint. Its page text follows the
 * browser's language, so this reads the markup LinkedIn wraps the description
 * in (the same in every language) and falls back to the text markers.
 */
export function extractPublicPosting(
  card: Pick<BoardCard, "id" | "board">,
  html: string,
  maxChars = DETAIL_DEFAULTS.descriptionChars,
): BoardDetail | null {
  const open = html.match(/<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>/);
  if (!open || open.index === undefined) return extractDetail(card, html, maxChars);
  const start = open.index + open[0].length;
  const button = html.indexOf("show-more-less-html__button", start);
  const stop = html.lastIndexOf("</div>", button >= 0 ? button : html.length);
  const full = htmlToText(html.slice(start, stop > start ? stop : undefined));
  const description = truncate(full, maxChars);
  if (description.length < 200) return null;
  const pieces = [
    html.match(/<h[12][^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h[12]>/)?.[1],
    html.match(/<a[^>]*topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/)?.[1],
    html.match(/<span[^>]*topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/)?.[1],
  ];
  const header = pieces
    .map((p) => (p ? htmlToText(p) : ""))
    .filter(Boolean)
    .join(" · ");
  return withVisa({ id: card.id, board: card.board, url: detailUrl(card), header, description }, full);
}

/** Lines that end the page furniture above a description that has no heading. */
const LEAD_IN_MARKERS = ["Report this job", "Cookie Policy"];

/**
 * The description from a job page's sanitized HTML. Null when the page has no
 * recognizable description (a sign-in wall, a captcha, a removed posting).
 */
export function extractDetail(
  card: Pick<BoardCard, "id" | "board">,
  html: string,
  maxChars = DETAIL_DEFAULTS.descriptionChars,
): BoardDetail | null {
  const text = htmlToText(html);
  const startHit = START_MARKERS.map((m) => ({ m, at: text.indexOf(m) }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  const from = startHit ? startHit.at + startHit.m.length : 0;
  const endAt = END_MARKERS.map((m) => text.indexOf(m, from)).filter((i) => i >= 0);
  const to = endAt.length ? Math.min(...endAt) : -1;

  let body: string;
  let header: string;
  if (startHit) {
    body = text.slice(from, to >= 0 ? to : undefined);
    header = text.slice(Math.max(0, startHit.at - 400), startHit.at);
  } else if (to >= 0) {
    // No heading (LinkedIn's signed-out page): the description sits just above
    // the "Show more" control, after the last bit of page furniture before it
    // (the "Report this job" link or a sign-in prompt).
    const lead = Math.max(...LEAD_IN_MARKERS.map((m) => text.lastIndexOf(m, to)));
    const lineEnd = lead >= 0 ? text.indexOf("\n", lead) : -1;
    body = lead >= 0 ? text.slice(lineEnd >= 0 && lineEnd < to ? lineEnd : lead, to) : text.slice(Math.max(0, to - maxChars), to);
    header = "";
  } else {
    return null;
  }
  const description = truncate(body.trim(), maxChars);
  if (description.length < 200) return null;
  return withVisa({ id: card.id, board: card.board, url: detailUrl(card), header: header.trim(), description }, body);
}
