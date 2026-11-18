// AREA DECISIONS. A model call for an area happens ONLY when a message carries a constraint
// for that area that the fixed fact keys cannot express (e.g. "venue must be wheelchair accessible").
// The model returns a small set of allowed operations; code applies them and re-validates.
// Results are cached per area: an area is re-asked only when its own constraints change.
import { createHash } from "node:crypto";
import { call } from "./llm.mjs";

const OPS = {
  venue: `{"exclude":["names of every venue that does not meet the constraint"],"require_features":["only feature words already listed for venues in the context"],"add_costs":[{"item":"...","amount":n}],"notes":["..."]}`,
  food: `{"special_meals":[{"name":"vegetarian","count":n}] (part of the same total, not extra),"exclude":["food option names not allowed"],"extra_per_head":n,"extra_meals":n,"add_costs":[{"item":"...","amount":n}],"notes":["..."]}`,
  schedule: `{"start_time":"HH:MM or null","add_blocks":[{"name":"...","minutes":n,"start":"HH:MM when the constraint names a clock time (e.g. hall must be empty 10:30-10:45 -> {name:'Hall empty (no activities)',start:'10:30',minutes:15})"}],"notes":["..."]}
Never add build, judging, opening, lunch or closing blocks: the planner makes those.`,
  judging: `{"judges_per_team":n or null,"max_teams_per_judge":n or null,"add_costs":[{"item":"...","amount":n}],"notes":["..."]}`,
  budget: `{"reserve":n,"reserve_percent":n,"add_costs":[{"item":"...","amount":n}],"notes":["..."]}`,
};

const COMMON = `Any area may also use "add_people":[{"who":"...","n":n}] for extra people on site who need seats and meals.`;
const SYSTEM = (area) => `You turn hackathon planning constraints for the ${area.toUpperCase()} area into operations. Output JSON only, exactly this shape (omit fields you do not need):
${OPS[area]}
${COMMON}
Use only figures stated in the constraints or the context. If a constraint is not binding or is already satisfied, return {"notes":["why"]}. Keep notes short.`;

export function constraintKey(list) {
  return createHash("sha1").update(JSON.stringify(list.map((c) => c.text))).digest("hex").slice(0, 12);
}

/**
 * For each area whose constraint list changed since last time, make ONE model call.
 * cache: { [area]: { key, ops } }  (persisted in state)
 * context: compact per-area context the model may need (option names, features).
 */
export async function resolveAreas(trace, store, cache, context) {
  const areas = ["venue", "schedule", "food", "judging", "budget"];
  const decisions = {};
  const called = [];
  for (const area of areas) {
    const list = store.constraints.filter((c) => c.area === area);
    if (!list.length) { delete cache[area]; continue; }
    const key = constraintKey(list);
    if (cache[area]?.key !== key) {
      const input = JSON.stringify({ constraints: list.map((c) => `${c.text} (from ${c.sender})`), context: context[area] ?? {} });
      try {
        const ops = await call(trace, { area, system: SYSTEM(area), input, maxOutputTokens: 512 });
        cache[area] = { key, ops: ops && typeof ops === "object" ? ops : {} };
        called.push(area);
      } catch (e) {
        trace.notes.push({ kind: "error", text: `${area}: constraint not applied (${e.message}); kept previous decision` });
        if (!cache[area]) continue;
      }
    }
    decisions[area] = cache[area].ops;
  }
  return { decisions, called };
}
