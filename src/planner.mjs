// PLANNER (plain code). Turns facts + area decisions into a plan. All arithmetic lives here,
// so figures are exact and cost zero tokens.
import { get } from "./facts.mjs";
import { buildTimeline, toMin } from "./schedule.mjs";

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
  // event length: stated hours, or derived from a stated start and end time (09:00-13:00 = 4 h)
  const st = toMin(get(store, "event.start_time")?.v), en = toMin(get(store, "event.end_time")?.v);
  const hours = num(hoursE) ?? (st != null && en != null && en > st ? (en - st) / 60 : null);
  if (!teamsE && students && teamSize && students % teamSize)
    assumptions.push(`CONFLICT: ${students} students do not divide into teams of ${teamSize}. Planned as ${Math.floor(students / teamSize)} full teams + 1 team of ${students % teamSize} (${Math.ceil(students / teamSize)} teams); all ${students} students are counted. Needs organiser approval.`);
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
  // a fixed judging window limits how many 15-min slots each judge can do
  const fixedJudging = get(store, "schedule.fixed").find((e) => /judg|review/i.test(String(e.item)));
  const windowMin = fixedJudging ? (toMin(fixedJudging.v?.end) ?? (toMin(fixedJudging.v?.start) + (Number(fixedJudging.v?.minutes) || 0))) - toMin(fixedJudging.v?.start) : null;
  const slotCap = windowMin != null && minPerTeam ? Math.floor(windowMin / minPerTeam) : null;
  const effMax = maxPerJudge != null ? (slotCap != null ? Math.min(maxPerJudge, slotCap) : maxPerJudge) : null;
  if (slotCap != null && maxPerJudge != null && slotCap < maxPerJudge) assumptions.push(`The ${windowMin}-min judging window fits only ${slotCap} slot(s) of ${minPerTeam} min per judge (instead of ${maxPerJudge}).`);
  const judgesNeeded = teams && effMax ? Math.ceil((teams * perTeam) / effMax) : teams && effMax === 0 ? Infinity : null;
  const teamsPerJudge = judgesNeeded && Number.isFinite(judgesNeeded) ? Math.ceil((teams * perTeam) / judgesNeeded) : null;
  const judgingMinutes = teamsPerJudge && minPerTeam ? teamsPerJudge * minPerTeam : null;
  // explicit assignment: judge -> teams -> time offsets (one uninterrupted slot per team, no double-booking)
  let assignments = null;
  if (judgesNeeded && Number.isFinite(judgesNeeded) && teamsPerJudge && minPerTeam && perTeam === 1) {
    assignments = [];
    let t = 1;
    for (let j = 1; j <= judgesNeeded && t <= teams; j++) {
      const list = [];
      for (let k = 0; k < teamsPerJudge && t <= teams; k++, t++) list.push({ team: t, offset: k * minPerTeam });
      assignments.push({ judge: j, teams: list });
    }
  }
  // only judges who exist can be on site and paid; a shortfall is reported by the validator
  const judgesOnSite = judgesNeeded != null && Number.isFinite(judgesNeeded) ? (available != null ? Math.min(judgesNeeded, available) : judgesNeeded) : available;
  const coverable = available != null && effMax != null ? Math.min(teams ?? 0, Math.floor((available * effMax) / (perTeam || 1))) : null;
  const judging = {
    teams, judgesPerTeam: perTeam, maxTeamsPerJudge: effMax, statedMaxTeamsPerJudge: maxPerJudge, windowMinutes: windowMin, coverableTeams: coverable, assignments, minutesPerTeam: minPerTeam,
    judgesAvailable: available, judgesNeeded, teamsPerJudge, judgingMinutes, feePerJudge: fee,
    judgesOnSite, feeTotal: judgesOnSite != null ? judgesOnSite * fee : null,
    notes: d.judging.notes ?? [],
  };

  // ---- headcount (everyone who attends and eats)
  const extraPeople = extras.reduce((s, x) => s + x.n, 0);
  const headcount = students != null && judgesOnSite != null ? students + staff + judgesOnSite + extraPeople : null;

  // ---- costs already committed + area-added costs
  const committed = get(store, "budget.committed").map((e) => ({ item: e.item, amount: Number(e.v) || 0, source: src(e) }));
  const addedCosts = [...(d.budget.add_costs ?? []), ...(d.venue.add_costs ?? []), ...(d.food.add_costs ?? []), ...(d.schedule.add_costs ?? []), ...(d.judging.add_costs ?? [])]
    .map((c) => ({ item: c.item, amount: Number(c.amount) || 0, source: "constraint" }));
  const budgetTotal = num(get(store, "budget.total"));
  const reserve = (Number(d.budget.reserve) || 0) + (budgetTotal && Number(d.budget.reserve_percent) ? Math.ceil((budgetTotal * Number(d.budget.reserve_percent)) / 100) : 0);
  sources.budget = src(get(store, "budget.total"));

  // ---- food options
  const pctOf = (v) => { const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(String(v ?? "")); return m ? Number(m[1]) : null; };
  // a fixed food cost is a flat amount, or a percentage of the food bill (e.g. a service charge)
  const foodFixed = get(store, "food.fixed_cost").map((e) => ({ item: e.item, amount: pctOf(e.v) == null ? Number(e.v) || 0 : 0, percent: pctOf(e.v), source: src(e) }));
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
  const listed = get(store, "venue.option").flatMap((e) => (e.v?.features ?? []).map((x) => String(x).toLowerCase()));
  const needFeatures = (d.venue.require_features ?? []).map((s) => String(s).toLowerCase())
    .filter((f) => listed.some((x) => x.includes(f) || f.includes(x)));
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
  const foodPct = foodFixed.reduce((s, c) => s + (c.percent ?? 0), 0);
  const withPct = (base) => base + Math.round((base * foodPct) / 100);
  let choice = null;
  for (const food of foodPref) {
    for (const v of feasibleVenues) {
      const foodCost = withPct(quantity * (food.pricePerHead + foodExtraPerHead)) + foodFixedSum;
      const total = fixedSpend + v.price + foodCost;
      if (budgetTotal == null || total <= budgetTotal) { choice = { venue: v, food, foodCost, total }; break; }
    }
    if (choice) break;
  }
  if (!choice && feasibleVenues.length && foodPref.length) {
    // nothing fits the budget: show the cheapest combination so the validator can explain why
    const food = [...foodPref].sort((a, b) => a.pricePerHead - b.pricePerHead)[0];
    const v = feasibleVenues[0];
    const foodCost = withPct(quantity * (food.pricePerHead + foodExtraPerHead)) + foodFixedSum;
    choice = { venue: v, food, foodCost, total: fixedSpend + v.price + foodCost, overBudget: true };
  }
  if (choice && foods.length > 1 && !choice.food.isDefault) assumptions.push(`Chose ${choice.food.name} food because the standard option does not fit the budget.`);

  // ---- schedule (timeline: fixed clock times first, then defaults, then build time fills the gaps)
  const totalMin = hours ? Math.round(hours * 60) : null;
  // a break that also has a fixed clock time is placed as a fixed block, never twice
  const fixedFacts = get(store, "schedule.fixed");
  const sameName = (a, b) => { const w = (x) => String(x).toLowerCase().split(/[^a-z]+/).filter((y) => y.length > 3 && y !== "break"); return w(a).some((x) => w(b).includes(x)); };
  const breakFacts = get(store, "schedule.break");
  const breaksTimed = breakFacts.filter((e) => e.v && typeof e.v === "object" && e.v.start);
  const breaks = breakFacts
    .filter((e) => !(e.v && typeof e.v === "object") && !fixedFacts.some((f) => sameName(f.item, e.item)))
    .map((e) => ({ name: e.item || "Break", minutes: Number(e.v) || 0, source: src(e) }));
  // a constraint block that repeats an existing break (e.g. "Prayer break" twice) is dropped
  const words = (s) => String(s).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && w !== "break");
  const STANDARD = /build|judg|opening|closing|lunch|results/i; // blocks the planner already makes
  const extraBlocks = (d.schedule.add_blocks ?? []).filter((b) => b.start || !STANDARD.test(String(b.name)))
    .map((b) => ({ name: b.name, minutes: Number(b.minutes) || 0, start: b.start, source: "constraint" }))
    .filter((b) => b.minutes > 0 && !breaks.some((x) => words(x.name).some((w) => words(b.name).includes(w)) || x.name.toLowerCase() === String(b.name).toLowerCase()));
  const fixedTimes = [
    ...[...fixedFacts, ...breaksTimed].map((e) => ({ name: e.item || "Fixed block", start: e.v?.start, end: e.v?.end, minutes: e.v?.minutes, source: src(e) })),
    ...extraBlocks.filter((b) => b.start).map((b) => ({ ...b })),
  ];
  let schedule = null;
  if ((totalMin || get(store, "event.end_time")) && judgingMinutes) {
    const tl = buildTimeline({
      start: d.schedule.start_time || get(store, "event.start_time")?.v || null,
      end: get(store, "event.end_time")?.v || null,
      totalMin,
      fixed: fixedTimes,
      opening: { name: "Opening & challenge brief", minutes: DEFAULTS.openingMin, source: "default" },
      closing: { name: "Results & closing", minutes: DEFAULTS.closingMin, source: "default" },
      lunch: { name: "Lunch (boxes served)", minutes: DEFAULTS.lunchMin, source: "default" },
      middle: [...breaks, ...extraBlocks.filter((b) => !b.start)],
      judging: { name: `Judging (${teamsPerJudge} teams per judge x ${minPerTeam} min)`, minutes: judgingMinutes, source: "computed" },
    });
    if (tl) {
      schedule = { ...tl, requiredJudging: judgingMinutes, requiredBreaks: breaks.map((b) => b.name), notes: [...tl.notes, ...(d.schedule.notes ?? [])] };
      assumptions.push(`Opening ${DEFAULTS.openingMin} min, lunch ${DEFAULTS.lunchMin} min and closing ${DEFAULTS.closingMin} min are our planning defaults.`);
    }
  }

  // ---- budget lines
  const lines = [];
  if (choice) {
    lines.push({ item: `Venue: ${choice.venue.name}`, amount: choice.venue.price, source: choice.venue.source });
    lines.push({ item: `Food: ${quantity} x ${choice.food.name} @ Rs ${choice.food.pricePerHead + foodExtraPerHead}`, amount: quantity * (choice.food.pricePerHead + foodExtraPerHead), source: choice.food.source });
    for (const f of foodFixed) {
      if (f.percent != null) f.amount = Math.round((quantity * (choice.food.pricePerHead + foodExtraPerHead) * f.percent) / 100);
      lines.push({ item: `Food: ${f.item}${f.percent != null ? ` (${f.percent}% of food)` : ""}`, amount: f.amount, source: f.source });
    }
  }
  if (judging.feeTotal != null) lines.push({ item: `Judges: ${judgesOnSite} x Rs ${fee}`, amount: judging.feeTotal, source: "computed" });
  for (const c of committed) lines.push({ item: `Already ordered: ${c.item}`, amount: c.amount, source: c.source });
  for (const c of addedCosts) lines.push(c);
  if (reserve) lines.push({ item: "Reserve (constraint)", amount: reserve, source: "constraint" });
  const spent = lines.reduce((s, l) => s + l.amount, 0);
  const requests = get(store, "budget.request").map((e) => ({
    item: e.item, amount: Number(e.v) || 0, source: src(e),
    affordable: budgetTotal != null && spent + (Number(e.v) || 0) <= budgetTotal,
  }));

  const specialMeals = (d.food.special_meals ?? []).map((x) => ({ name: x.name, count: Number(x.count) || 0 })).filter((x) => x.count > 0);
  // disclosed conflicts between equally authoritative messages
  for (const c of store.conflicts ?? []) assumptions.push(`CONFLICT: ${c}`);
  return {
    event: { students, teamSize, teams, hours, staff, extras, headcount, sources },
    venue: choice ? { ...choice.venue, headcount, options: venues.length, feasible: feasibleVenues.map((v) => v.name), requiredFeatures: needFeatures, notes: d.venue.notes ?? [] } : null,
    food: choice ? { option: choice.food.name, pricePerHead: choice.food.pricePerHead + foodExtraPerHead, quantity, fixed: foodFixed, cost: choice.foodCost, special: specialMeals, notes: d.food.notes ?? [] } : null,
    judging,
    schedule,
    budget: { total: budgetTotal, lines, spent, remaining: budgetTotal != null ? budgetTotal - spent : null, requests, notes: d.budget.notes ?? [] },
    assumptions,
  };
}
