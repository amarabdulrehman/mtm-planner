// UI: npm run ui  ->  http://localhost:4321
// Shows the plan, checks, rejected messages, trace and outbox from out/. Refreshes every 2 s, so it also
// updates live while you run `npm run plan -- <file>` in the terminal.
// "Add a message" in the UI posts here and runs the SAME engine as the command line (same limits, same trace).
import "../src/env.mjs";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { run, emptyState } from "../src/engine.mjs";
import { loadState, save } from "../src/report.mjs";

const OUT = new URL("../out/", import.meta.url);
const html = readFileSync(new URL("./index.html", import.meta.url));
let busy = false;

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

createServer((req, res) => {
  if (req.url === "/api/state") {
    const f = new URL("state.json", OUT);
    return json(res, 200, existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
  }
  if (req.url === "/api/message" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", async () => {
      if (busy) return json(res, 409, { error: "An update is already running. Try again in a moment." });
      let text;
      try { text = String(JSON.parse(body).text ?? "").trim(); } catch { return json(res, 400, { error: "Bad request" }); }
      if (!text) return json(res, 400, { error: "Message is empty" });
      busy = true;
      try {
        const state = loadState(emptyState);
        const trace = await run(state, text, "UI");
        save(state, trace);
        const n = state.runs.at(-1);
        json(res, 200, { ok: true, valid: state.validation?.ok ?? false, calls: n.calls.length, tokens: n.totalTokens, ms: n.runMs, notes: n.notes.filter((x) => x.kind !== "info").map((x) => `[${x.kind}] ${x.text}`) });
      } catch (e) {
        json(res, 500, { error: e.message });
      } finally { busy = false; }
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(4321, () => console.log("UI on http://localhost:4321"));
