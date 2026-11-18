#!/usr/bin/env node
// The one command:  npm run plan -- <messages.txt>
// First run: plans from every message. Later runs: only the new messages are read and the plan is updated.
import { readFileSync, existsSync } from "node:fs";
import { run, emptyState } from "./src/engine.mjs";
import { loadState, save, planText } from "./src/report.mjs";

// load .env without extra dependencies
if (existsSync(new URL(".env", import.meta.url))) {
  for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("Usage: npm run plan -- <messages.txt>");
  process.exit(1);
}

const state = loadState(emptyState);
const t0 = Date.now();
const trace = await run(state, readFileSync(file, "utf8"), file);
const text = save(state, trace);
console.log(text);
console.log("\n" + planText(state));
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s. Saved out/plan.md and out/trace.txt. UI: npm run ui`);
