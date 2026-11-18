#!/usr/bin/env node
// The one command:  npm run plan -- <messages.txt>
// First run: plans from every message. Later runs: only the new messages are read and the plan is updated.
import "./src/env.mjs"; // load .env before anything reads it
import { readFileSync, existsSync } from "node:fs";
import { run, emptyState } from "./src/engine.mjs";
import { loadState, save, planText } from "./src/report.mjs";

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error("Usage: npm run plan -- <messages.txt>");
  process.exit(1);
}

const state = loadState(emptyState);
const t0 = Date.now();
let trace;
try {
  trace = await run(state, readFileSync(file, "utf8"), file);
} catch (e) {
  // never lose the trace: record the failure, keep the previous plan
  trace = state.lastTrace ?? { calls: [], notes: [], kind: "failed run", source: file, started: new Date().toISOString(), totalTokens: 0 };
  trace.notes.push({ kind: "error", text: `Run failed: ${e.message}. Previous plan kept.` });
  state.runs.push({ kind: "failed run", source: file, at: trace.started, calls: trace.calls, notes: trace.notes, totalTokens: trace.calls.reduce((s, c) => s + c.tokens.total, 0), valid: state.validation?.ok ?? false });
  process.exitCode = 1;
}
const text = save(state, trace);
console.log(text);
console.log("\n" + planText(state));
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s. Saved out/plan.md and out/trace.txt. UI: npm run ui`);
