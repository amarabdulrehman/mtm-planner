// Model access + trace recording. Every model call in the system goes through call().
// Fallback chain so a quota error never stops a run: each Gemini key x each model, then an
// optional OpenAI-compatible provider (Groq, OpenRouter, or a local Ollama/LM Studio server).
// The trace records the model that actually answered and the token counts it reported.
import { GoogleGenAI } from "@google/genai";

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);
let preferred = 0; // index of the last candidate that worked; later calls start there

function candidates() {
  const env = process.env;
  const keys = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_BACKUP, ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => env[`GEMINI_API_KEY_${i}`])]
    .filter(Boolean);
  const models = [env.GEMINI_MODEL || "gemini-3.5-flash-lite", ...(env.GEMINI_FALLBACK_MODELS || "gemini-3.1-flash-lite,gemini-3.5-flash").split(",")]
    .map((s) => s.trim()).filter((m, i, a) => m && a.indexOf(m) === i);
  const list = [];
  // first every key on the main model, then the fallback models
  for (const model of models) keys.forEach((key, i) => list.push({ kind: "gemini", model, key, label: `gemini key ${i + 1}` }));
  if (env.OPENAI_COMPAT_URL) {
    const compat = [...(env.OPENAI_COMPAT_MODEL || "").split(","), "openai/gpt-oss-20b"].map((s) => s.trim()).filter((m, i, a) => m && a.indexOf(m) === i);
    for (const model of compat) {
      list.push({ kind: "openai", model, key: env.OPENAI_COMPAT_KEY || "none", url: env.OPENAI_COMPAT_URL.replace(/\/$/, ""), label: "openai-compatible" });
    }
  }
  return list;
}

export const modelName = () => candidates()[preferred]?.model ?? "none";

let currentDeadline = 0;
function withTimeout(p) {
  const left = currentDeadline ? Math.max(1000, currentDeadline - Date.now() - 2000) : TIMEOUT_MS;
  const ms = Math.min(TIMEOUT_MS, left);
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

async function callGemini(c, system, input, maxOutputTokens) {
  const ai = new GoogleGenAI({ apiKey: c.key });
  const config = { systemInstruction: system, responseMimeType: "application/json", temperature: 0, maxOutputTokens };
  // thinking costs tokens: ask for the least the model allows
  if (process.env.GEMINI_THINKING !== "on") config.thinkingConfig = /gemini-2/.test(c.model) ? { thinkingBudget: 0 } : { thinkingLevel: "MINIMAL" };
  let res;
  try {
    res = await withTimeout(ai.models.generateContent({ model: c.model, contents: input, config }));
  } catch (e) {
    if (!config.thinkingConfig || !/think/i.test(String(e?.message))) throw e;
    delete config.thinkingConfig; // this model does not accept the setting: use its default
    res = await withTimeout(ai.models.generateContent({ model: c.model, contents: input, config }));
  }
  const u = res.usageMetadata ?? {};
  return {
    text: res.text ?? "",
    model: res.modelVersion || c.model,
    tokens: { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0, total: u.totalTokenCount ?? 0 },
  };
}

async function callOpenAI(c, system, input, maxOutputTokens) {
  const res = await withTimeout(fetch(`${c.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` },
    body: JSON.stringify({
      model: c.model, temperature: 0, max_tokens: maxOutputTokens, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: input }],
    }),
  }));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const u = j.usage ?? {};
  return {
    text: j.choices?.[0]?.message?.content ?? "",
    model: j.model || c.model,
    tokens: { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, thinking: 0, total: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) },
  };
}

export async function call(trace, { area, system, input, maxOutputTokens = 2048 }) {
  if (trace.maxCalls && trace.calls.length >= trace.maxCalls) throw new Error(`call limit ${trace.maxCalls} reached`);
  currentDeadline = trace.deadline || 0;
  const list = candidates();
  if (!list.length) throw new Error("No model configured: set GEMINI_API_KEY in .env");
  const order = [...list.slice(preferred), ...list.slice(0, preferred)];
  let lastErr;
  for (const c of order) {
    if (trace.deadline && Date.now() > trace.deadline - 3000) { lastErr = new Error("time limit reached"); break; }
    if (trace.maxCalls && trace.calls.length >= trace.maxCalls) { lastErr = new Error(`call limit ${trace.maxCalls} reached`); break; }
    const started = Date.now();
    try {
      const r = c.kind === "gemini" ? await callGemini(c, system, input, maxOutputTokens) : await callOpenAI(c, system, input, maxOutputTokens);
      // every answered call is traced with its real token counts, even if its reply is unusable
      trace.calls.push({ n: trace.calls.length + 1, model: r.model, area, system, input, output: r.text, tokens: r.tokens, ms: Date.now() - started });
      const parsed = parseJson(r.text); // a reply that is not JSON counts as a failure: try the next candidate
      preferred = list.indexOf(c);
      return parsed;
    } catch (e) {
      lastErr = e;
      trace.notes.push({ kind: "error", text: `Model call (${area}) failed on ${c.model} via ${c.label}: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160)}. Trying next.` });
    }
  }
  throw new Error(`All models failed. Last error: ${lastErr?.message}`);
}

// Accept the first complete JSON value in the reply, ignoring text before or after it.
function parseJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const s = t.search(/[{[]/);
    if (s < 0) throw new Error("Model did not return JSON: " + t.slice(0, 120));
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { depth--; if (depth === 0) return JSON.parse(t.slice(s, i + 1)); }
    }
    throw new Error("Model returned incomplete JSON: " + t.slice(0, 120));
  }
}
