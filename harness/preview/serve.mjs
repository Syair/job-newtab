// Serves the built extension's new-tab page with mock chrome.* APIs injected.
// Run `pnpm build` first, then: node harness/preview/serve.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "../../apps/extension/.output/chrome-mv3");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const port = Number(process.env.PORT ?? 5180);

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[/\\]+/, "");
  try {
    if (path === "mock-chrome.js") {
      res.writeHead(200, { "content-type": types[".js"] });
      return res.end(await readFile(join(here, "mock-chrome.js")));
    }
    const file = join(root, path === "" ? "newtab.html" : path);
    if (!file.startsWith(root)) throw new Error("outside root");
    let body = await readFile(file);
    if (file.endsWith("newtab.html")) {
      body = body.toString().replace("<head>", '<head><script src="/mock-chrome.js"></script>');
    }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`preview on http://localhost:${port}/?state=board`));
