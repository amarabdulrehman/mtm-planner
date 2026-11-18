// Model access + trace recording. Every model call in the system goes through call().
// The trace stores exactly what the model reports for tokens (usageMetadata).
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_BACKUP].filter(Boolean);

export const modelName = () => MODEL;

export async function call(trace, { area, system, input, maxOutputTokens = 2048 }) {
  if (!keys.length) throw new Error("GEMINI_API_KEY is not set (put it in .env)");
  let lastErr;
  for (const apiKey of keys) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const config = {
        systemInstruction: system,
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens,
      };
      // Thinking costs tokens; turn it off unless the chosen model requires it.
      if (process.env.GEMINI_THINKING !== "on") config.thinkingConfig = { thinkingBudget: 0 };
      const started = Date.now();
      let res;
      try {
        res = await ai.models.generateContent({ model: MODEL, contents: input, config });
      } catch (e) {
        if (!config.thinkingConfig || !/thinking/i.test(String(e?.message))) throw e;
        delete config.thinkingConfig; // model does not accept thinkingBudget: retry without it
        res = await ai.models.generateContent({ model: MODEL, contents: input, config });
      }
      const text = res.text ?? "";
      const u = res.usageMetadata ?? {};
      const entry = {
        n: trace.calls.length + 1,
        model: res.modelVersion || MODEL,
        area,
        input,
        output: text,
        tokens: {
          input: u.promptTokenCount ?? 0,
          output: u.candidatesTokenCount ?? 0,
          thinking: u.thoughtsTokenCount ?? 0,
          total: u.totalTokenCount ?? 0,
        },
        ms: Date.now() - started,
      };
      trace.calls.push(entry);
      return parseJson(text);
    } catch (e) {
      lastErr = e;
      trace.notes.push({ kind: "error", text: `Model call failed (${area}) with ${apiKey === keys[0] ? "main" : "backup"} key: ${String(e?.message).slice(0, 200)}` });
    }
  }
  throw lastErr;
}

function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error("Model did not return JSON: " + t.slice(0, 200));
  }
}
