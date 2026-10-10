import { describe, expect, it } from "vitest";
import {
  boardJobId,
  detailUrl,
  extractBoardCards,
  extractDetail,
  extractPublicPosting,
  pickDetailCards,
  publicPostingUrl,
  type BoardCard,
} from "../board-details";

const para = (n: number) =>
  Array.from({ length: n }, (_, i) => `<p>Build product UI in React and TypeScript, item ${i}.</p>`).join("");

describe("boardJobId", () => {
  it.each([
    ["linkedin", "https://www.linkedin.com/jobs/view/frontend-engineer-at-bobyard-4452691522?position=1&amp;pageNum=0", "linkedin:4452691522"],
    ["linkedin", "/jobs/view/4012345678/", "linkedin:4012345678"],
    ["linkedin", "https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=x", "linkedin:4012345678"],
    ["linkedin", "https://www.linkedin.com/company/figma/", null],
    ["indeed", "/rc/clk?jk=9F3a1b2c3d4e5f60&amp;from=serp", "indeed:9f3a1b2c3d4e5f60"],
    ["indeed", "https://www.indeed.com/viewjob?vjk=0123456789abcdef", "indeed:0123456789abcdef"],
    ["indeed", "https://www.indeed.com/cmp/Figma", null],
  ] as const)("%s %s", (board, href, id) => {
    expect(boardJobId(board, href)).toBe(id);
  });
});

describe("extractBoardCards", () => {
  it("returns one card per job in page order, with the longest link text as title", () => {
    const html = `
      <ul>
        <li><a href="/jobs/view/frontend-engineer-at-acme-1111111111?trk=a"><span>Frontend Engineer</span></a>
            <a href="/jobs/view/1111111111/">Acme</a></li>
        <li><a href="https://www.linkedin.com/jobs/view/2222222222/">Data Analyst</a></li>
        <li><a href="/feed/">Home</a></li>
      </ul>`;
    expect(extractBoardCards("linkedin", html)).toEqual([
      { id: "linkedin:1111111111", board: "linkedin", title: "Frontend Engineer" },
      { id: "linkedin:2222222222", board: "linkedin", title: "Data Analyst" },
    ]);
  });
});

describe("pickDetailCards", () => {
  const card = (id: string, title: string): BoardCard => ({ id, board: "linkedin", title });

  it("takes matching titles in turn from each page, skipping known jobs", () => {
    const pageA = [card("linkedin:1", "Frontend Engineer"), card("linkedin:2", "Sales Manager"), card("linkedin:3", "Senior Frontend Engineer")];
    const pageB = [card("linkedin:3", "Senior Frontend Engineer"), card("linkedin:4", "Frontend Engineer II"), card("linkedin:5", "")];
    const picked = pickDetailCards([pageA, pageB], { roles: ["Frontend Engineer"], seenIds: ["linkedin:4"], max: 3 });
    expect(picked.map((c) => c.id)).toEqual(["linkedin:1", "linkedin:3", "linkedin:5"]);
  });
});

describe("detailUrl", () => {
  it("rebuilds the page URL from the id", () => {
    expect(detailUrl({ id: "linkedin:4452691522", board: "linkedin" })).toBe("https://www.linkedin.com/jobs/view/4452691522/");
    expect(detailUrl({ id: "indeed:abc123def4567890", board: "indeed" })).toBe("https://www.indeed.com/viewjob?jk=abc123def4567890");
  });
});

describe("publicPostingUrl", () => {
  it("reads LinkedIn postings from the public endpoint and leaves Indeed to a tab", () => {
    expect(publicPostingUrl({ id: "linkedin:4418865373", board: "linkedin" })).toBe(
      "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4418865373",
    );
    expect(publicPostingUrl({ id: "indeed:abc123def4567890", board: "indeed" })).toBeNull();
  });
});

