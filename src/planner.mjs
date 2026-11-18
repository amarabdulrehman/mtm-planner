// PLANNER (plain code). Turns facts + area decisions into a plan. All arithmetic lives here,
// so figures are exact and cost zero tokens.
import { get } from "./facts.mjs";

// Planning defaults: our own choices, not facts from any message. Shown as assumptions in the plan.
export const DEFAULTS = { openingMin: 15, lunchMin: 30, closingMin: 15, judgesPerTeam: 1 };

const num = (e) => (e && Number.isFinite(Number(e.v)) ? Number(e.v) : null);
const src = (e) => (e ? `#${e.msgId} ${e.sender}` : "default");

/**
 * decisions: per-area results from area model calls (only when a message has a constraint
 * that the code cannot express). Shape per area documented in resolvers.mjs.
 */
export function buildPlan(store, decisions = {}) {
  const assumptions = [];
  const sources = {};
  const d = { venue: decisions.venue ?? {}, food: decisions.food ?? {}, schedule: decisions.schedule ?? {}, judging: decisions.judging ?? {}, budget: decisions.budget ?? {} };

  // ---- event figures
  const studentsE = get(store, "event.students");
  const teamSizeE = get(store, "event.team_size");
  const teamsE = get(store, "event.teams");
  const hoursE = get(store, "event.hours");
  const staffE = get(store, "event.staff");
  const students = num(studentsE);
  const teamSize = num(teamSizeE);
  const teams = num(teamsE) ?? (students && teamSize ? Math.ceil(students / teamSize) : null);
  const hours = num(hoursE);
  const staff = num(staffE) ?? 0;
  if (!staffE) assumptions.push("No staff count given: assumed 0 staff.");
  const extras = get(store, "event.extra_people").map((e) => ({ who: e.item, n: Number(e.v) || 0, source: src(e) }));
  for (const area of Object.keys(d)) for (const p of d[area].add_people ?? []) extras.push({ who: p.who, n: Number(p.n) || 0, source: "constraint" });
  sources.students = src(studentsE); sources.teams = teamsE ? src(teamsE) : `${src(studentsE)} / ${src(teamSizeE)}`;
  sources.hours = src(hoursE); sources.staff = src(staffE);

  // ---- judging
  const fee = num(get(store, "judging.fee")) ?? 0;
  const minPerTeam = num(get(store, "judging.minutes_per_team"));
  const maxPerJudge = d.judging.max_teams_per_judge ?? num(get(store, "judging.max_teams_per_judge"));
  const perTeam = d.judging.judges_per_team ?? num(get(store, "judging.judges_per_team")) ?? DEFAULTS.judgesPerTeam;
  if (!get(store, "judging.judges_per_team") && !d.judging.judges_per_team) assumptions.push("Each team is judged by 1 judge (no message asks for more).");
  const available = num(get(store, "judging.available"));
  const judgesNeeded = teams && maxPerJudge ? Math.ceil((teams * perTeam) / maxPerJudge) : null;
  const teamsPerJudge = judgesNeeded ? Math.ceil((teams * perTeam) / judgesNeeded) : null;
  const judgingMinutes = teamsPerJudge && minPerTeam ? teamsPerJudge * minPerTeam : null;
  const judging = {
    teams, judgesPerTeam: perTeam, maxTeamsPerJudge: maxPerJudge, minutesPerTeam: minPerTeam,
    judgesAvailable: available, judgesNeeded, teamsPerJudge, judgingMinutes, feePerJudge: fee,
    feeTotal: judgesNeeded ? judgesNeeded * fee : null,
    notes: d.judging.notes ?? [],
  };

  // ---- headcount (everyone who attends and eats)
  const extraPeople = extras.reduce((s, x) => s + x.n, 0);
  const headcount = students != null && judgesNeeded != null ? students + staff + judgesNeeded + extraPeople : null;

  // ---- costs already committed + area-added costs
  const committed = get(store, "budget.committed").map((e) => ({ item: e.item, amount: Number(e.v) || 0, source: src(e) }));
  const addedCosts = [...(d.budget.add_costs ?? []), ...(d.venue.add_costs ?? []), ...(d.food.add_costs ?? []), ...(d.schedule.add_costs ?? []), ...(d.judging.add_costs ?? [])]
    .map((c) => ({ item: c.item, amount: Number(c.amount) || 0, source: "constraint" }));
  const budgetTotal = num(get(store, "budget.total"));
  const reserve = (Number(d.budget.reserve) || 0) + (budgetTotal && Number(d.budget.reserve_percent) ? Math.ceil((budgetTotal * Number(d.budget.reserve_percent)) / 100) : 0);
  sources.budget = src(get(store, "budget.total"));

  // ---- food options
  const foodFixed = get(store, "food.fixed_cost").map((e) => ({ item: e.item, amount: Number(e.v) || 0, source: src(e) }));
  const foodExtraPerHead = Number(d.food.extra_per_head) || 0;
  const excludedFood = new Set((d.food.exclude ?? []).map((s) => String(s).toLowerCase()));
  const foods = get(store, "food.option")
    .map((e) => ({ name: e.item, pricePerHead: Number(e.v?.price_per_head ?? e.v) || 0, isDefault: Boolean(e.v?.default), source: src(e) }))
    .filter((f) => !excludedFood.has(String(f.name).toLowerCase()));
  // Preference: the standard/default option first, then cheaper ones (used only if the budget forces it).
  const foodPref = [...foods.filter((f) => f.isDefault), ...foods.filter((f) => !f.isDefault).sort((a, b) => b.pricePerHead - a.pricePerHead)];
  const qtyE = get(store, "food.quantity");
  const minQty = (headcount ?? 0) + Math.max(0, Number(d.food.extra_meals) || 0);
  const quantity = Math.max(minQty, num(qtyE) ?? 0);

  // ---- venue options
  const excludedVenue = new Set((d.venue.exclude ?? []).map((s) => String(s).toLowerCase()));
  const needFeatures = (d.venue.require_features ?? []).map((s) => String(s).toLowerCase());
  const venues = get(store, "venue.option").map((e) => ({
    name: e.item, capacity: Number(e.v?.capacity) || 0,
    // a venue may quote per hour: cost = rate x event hours
    price: Number(e.v?.price) || (Number(e.v?.price_per_hour) && hours ? Number(e.v.price_per_hour) * hours : 0),
    features: (e.v?.features ?? []).map((x) => String(x).toLowerCase()), source: src(e),
  }));
  const fits = (v) =>
    headcount != null && v.capacity >= headcount && !excludedVenue.has(v.name.toLowerCase()) &&
    needFeatures.every((f) => v.features.some((x) => x.includes(f) || f.includes(x)));
  const feasibleVenues = venues.filter(fits).sort((a, b) => a.price - b.price);

  // ---- choose the cheapest venue that fits, with the preferred food that keeps us in budget
  const fixedSpend = committed.reduce((s, c) => s + c.amount, 0) + addedCosts.reduce((s, c) => s + c.amount, 0) + (judging.feeTotal ?? 0) + reserve;
  const foodFixedSum = foodFixed.reduce((s, c) => s + c.amount, 0);
  let choice = null;
  for (const food of foodPref) {
    for (const v of feasibleVenues) {
      const foodCost = quantity * (food.pricePerHead + foodExtraPerHead) + foodFixedSum;
      const total = fixedSpend + v.price + foodCost;
      if (budgetTotal == null || total <= budgetTotal) { choice = { venue: v, food, foodCost, total }; break; }
    }
    if (choice) break;
  }
  if (!choice && feasibleVenues.length && foodPref.length) {
    // nothing fits the budget: show the cheapest combination so the validator can explain why
    const food = [...foodPref].sort((a, b) => a.pricePerHead - b.pricePerHead)[0];
    const v = feasibleVenues[0];
    const foodCost = quantity * (food.pricePerHead + foodExtraPerHead) + foodFixedSum;
    choice = { venue: v, food, foodCost, total: fixedSpend + v.price + foodCost, overBudget: true };
  }
  if (choice && foods.length > 1 && !choice.food.isDefault) assumptions.push(`Chose ${choice.food.name} food because the standard option does not fit the budget.`);

  // ---- schedule
  const totalMin = hours ? Math.round(hours * 60) : null;
  const breaks = get(store, "schedule.break").map((e) => ({ name: e.item || "Break", minutes: Number(e.v) || 0, source: src(e) }));
  // a constraint block that repeats an existing break (e.g. "Prayer break" twice) is dropped
  const words = (s) => String(s).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && w !== "break");
  const extraBlocks = (d.schedule.add_blocks ?? [])
    .map((b) => ({ name: b.name, minutes: Number(b.minutes) || 0, source: "constraint" }))
    .filter((b) => b.minutes > 0 && !breaks.some((x) => words(x.name).some((w) => words(b.name).includes(w)) || x.name.toLowerCase() === String(b.name).toLowerCase()));
  let schedule = null;
  if (totalMin && judgingMinutes) {
    const fixed = [
      { name: "Opening & challenge brief", minutes: DEFAULTS.openingMin, source: "default" },
      { name: "Lunch (boxes served)", minutes: DEFAULTS.lunchMin, source: "default" },
      ...breaks, ...extraBlocks,
      { name: `Judging (${teamsPerJudge} teams per judge x ${minPerTeam} min)`, minutes: judgingMinutes, source: "computed" },
      { name: "Results & closing", minutes: DEFAULTS.closingMin, source: "default" },
    ];
    const used = fixed.reduce((s, b) => s + b.minutes, 0);
    const build = totalMin - used;
    const b1 = Math.round(build / 2 / 5) * 5;
    const blocks = [
      fixed[0],
      { name: "Build session 1", minutes: b1, source: "computed" },
      fixed[1],
      ...breaks, ...extraBlocks,
      { name: "Build session 2", minutes: build - b1, source: "computed" },
      fixed[fixed.length - 2], fixed[fixed.length - 1],
    ];
    const start = d.schedule.start_time || get(store, "event.start_time")?.v || null;
    let t = start ? toMin(start) : 0;
    for (const b of blocks) { b.start = start ? fmt(t) : `+${fmtRel(t)}`; t += b.minutes; b.end = start ? fmt(t) : `+${fmtRel(t)}`; }
    schedule = { start, totalMinutes: totalMin, buildMinutes: build, blocks, notes: d.schedule.notes ?? [] };
    assumptions.push(`Opening ${DEFAULTS.openingMin} min, lunch ${DEFAULTS.lunchMin} min and closing ${DEFAULTS.closingMin} min are our planning defaults.`);
  }

  // ---- budget lines
  const lines = [];
  if (choice) {
    lines.push({ item: `Venue: ${choice.venue.name}`, amount: choice.venue.price, source: choice.venue.source });
    lines.push({ item: `Food: ${quantity} x ${choice.food.name} @ Rs ${choice.food.pricePerHead + foodExtraPerHead}`, amount: quantity * (choice.food.pricePerHead + foodExtraPerHead), source: choice.food.source });
    for (const f of foodFixed) lines.push({ item: `Food: ${f.item}`, amount: f.amount, source: f.source });
  }
  if (judging.feeTotal != null) lines.push({ item: `Judges: ${judgesNeeded} x Rs ${fee}`, amount: judging.feeTotal, source: "computed" });
  for (const c of committed) lines.push({ item: `Already ordered: ${c.item}`, amount: c.amount, source: c.source });
  for (const c of addedCosts) lines.push(c);
  if (reserve) lines.push({ item: "Reserve (constraint)", amount: reserve, source: "constraint" });
  const spent = lines.reduce((s, l) => s + l.amount, 0);
  const requests = get(store, "budget.request").map((e) => ({
    item: e.item, amount: Number(e.v) || 0, source: src(e),
    affordable: budgetTotal != null && spent + (Number(e.v) || 0) <= budgetTotal,
  }));

  return {
    event: { students, teamSize, teams, hours, staff, extras, headcount, sources },
    venue: choice ? { ...choice.venue, headcount, options: venues.length, feasible: feasibleVenues.map((v) => v.name), requiredFeatures: needFeatures, notes: d.venue.notes ?? [] } : null,
    food: choice ? { option: choice.food.name, pricePerHead: choice.food.pricePerHead + foodExtraPerHead, quantity, fixed: foodFixed, cost: choice.foodCost, notes: d.food.notes ?? [] } : null,
    judging,
    schedule,
    budget: { total: budgetTotal, lines, spent, remaining: budgetTotal != null ? budgetTotal - spent : null, requests, notes: d.budget.notes ?? [] },
    assumptions,
  };
}

function toMin(hhmm) {
  const m = String(hhmm).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
function fmt(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function fmtRel(min) {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}
