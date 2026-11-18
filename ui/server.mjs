// UI: npm run ui  ->  http://localhost:4321
// Shows the plan, checks, rejected messages and the full trace from out/. Refreshes every 2 s,
// so it updates live while you run `npm run plan -- <file>` in the terminal.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

const OUT = new URL("../out/", import.meta.url);
const html = readFileSync(new URL("./index.html", import.meta.url));

createServer((req, res) => {
  if (req.url === "/api/state") {
    const f = new URL("state.json", OUT);
    const state = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(state));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(4321, () => console.log("UI on http://localhost:4321"));