describe("extractPublicPosting", () => {
  it("reads the description markup whatever language the page is in", () => {
    const html =
      `<h2 class="top-card-layout__title font-sans">Software Engineer, Ads Manager</h2>` +
      `<a class="topcard__org-name-link" href="#">OpenAI</a><span class="topcard__flavor topcard__flavor--bullet">美国 华盛顿州 西雅图</span>` +
      `<div>注册后可申请</div><div class="description__text description__text--rich"><section>` +
      `<div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5
 relative overflow-hidden">` +
      `<strong>About The Team<br><br></strong>${para(6)}</div>` +
      `<button class="show-more-less-html__button show-more-less-button">显示更多</button></section></div><h3>职位级别</h3>`;
    const detail = extractPublicPosting({ id: "linkedin:4418865373", board: "linkedin" }, html)!;
    expect(detail.header).toBe("Software Engineer, Ads Manager · OpenAI · 美国 华盛顿州 西雅图");
    expect(detail.description.startsWith("About The Team")).toBe(true);
    expect(detail.description).not.toMatch(/显示更多|职位级别|注册/);
    expect(detail.url).toBe("https://www.linkedin.com/jobs/view/4418865373/");
  });
});

describe("extractDetail", () => {
  const card = { id: "linkedin:1111111111", board: "linkedin" as const };

  it("cuts the description between its heading and the page furniture after it", () => {
    const html = `<h1>Frontend Engineer</h1><div>Acme · San Francisco, CA · 2 days ago</div>
      <h2>About the job</h2>${para(8)}<button>See more</button><h2>About the company</h2><p>Acme makes anvils.</p>`;
    const detail = extractDetail(card, html)!;
    expect(detail.url).toBe("https://www.linkedin.com/jobs/view/1111111111/");
    expect(detail.header).toContain("Acme · San Francisco, CA");
    expect(detail.description.startsWith("Build product UI")).toBe(true);
    expect(detail.description).not.toContain("anvils");
  });

  it("reads LinkedIn's signed-in layout", () => {
    const html =
      `<h1>Frontend Engineer</h1><div>San Francisco, CA · Reposted 1 month ago</div><div>Use AI to assess how you fit</div>` +
      `<h2>About the job</h2>${para(8)}<span>… more</span><h2>Set alert for similar jobs</h2><div>Unlock hiring insights</div>`;
    const detail = extractDetail(card, html)!;
    expect(detail.header).toContain("Reposted 1 month ago");
    expect(detail.description.startsWith("Build product UI")).toBe(true);
    expect(detail.description).not.toMatch(/more|alert|insights/);
  });

  it("lists cards from the job links the content script adds to LinkedIn's new search page", () => {
    const html = `<div>Results</div><section><h2>Job cards on this page</h2><ul>
      <li><a href="https://www.linkedin.com/jobs/view/4441658726/">Senior Frontend Engineer</a> · MrBeast · San Mateo, CA (Hybrid)</li>
      <li><a href="https://www.linkedin.com/jobs/view/4418865373/">Software Engineer, ChatGPT Shopping</a> · OpenAI · San Francisco, CA</li>
    </ul></section>`;
    expect(extractBoardCards("linkedin", html).map((c) => [c.id, c.title])).toEqual([
      ["linkedin:4441658726", "Senior Frontend Engineer"],
      ["linkedin:4418865373", "Software Engineer, ChatGPT Shopping"],
    ]);
  });

  it("reads LinkedIn's signed-out layout, which has no heading", () => {
    const html =
      `<div>Sign in</div><div>Forgot password?</div><a href="#">Report this job</a>` +
      `<div>Use AI to assess how you fit</div><div>Email or phone</div>` +
      `<div>By clicking Continue, you agree to LinkedIn’s User Agreement and Cookie Policy .</div>` +
      `${para(8)}<button>Show more</button><h3>Seniority level</h3>`;
    const detail = extractDetail(card, html)!;
    expect(detail.description.startsWith("Build product UI")).toBe(true);
    expect(detail.description).not.toMatch(/password|assess|Cookie|Show more/);
  });

  it("reads Indeed's layout and caps the length", () => {
    const html = `<h1>Frontend Engineer</h1><h2>Full job description</h2>${para(200)}<div>Report job</div>`;
    const detail = extractDetail({ id: "indeed:abc123def4567890", board: "indeed" }, html, 1000)!;
    expect(detail.description.length).toBeLessThanOrEqual(1000);
    expect(detail.url).toContain("viewjob?jk=abc123def4567890");
  });

  it("returns null for a sign-in wall or captcha", () => {
    expect(extractDetail(card, "<h1>Sign in to view this job</h1><p>Email</p><p>Password</p>")).toBeNull();
    expect(extractDetail(card, "<h2>About the job</h2><p>Short.</p><button>See more</button>")).toBeNull();
  });
});
