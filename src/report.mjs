// OUTPUT: prints the trace and the plan, and saves both to out/ (plan.md, trace.txt, state.json).
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { buildOutbox, outboxText } from "./outbox.mjs";
import { traceText, planText } from "./text.mjs";
export { traceText, planText, assignmentLines, exportText, originalWording } from "./text.mjs";

const OUT = new URL("../out/", import.meta.url);

export function loadState(empty) {
  const f = new URL("state.json", OUT);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : empty();
}

export function save(state, trace) {
  mkdirSync(OUT, { recursive: true });
  state.outbox = buildOutbox(state); // reply drafts, plain code, no model calls
  const t = traceText(trace, state);
  writeFileSync(new URL("state.json", OUT), JSON.stringify(state, null, 1));
  writeFileSync(new URL("plan.md", OUT), planText(state));
  writeFileSync(new URL("outbox.txt", OUT), outboxText(state.outbox));
  appendFileSync(new URL("trace.txt", OUT), t + "\n\n");
  // one file to upload: final plan + full trace of every run
  writeFileSync(new URL("submission.txt", OUT), planText(state) + "\n\n\n" + readFileSync(new URL("trace.txt", OUT), "utf8") + "\n\n=== OUTBOX (reply drafts, made by code, not sent)\n" + outboxText(state.outbox));
  return t;
}
