// OUTPUT: prints the trace and the plan, and saves both to out/ (plan.md, trace.txt, state.json).
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";

const OUT = new URL("../out/", import.meta.url);
const rs = (n) => (n == null ? "?" : "Rs " + Number(n).toLocaleString("en-US"));

export function loadState(empty) {
  const f = new URL("state.json", OUT);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : empty();
}

export function traceText(trace, state) {
  const L = [];
  L.push(`=== TRACE: ${trace.kind} (${trace.source}) at ${trace.started} ===`);
  for (const c of trace.calls) {
    L.push(`--- Call ${c.n} | model: ${c.model} | area: ${c.area} | tokens in ${c.tokens.input}, out ${c.tokens.output}${c.tokens.thinking ? `, thinking ${c.tokens.thinking}` : ""}, total ${c.tokens.total} | ${c.ms} ms`);
    L.push(`INPUT (system prompt):\n${c.system ?? ""}`);
    L.push(`INPUT (messages/context):\n${c.input}`);
    L.push(`OUTPUT:\n${c.output}`);
  }
  if (!trace.calls.length) L.push("(no model calls)");
  if (trace.notes.length) {
    L.push("--- Decisions made in code:");
    for (const n of trace.notes) L.push(`[${n.kind}] ${n.text}`);
  }
  const all = state.runs.reduce((s, r) => s + r.totalTokens, 0);
  L.push(`=== Model calls this run: ${trace.calls.length} | Total tokens this run: ${trace.totalTokens} | Total tokens all runs: ${all} ===`);
  return L.join("\n");
}

export function planText(state) {
  const p = state.plan, v = state.validation;
  if (!p) return "No plan yet.";
  const L = [];
  L.push(`# Hackathon plan ${v?.ok ? "(VALID)" : "(INVALID)"}`);
  L.push(`${p.event.students} students in ${p.event.teams} teams, ${p.event.hours} h, ${p.event.staff} staff, ${p.judging.judgesNeeded} judges -> ${p.event.headcount} people on site`);
  L.push("");
  L.push("## Venue");
  if (p.venue) L.push(`${p.venue.name}: ${p.venue.capacity} seats, ${rs(p.venue.price)} (cheapest of ${p.venue.feasible.length} that fit ${p.event.headcount} people${p.venue.requiredFeatures.length ? ` with ${p.venue.requiredFeatures.join(", ")}` : ""}) [${p.venue.source}]`);
  for (const n of p.venue?.notes ?? []) L.push(`- ${n}`);
  L.push("");
  L.push("## Schedule");
  for (const b of p.schedule?.blocks ?? []) L.push(`${b.start}-${b.end}  ${b.name} (${b.minutes} min)`);
  for (const n of p.schedule?.notes ?? []) L.push(`- ${n}`);
  L.push("");
  L.push("## Food");
  if (p.food) L.push(`${p.food.quantity} x ${p.food.option} @ ${rs(p.food.pricePerHead)} = ${rs(p.food.quantity * p.food.pricePerHead)}${p.food.fixed.length ? ` + ${p.food.fixed.map((f) => `${f.item} ${rs(f.amount)}`).join(", ")}` : ""}`);
  for (const n of p.food?.notes ?? []) L.push(`- ${n}`);
  L.push("");
  L.push("## Judging");
  const j = p.judging;
  L.push(`${j.judgesNeeded} judges needed of ${j.judgesAvailable} available: ${j.teams} teams x ${j.judgesPerTeam} judge(s), max ${j.maxTeamsPerJudge} teams each, ${j.minutesPerTeam} min per team -> ${j.judgingMinutes} min judging. Fees ${j.judgesNeeded} x ${rs(j.feePerJudge)} = ${rs(j.feeTotal)}`);
  for (const n of j.notes) L.push(`- ${n}`);
  L.push("");
  L.push("## Budget");
  for (const l of p.budget.lines) L.push(`${rs(l.amount).padStart(12)}  ${l.item}`);
  L.push(`${rs(p.budget.spent).padStart(12)}  TOTAL of ${rs(p.budget.total)} (remaining ${rs(p.budget.remaining)})`);
  for (const r of p.budget.requests) L.push(`Not included: ${r.item} ${rs(r.amount)} (request only, not approved${r.affordable ? "; would still fit" : "; would not fit"})`);
  for (const n of p.budget.notes) L.push(`- ${n}`);
  L.push("");
  L.push("## Checks");
  for (const c of v?.checks ?? []) L.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  if (p.assumptions.length) { L.push(""); L.push("## Assumptions"); for (const a of p.assumptions) L.push(`- ${a}`); }
  const rej = state.messages.filter((m) => m.status === "rejected");
  if (rej.length) { L.push(""); L.push("## Rejected messages"); for (const m of rej) L.push(`#${m.id} ${m.sender} (${m.date ?? "no date"}): ${m.summary}\n   reason: ${m.reasons.join("; ")}`); }
  return L.join("\n");
}

export function save(state, trace) {
  mkdirSync(OUT, { recursive: true });
  const t = traceText(trace, state);
  writeFileSync(new URL("state.json", OUT), JSON.stringify(state, null, 1));
  writeFileSync(new URL("plan.md", OUT), planText(state));
  appendFileSync(new URL("trace.txt", OUT), t + "\n\n");
  // one file to upload: final plan + full trace of every run
  writeFileSync(new URL("submission.txt", OUT), planText(state) + "\n\n\n" + readFileSync(new URL("trace.txt", OUT), "utf8"));
  return t;
}
