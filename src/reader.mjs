// READING: the only place the raw messages are understood. One model call per run.
// Language in, structured facts out. No arithmetic and no decisions here.
import { call } from "./llm.mjs";

export const READER_SYSTEM = `You extract facts from messages for planning a university hackathon. Messages may be emails, WhatsApp texts or notices, in English or Roman Urdu. Output JSON only.

Return {"messages":[{"id":1,"sender":"...","role":"...","date":"YYYY-MM-DD or null","summary":"max 12 words","facts":[...],"constraints":[...],"ignored":"reason or null"}]}

role: organizer (dean, principal, university admin, event lead), finance, venue, caterer, judging (judging coordinator), judge, student, other.
date: as written in the message; assume year ${new Date().getFullYear()}; null if none.

facts: [{"k":"<key>","v":<value>,"item":"<name or null>"}]. Use ONLY these keys, numbers as plain numbers (Rs 1,200 -> 1200):
event.students, event.team_size, event.teams, event.hours, event.staff, event.start_time ("HH:MM" 24h), event.extra_people (item = who; people who attend and eat, beyond students/staff/judges)
budget.total (whole event budget)
schedule.break (item = name, v = minutes)
venue.option (item = venue name, v = {"capacity":n,"price":n (total) or "price_per_hour":n,"features":["generator",...]})
food.option (item = option name, v = {"price_per_head":n,"default":true if it is the standard/regular/usual option else false})
food.fixed_cost (item = name, v = amount; e.g. delivery fee; 0 if stated free)
food.quantity (v = number of meals/boxes the sender says will be served)
judging.available (v = judges confirmed), judging.fee (v = per judge), judging.minutes_per_team, judging.max_teams_per_judge, judging.judges_per_team
budget.committed (item = what, v = amount already spent/ordered from this budget)
budget.request (item = what, v = amount; something someone asks for, not approved)

constraints: [{"area":"venue|schedule|food|judging|budget","text":"..."}] for binding requirements that do not fit a fact key (e.g. accessibility, dietary needs, timing limits, rules). Do not repeat facts here.

ignored: set a short reason and give no facts if the message is irrelevant to planning (personal notes, chit-chat, a single person running late). A message that only corrects or replaces a figure still gets facts.
Copy figures exactly. Never invent values.`;

export async function readMessages(trace, text) {
  const out = await call(trace, { area: "reading", system: READER_SYSTEM, input: text, maxOutputTokens: 4096 });
  // accept {"messages":[...]}, a bare array, or a single message object
  const msgs = Array.isArray(out?.messages) ? out.messages : Array.isArray(out) ? out : out && typeof out === "object" && (out.facts || out.sender) ? [out] : [];
  return msgs.map((m, i) => ({
    id: m.id ?? i + 1,
    sender: String(m.sender ?? "unknown"),
    role: String(m.role ?? "other"),
    date: m.date || null,
    summary: String(m.summary ?? ""),
    facts: Array.isArray(m.facts) ? m.facts.filter((f) => f && typeof f.k === "string") : [],
    constraints: Array.isArray(m.constraints) ? m.constraints.filter((c) => c && c.area && c.text) : [],
    ignored: m.ignored || null,
  }));
}
