// ENGINE: one entry point for every message, first run or update.
// read (1 model call) -> merge facts (code) -> area calls only where needed -> plan (code) -> validate (code)
// A message that makes a passing check fail is rejected and the previous plan is kept.
import { readMessages } from "./reader.mjs";
import { applyMessage, emptyStore } from "./facts.mjs";
import { buildPlan } from "./planner.mjs";
import { validate } from "./validate.mjs";
import { resolveAreas } from "./resolvers.mjs";
import { modelName } from "./llm.mjs";

export function emptyState() {
  return { store: emptyStore(), cache: {}, processed: [], messages: [], plan: null, validation: null, runs: [], callCount: 0 };
}

/** Which part of `text` is new compared with what we already processed. */
export function newPart(state, text) {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  if (state.processed.some((p) => p === t)) return "";
  const prev = [...state.processed].sort((a, b) => b.length - a.length).find((p) => t.startsWith(p));
  return prev ? t.slice(prev.length).trim() : t;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const passing = (v) => new Set(v.checks.filter((c) => c.ok).map((c) => c.name));
const dateRank = (d) => { const t = d ? Date.parse(d) : NaN; return Number.isNaN(t) ? Infinity : t; };

export async function run(state, text, source = "input") {
  const isFirst = state.processed.length === 0;
  const trace = {
    calls: [], notes: [], kind: isFirst ? "full run" : "update", source, model: modelName(), started: new Date().toISOString(),
    // brief limits: full run cut at 2 min; update at most 5 model calls and 1 min. We stop early with margin.
    deadline: Date.now() + (isFirst ? 110000 : 52000), maxCalls: isFirst ? 0 : 5,
  };
  const snapshot = clone(state);
  try {
    await runInner(state, text, trace);
  } catch (e) {
    // never leave a half-applied state: restore, keep the previous valid plan, explain in the trace
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, snapshot);
    trace.kind += " (failed)";
    trace.notes.push({ kind: "error", text: `Run stopped: ${e.message}. Previous plan kept.` });
  }
  return finish(state, trace);
}

