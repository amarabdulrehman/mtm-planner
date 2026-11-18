// Plain-text builders shared by the command line (report.mjs) and the web UI (download).
// Pure functions: no file system, no model calls.
import { outboxText } from "./outbox.mjs";

const rs = (n) => (n == null ? "?" : "Rs " + Number(n).toLocaleString("en-US"));

export function traceText(trace, state) {
  const L = [];
  L.push(`=== TRACE: ${trace.kind} (${trace.source}) at ${trace.started ?? trace.at} ===`);
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
  const used = {};
  for (const r of state.runs) for (const c of r.calls) used[c.model] = (used[c.model] ?? 0) + 1;
  for (const c of trace.calls) if (!state.runs.some((r) => r.calls.includes(c))) used[c.model] = (used[c.model] ?? 0) + 1;
  L.push(`Models used in all runs: ${Object.entries(used).map(([m, n]) => `${m} (${n} call${n > 1 ? "s" : ""})`).join(", ") || "none"}`);
  const callMs = trace.calls.reduce((t, c) => t + (c.ms || 0), 0);
  L.push(`=== Model calls this run: ${trace.calls.length} | Total tokens this run: ${trace.totalTokens} | Model time ${(callMs / 1000).toFixed(1)} s | Run time ${((trace.runMs ?? 0) / 1000).toFixed(1)} s | Total tokens all runs: ${all} ===`);
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
  for (const b of p.schedule?.blocks ?? []) L.push(`${b.start}-${b.end}  ${b.name} (${b.minutes} min)${b.fixed ? " [fixed time]" : ""}`);
  for (const n of p.schedule?.notes ?? []) L.push(`- ${n}`);
  L.push("");
  L.push("## Food");
  if (p.food?.special?.length) L.push(`Of which: ${p.food.special.map((x) => `${x.count} ${x.name}`).join(", ")}; ${p.food.quantity - p.food.special.reduce((t, x) => t + x.count, 0)} regular (same total, same price)`);
  if (p.food) L.push(`${p.food.quantity} x ${p.food.option} @ ${rs(p.food.pricePerHead)} = ${rs(p.food.quantity * p.food.pricePerHead)}${p.food.fixed.length ? ` + ${p.food.fixed.map((f) => `${f.item} ${rs(f.amount)}`).join(", ")}` : ""}`);
  for (const n of p.food?.notes ?? []) L.push(`- ${n}`);
  L.push("");
  L.push("## Judging");
  const j = p.judging;
  L.push(`${j.judgesNeeded} judges needed of ${j.judgesAvailable} available: ${j.teams} teams x ${j.judgesPerTeam} judge(s), max ${j.maxTeamsPerJudge} teams each, ${j.minutesPerTeam} min per team -> ${j.judgingMinutes} min judging. Fees ${j.judgesNeeded} x ${rs(j.feePerJudge)} = ${rs(j.feeTotal)}`);
  for (const line of assignmentLines(p)) L.push(line);
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

// "Judge 1: team 1 at 12:00, team 2 at 12:15, team 3 at 12:30"
export function assignmentLines(p) {
  const a = p.judging.assignments;
  if (!a) return [];
  const block = p.schedule?.blocks.find((b) => b.isJudging);
  const base = block ? block.start : null;
  const clock = (off) => {
    if (!base) return `+${off} min`;
    const rel = base.startsWith("+");
    const [h, m] = base.replace("+", "").split(":").map(Number);
    const t = h * 60 + m + off;
    return `${rel ? "+" : ""}${rel ? Math.floor(t / 60) : String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  };
  return ["Assignments (each team one uninterrupted slot, no judge double-booked):", ...a.map((x) => `  Judge ${x.judge}: ${x.teams.map((t) => `team ${t.team} at ${clock(t.offset)}`).join(", ")}`)];
}


// The message's original wording, found in the raw text the run read. Returns null when it can't be found reliably.
export function originalWording(state, id) {
  const raw = (state.processed ?? []).join("\n");
  const key = String(id).replace(/^#/, "");
  if (!raw || !key) return null;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = new RegExp(`^[ \\t]*#?[ \\t]*(?:UI|M)?${esc}(?![\\w])`, "m").exec(raw); // "UI" = typed in the app
  if (!start) return null;
  const rest = raw.slice(start.index);
  const ids = (state.messages ?? []).map((m) => String(m.id).replace(/^#/, "")).filter((x) => x !== key);
  let end = rest.length;
  for (const other of ids) {
    const o = other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\n[ \\t]*#?[ \\t]*${o}(?![\\w])`).exec(rest);
    if (m && m.index < end) end = m.index;
  }
  const gen = /\n[ \t]*#?(?:UI|M)?\d+[ \t]*[|.):\t]/.exec(rest); // any next "N |", "#N", "N." header
  if (gen && gen.index < end) end = gen.index;
  const t = rest.slice(0, end).trim();
  return t.length > 2 && t.length < 3000 ? t : null;
}

// One file with everything: the final plan, the trace of every run and call, and the reply drafts.
export function exportText(state) {
  const runs = (state.runs ?? []).map((r) => traceText(r, state)).join("\n\n");
  return `${planText(state)}\n\n\n${runs}\n\n=== OUTBOX (reply drafts, made by code, not sent)\n${outboxText(state.outbox ?? [])}\n`;
}
