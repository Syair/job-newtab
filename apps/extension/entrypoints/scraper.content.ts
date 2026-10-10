/**
 * Injected on demand by lib/scraper.ts (never auto-registered). Scrolls the page
 * to trigger lazy-loaded content, waits for it to settle, then returns its title
 * and body HTML.
 */
export default defineContentScript({
  registration: "runtime",
  main() {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * The window plus every element that scrolls on its own. LinkedIn's signed-in
     * pages scroll inside <main> and the results list, not the window, and only
     * render a job description or more cards once those panels scroll.
     */
    const scrollers = (): Element[] => [
      document.scrollingElement ?? document.documentElement,
      ...[...document.querySelectorAll("main, div, ul, section")].filter(
        (el) => el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY),
      ),
    ];

    /**
     * LinkedIn's signed-in search renders each result as
     * <div componentkey="job-card-component-ref-<id>"> with no link, and the list
     * may drop cards that scroll out of view. Collect them while scrolling.
     */
    const linkedinCards = new Map<string, string[]>();
    const collectLinkedInCards = () => {
      for (const el of document.querySelectorAll('[componentkey^="job-card-component-ref-"]')) {
        const id = el.getAttribute("componentkey")!.slice("job-card-component-ref-".length);
        if (!/^\d{6,}$/.test(id) || linkedinCards.has(id)) continue;
        const lines = (el as HTMLElement).innerText
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        if (lines.length) linkedinCards.set(id, lines.slice(0, 4));
      }
    };

    const scrollPage = async () => {
      for (let step = 0; step < 12; step++) {
        let moved = false;
        for (const el of scrollers()) {
          const before = el.scrollTop;
          el.scrollTop = before + el.clientHeight * 0.8;
          if (el.scrollTop !== before) moved = true;
        }
        collectLinkedInCards();
        await sleep(500);
        if (!moved) break;
      }
      for (const el of scrollers()) el.scrollTop = 0;
      await sleep(200);
    };

    /** Wait until the page stops adding text (lazy sections, client rendering), at most 8 s. */
    const waitForStableText = async () => {
      let last = -1;
      let stable = 0;
      for (let waited = 0; waited < 8000 && stable < 3; waited += 500) {
        const length = document.body.innerText.length;
        stable = length === last ? stable + 1 : 0;
        last = length;
        await sleep(500);
      }
    };

    const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

    const convertPageToHTML = async () => {
      await waitForStableText();
      await scrollPage();
      await waitForStableText();
      collectLinkedInCards();

      let html = document.body.innerHTML;
      if (linkedinCards.size > 0) {
        // Give each card a real job link, so the extension and the agent can tell
        // which posting it is: title as the link text, then company and place.
        const items = [...linkedinCards].map(
          ([id, [title, ...rest]]) =>
            `<li><a href="https://www.linkedin.com/jobs/view/${id}/">${escape(title)}</a> · ${escape(rest.join(" · "))}</li>`,
        );
        html += `<section><h2>Job cards on this page</h2><ul>${items.join("")}</ul></section>`;
      }
      return { title: document.title, html };
    };

    // executeScript resolves with this value
    return convertPageToHTML();
  },
});
