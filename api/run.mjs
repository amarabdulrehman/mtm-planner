// Vercel serverless function: the SAME engine as `npm run plan`, but stateless.
// The browser keeps its own plan state and sends it with each new message; we return the updated state.
// GET /api/run -> health check (is a model key configured?)
import { run, emptyState } from "../src/engine.mjs";
import { buildOutbox } from "../src/outbox.mjs";

const MAX_TEXT = 12000, MAX_STATE = 2_000_000;

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET") {
    const configured = Object.keys(process.env).some((k) => /^GEMINI_API_KEY/.test(k) && process.env[k]) || !!process.env.OPENAI_COMPAT_API_KEY;
    return res.status(200).json({ ok: true, configured });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    const text = String(body.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "Message is empty" });
    if (text.length > MAX_TEXT) return res.status(413).json({ error: "That is too long for one update (max 12,000 characters)." });
    if (body.state && JSON.stringify(body.state).length > MAX_STATE) return res.status(413).json({ error: "Plan history is too large. Start a new plan." });
    const state = body.state && body.state.store ? body.state : emptyState();
    const trace = await run(state, text, body.source || "web");
    state.outbox = buildOutbox(state);
    const r = state.runs.at(-1);
    return res.status(200).json({ state, run: { valid: state.validation?.ok ?? false, calls: r.calls.length, tokens: r.totalTokens, ms: r.runMs, notes: r.notes.filter((x) => x.kind !== "info").map((x) => `[${x.kind}] ${x.text}`) } });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
