// VALIDATOR (plain code). The six judging checks, plus meals >= people.
// A plan is only accepted if every check passes.
export function validate(plan) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const e = plan.event;

  const missing = [];
  if (e.students == null) missing.push("students");
  if (e.teams == null) missing.push("teams / team size");
  if (e.hours == null) missing.push("event length");
  if (plan.budget.total == null) missing.push("budget");
  if (plan.judging.maxTeamsPerJudge == null) missing.push("teams per judge");
  if (plan.judging.minutesPerTeam == null) missing.push("judging minutes per team");
  add("Figures complete", !missing.length, missing.length ? `missing: ${missing.join(", ")}` : `${e.students} students, ${e.teams} teams, ${e.headcount} people, ${e.hours} h`);

  add("Within budget", plan.budget.total != null && plan.budget.spent <= plan.budget.total,
    `spend Rs ${fmt(plan.budget.spent)} of Rs ${fmt(plan.budget.total)}`);

  add("Venue fits", plan.venue && plan.venue.capacity >= e.headcount,
    plan.venue ? `${plan.venue.name}: ${plan.venue.capacity} seats for ${e.headcount} people${plan.venue.requiredFeatures.length ? `, needs ${plan.venue.requiredFeatures.join(", ")}` : ""}` : "no venue fits the headcount and requirements");

  const s = plan.schedule;
  const sum = s ? s.blocks.reduce((t, b) => t + b.minutes, 0) : 0;
  const judgingBlock = s?.blocks.find((b) => b.name.startsWith("Judging"));
  const schedOk = s && sum === s.totalMinutes && s.buildMinutes > 0 && judgingBlock && judgingBlock.minutes >= plan.judging.judgingMinutes && s.blocks.every((b) => b.minutes >= 0);
  add("Schedule valid", schedOk, s ? `${sum}/${s.totalMinutes} min, build ${s.buildMinutes} min, judging ${judgingBlock?.minutes} min` : "no schedule");

  const j = plan.judging;
  add("Enough judges", j.judgesNeeded != null && j.judgesAvailable != null && j.judgesAvailable >= j.judgesNeeded,
    `${j.judgesNeeded} needed (${j.teams} teams x ${j.judgesPerTeam} / ${j.maxTeamsPerJudge} per judge), ${j.judgesAvailable} available`);

  add("Meals cover everyone", plan.food && plan.food.quantity >= e.headcount,
    plan.food ? `${plan.food.quantity} meals for ${e.headcount} people` : "no food option");

  add("All areas covered", plan.venue && plan.schedule && plan.food && plan.judging.judgesNeeded && plan.budget.lines.length,
    ["venue", "schedule", "food", "judging", "budget"].filter((a) => (a === "judging" ? !plan.judging.judgesNeeded : a === "budget" ? !plan.budget.lines.length : !plan[a])).map((a) => `missing ${a}`).join(", ") || "venue, schedule, food, judging, budget");

  return { ok: checks.every((c) => c.ok), checks };
}

const fmt = (n) => (n == null ? "?" : Number(n).toLocaleString("en-US"));