async function runInner(state, text, trace) {
  const fresh = newPart(state, text);
  if (!fresh) {
    trace.notes.push({ kind: "info", text: "No new messages in this file. Plan unchanged." });
    return;
  }

  // 1. READING: one model call for all new messages
  const msgs = await readMessages(trace, fresh);
  if (!msgs.length) throw new Error("the reader found no messages in the input");
  const offset = state.messages.length;
  msgs.forEach((m, i) => (m.id = offset + i + 1));
  msgs.sort((a, b) => dateRank(a.date) - dateRank(b.date) || a.id - b.id);

  // 2. MERGE: apply message by message; reject any message that breaks a check that was passing
  for (const m of msgs) {
    const record = { id: m.id, sender: m.sender, role: m.role, date: m.date, summary: m.summary, status: "used", reasons: [] };
    if (m.ignored) {
      record.status = "ignored";
      record.reasons.push(m.ignored);
      trace.notes.push({ kind: "ignored", text: `#${m.id} ${m.sender}: ignored, ${m.ignored}` });
      state.messages.push(record);
      continue;
    }
    const beforeStore = clone(state.store);
    const beforeCheck = validate(buildPlan(state.store, decisionsFromCache(state.cache)));
    const res = applyMessage(state.store, m);
    const afterCheck = validate(buildPlan(state.store, decisionsFromCache(state.cache)));

    const hc = buildPlan(beforeStore, decisionsFromCache(state.cache)).event.headcount;
    for (const r of res.rejected) if (r.fact.k === "food.quantity" && hc && Number(r.fact.v) < hc) r.reason += `; it would also leave ${hc - Number(r.fact.v)} of ${hc} people without food`;
    for (const r of res.rejected) trace.notes.push({ kind: "rejected", text: `#${m.id} ${m.sender}: ${r.fact.k}${r.fact.item ? ` (${r.fact.item})` : ""} = ${JSON.stringify(r.fact.v)} not used: ${r.reason}` });
    for (const o of res.outdated) trace.notes.push({ kind: "outdated", text: `#${m.id} ${m.sender}: ${o.fact.k}${o.fact.item ? ` (${o.fact.item})` : ""} out of date: ${o.reason}` });
    for (const s of res.superseded) trace.notes.push({ kind: "superseded", text: `#${m.id} ${m.sender}: ${s.now.k}${s.now.item ? ` (${s.now.item})` : ""} ${JSON.stringify(s.old.v)} -> ${JSON.stringify(s.now.v)} (replaces #${s.old.msgId})` });

    const was = passing(beforeCheck);
    const broken = afterCheck.checks.filter((c) => !c.ok && was.has(c.name));
    if (broken.length) {
      state.store = beforeStore; // keep the plan valid: undo this message entirely
      record.status = "rejected";
      record.reasons.push(...broken.map((c) => `would break "${c.name}": ${c.detail}`));
      for (const r of res.rejected) record.reasons.push(r.reason);
      trace.notes.push({ kind: "rejected", text: `#${m.id} ${m.sender} REJECTED: ${record.reasons.join("; ")}` });
    } else if (res.rejected.length && !res.accepted.length && !m.constraints.length) {
      record.status = "rejected";
      record.reasons.push(...res.rejected.map((r) => r.reason));
      trace.notes.push({ kind: "rejected", text: `#${m.id} ${m.sender} REJECTED: ${record.reasons.join("; ")}` });
    } else if (res.outdated.length && !res.accepted.length && !m.constraints.length) {
      record.status = "outdated";
      record.reasons.push(...res.outdated.map((o) => o.reason));
    } else if (res.rejected.length) {
      record.status = "partly used";
      record.reasons.push(...res.rejected.map((r) => r.reason));
    }
    state.messages.push(record);
  }

  // 3. AREA CALLS: only for areas whose constraints changed (update budget: max 5 calls in total)
  const cacheBefore = clone(state.cache);
  const constraintsBefore = state.store.constraints.filter((c) => !msgs.some((m) => m.id === c.msgId));
  const { decisions, called } = await resolveAreas(trace, state.store, state.cache, areaContext(state));
  if (called.length) trace.notes.push({ kind: "info", text: `Area model calls for new constraints: ${called.join(", ")}` });

  // 4. PLAN + VALIDATE (code)
  const plan = buildPlan(state.store, decisions);
  const validation = validate(plan);
  if (!validation.ok && state.validation?.ok) {
    // a new constraint made the plan invalid: drop it, keep the previous valid plan, and say why
    const failed = validation.checks.filter((c) => !c.ok).map((c) => `"${c.name}": ${c.detail}`);
    const culprits = new Set(state.store.constraints.filter((c) => !constraintsBefore.includes(c)).map((c) => c.msgId));
    state.store.constraints = constraintsBefore;
    state.cache = cacheBefore;
    for (const rec of state.messages.filter((r) => culprits.has(r.id))) {
      rec.status = "rejected";
      rec.reasons.push(`would break ${failed.join("; ")}`);
      trace.notes.push({ kind: "rejected", text: `#${rec.id} ${rec.sender} REJECTED: would break ${failed.join("; ")}. Previous plan kept.` });
    }
  } else {
    state.plan = plan;
    state.validation = validation;
  }
  state.processed.push(text.replace(/\r\n/g, "\n").trim());
}

function decisionsFromCache(cache) {
  const d = {};
  for (const [area, v] of Object.entries(cache)) d[area] = v.ops;
  return d;
}

function areaContext(state) {
  const p = state.plan;
  const opts = (k) => state.store.entries.filter((e) => e.active && e.k === k).map((e) => ({ name: e.item, ...(typeof e.v === "object" ? e.v : { value: e.v }) }));
  return {
    venue: { options: opts("venue.option") },
    food: { options: opts("food.option"), headcount: p?.event.headcount },
    schedule: { hours: p?.event.hours, blocks: p?.schedule?.blocks.map((b) => `${b.name} ${b.minutes}m`) },
    judging: { teams: p?.event.teams },
    budget: { total: p?.budget.total, spent: p?.budget.spent },
  };
}

function finish(state, trace) {
  const areas = [...new Set(trace.calls.map((c) => c.area))];
  trace.notes.push({ kind: "info", text: `Areas that made model calls: ${areas.length ? areas.join(", ") : "none"}` });
  for (const c of trace.calls) c.n = ++state.callCount;
  const tokens = trace.calls.reduce((s, c) => s + c.tokens.total, 0);
  trace.totalTokens = tokens;
  state.runs.push({ kind: trace.kind, source: trace.source, at: trace.started, calls: trace.calls, notes: trace.notes, totalTokens: tokens, valid: state.validation?.ok ?? false });
  return trace;
}
