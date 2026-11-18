// FACT STORE (plain code). Merges facts from read messages.
// Rules: (1) only a sender with authority over a figure can set it,
// (2) for the same figure, the newest message wins, (3) older messages are kept as history.

// Who may set which figure. Requests (budget.request) can come from anyone.
const AUTHORITY = [
  ["event.", ["organizer"]],
  ["budget.total", ["organizer"]],
  ["schedule.fixed", ["organizer", "judging"]],
  ["schedule.", ["organizer"]],
  ["venue.", ["venue", "organizer"]],
  ["food.option", ["caterer", "organizer"]],
  ["food.fixed_cost", ["caterer", "organizer"]],
  ["food.quantity", ["organizer"]], // number of meals follows headcount; a caterer cannot cut it
  ["judging.", ["judging", "organizer"]],
  ["budget.committed", ["finance", "organizer"]],
  ["budget.request", null],
];

// Keys that hold one value per named item (e.g. one price per venue).
const ITEM_KEYS = new Set([
  "venue.option", "food.option", "food.fixed_cost", "budget.committed",
  "budget.request", "schedule.break", "schedule.fixed", "event.extra_people",
]);

export const KNOWN_KEYS = new Set([
  "event.students", "event.team_size", "event.teams", "event.hours", "event.staff", "event.start_time", "event.end_time", "schedule.fixed",
  "event.extra_people", "budget.total", "schedule.break", "venue.option", "food.option", "food.fixed_cost",
  "food.quantity", "judging.available", "judging.fee", "judging.minutes_per_team",
  "judging.max_teams_per_judge", "judging.judges_per_team", "budget.committed", "budget.request",
]);

export function allowedRoles(key) {
  for (const [prefix, roles] of AUTHORITY) if (key === prefix || key.startsWith(prefix)) return roles;
  return ["organizer"];
}

const FILLER = new Set(["bill", "cost", "costs", "fee", "fees", "charges", "charge", "the", "for", "of", "order", "amount", "rs", "box", "boxes"]);
export function normItem(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(" ");
}
function sameItem(a, b) {
  const x = normItem(a), y = normItem(b);
  if (!x || !y) return x === y;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
}

export function emptyStore() {
  return { entries: [], constraints: [], seq: 0 };
}

function dateRank(d) {
  const t = d ? Date.parse(d) : NaN;
  return Number.isNaN(t) ? Infinity : t; // undated messages count as newest (arrival order breaks ties)
}

/**
 * Apply one message's facts to the store (mutates). Returns notes for the trace:
 * {accepted:[], rejected:[{fact, reason}], superseded:[], outdated:[]}
 */
// Counts that a message may give in groups ("12 volunteers and 3 organisers"): add them up.
const SUMMED = new Set(["event.staff"]);

// Money figures (rupees). A value below Rs 50 has no believable unit ("printing is now 6") and is not applied.
const MONEY = new Set(["budget.total", "food.fixed_cost", "judging.fee", "budget.committed", "budget.request"]);
const COUNTS = new Set(["event.students", "event.team_size", "event.teams", "event.hours", "event.staff", "event.extra_people",
  "judging.available", "judging.minutes_per_team", "judging.max_teams_per_judge", "judging.judges_per_team", "food.quantity", "schedule.break"]);

function badNumber(f) {
  const nums = [];
  if (MONEY.has(f.k) || COUNTS.has(f.k)) nums.push(["value", f.v]);
  if (f.k === "venue.option") nums.push(["capacity", f.v?.capacity], ["price", f.v?.price ?? f.v?.price_per_hour]);
  if (f.k === "food.option") nums.push(["price per head", f.v?.price_per_head]);
  for (const [label, raw] of nums) {
    if (raw == null) continue;
    // a percentage fee (e.g. "10%" service charge) is allowed for food costs; it is applied to the food bill
    if (f.k === "food.fixed_cost" && /^\s*\d+(\.\d+)?\s*%\s*$/.test(String(raw))) { const p = parseFloat(raw); if (p > 100) return `percentage ${p}% is not believable`; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${label} "${raw}" is not a number`;
    if (n < 0) return `${label} ${n} is negative`;
    if ((MONEY.has(f.k) || label === "price" || label === "price per head") && n > 0 && n < 50)
      return `amount ${n} has no clear unit (rupees? thousands?); previous figure kept until clarified`;
  }
  return null;
}

export function applyMessage(store, msg) {
  const res = { accepted: [], rejected: [], superseded: [], outdated: [], conflicts: [] };
  const seq = ++store.seq;
  const facts = [];
  for (const f of msg.facts) {
    const prev = SUMMED.has(f.k) && facts.find((x) => x.k === f.k);
    if (prev && Number.isFinite(Number(f.v))) {
      prev.v = Number(prev.v) + Number(f.v);
      prev.item = [prev.item, f.item].filter(Boolean).join(" + ") || null;
    } else facts.push({ ...f });
  }
  for (const f of facts) {
    const bad = badNumber(f);
    if (bad) { res.rejected.push({ fact: f, reason: bad }); continue; }
    if (!KNOWN_KEYS.has(f.k)) {
      res.rejected.push({ fact: f, reason: `unknown figure "${f.k}"` });
      continue;
    }
    const roles = allowedRoles(f.k);
    if (roles && !roles.includes(msg.role)) {
      res.rejected.push({ fact: f, reason: `${msg.sender} (${msg.role}) has no authority to set ${f.k}; only ${roles.join("/")} can` });
      continue;
    }
    const entry = { k: f.k, item: f.item ?? null, v: f.v, msgId: msg.id, sender: msg.sender, date: msg.date, seq, active: true };
    const current = store.entries.find(
      (e) => e.active && e.k === f.k && (!ITEM_KEYS.has(f.k) || sameItem(e.item, entry.item)),
    );
    // "eight additional staff": an increment on the current figure
    if (f.op === "add" && Number.isFinite(Number(f.v))) {
      const base = current ? Number(current.v) || 0 : 0;
      entry.v = base + Number(f.v);
      entry.note = `${base} + ${Number(f.v)}`;
    }
    if (current) {
      const newer = dateRank(entry.date) > dateRank(current.date) || (dateRank(entry.date) === dateRank(current.date) && seq > current.seq);
      if (!newer) {
        entry.active = false;
        res.outdated.push({ fact: f, reason: `message dated ${entry.date} is older than ${current.sender} (${current.date}); kept ${JSON.stringify(current.v)}` });
        store.entries.push(entry);
        continue;
      }
      current.active = false;
      res.superseded.push({ old: current, now: entry });
      // same date, same kind of sender, different value: we use the later one but say so
      if (entry.date && current.date && dateRank(entry.date) === dateRank(current.date) && current.msgId !== entry.msgId && JSON.stringify(current.v) !== JSON.stringify(entry.v) && f.op !== "add")
        res.conflicts.push({ old: current, now: entry });
    }
    store.entries.push(entry);
    res.accepted.push(entry);
  }
  for (const c of msg.constraints) {
    store.constraints.push({ area: c.area, text: c.text, msgId: msg.id, sender: msg.sender, role: msg.role });
  }
  return res;
}

/** Active value(s) for a key. */
export function get(store, key) {
  const list = store.entries.filter((e) => e.active && e.k === key);
  return ITEM_KEYS.has(key) ? list : list[list.length - 1];
}
