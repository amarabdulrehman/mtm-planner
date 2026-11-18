// SCHEDULE (plain code). Places blocks on a timeline:
// 1. blocks with a fixed clock time (from messages) go exactly where stated,
// 2. opening at the start, results/closing at the end, judging just before closing (unless fixed),
// 3. lunch, breaks and extra blocks in the middle of the largest free gap,
// 4. every minute left over becomes a build session.
export function toMin(hhmm) {
  const m = String(hhmm ?? "").match(/(\d{1,2})[:.](\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const fmt = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const fmtRel = (min) => `+${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

/**
 * @param o.start "HH:MM" | null   @param o.end "HH:MM" | null   @param o.totalMin number | null
 * @param o.fixed [{name, start:"HH:MM", end?:"HH:MM", minutes?:n, source}]
 * @param o.opening/closing/lunch {name, minutes, source}
 * @param o.middle [{name, minutes, source}]  (breaks + extra blocks)
 * @param o.judging {name, minutes, source}
 */
export function buildTimeline(o) {
  const notes = [];
  const fixed = (o.fixed ?? [])
    .map((f) => {
      const s = toMin(f.start);
      const e = toMin(f.end) ?? (s != null ? s + (Number(f.minutes) || 0) : null);
      return s == null ? null : { name: f.name, s, e: Math.max(s, e), source: f.source, fixed: true };
    })
    .filter(Boolean)
    .sort((a, b) => a.s - b.s);

  let S = toMin(o.start);
  let E = toMin(o.end);
  if (S == null && fixed.length) {
    // no start time: assume the event ends when the last fixed block ends (or starts at the first one if that is impossible)
    const lastEnd = Math.max(...fixed.map((f) => f.e));
    const endGiven = E != null ? E : lastEnd;
    S = o.totalMin && endGiven - o.totalMin <= fixed[0].s ? endGiven - o.totalMin : fixed[0].s;
    notes.push(`No start time given: assumed start ${fmt(S)} so that every stated time fits inside the event.`);
  }
  const absolute = S != null;
  if (S == null) S = 0;
  if (E == null && o.totalMin) E = S + o.totalMin;
  if (E == null) return null;
  const total = E - S;
  const show = (m) => (absolute ? fmt(m) : fmtRel(m - S));

  const blocks = [];
  const unplaced = [];
  // free gaps on the timeline, after fixed blocks
  let gaps = [{ s: S, e: E }];
  const cut = (s, e) => {
    gaps = gaps.flatMap((g) => (e <= g.s || s >= g.e ? [g] : [{ s: g.s, e: Math.max(g.s, s) }, { s: Math.min(g.e, e), e: g.e }])).filter((g) => g.e > g.s);
  };
  for (const f of fixed) {
    if (f.s < S || f.e > E) { unplaced.push(`${f.name} (${fmt(f.s)}-${fmt(f.e)} is outside the event)`); continue; }
    blocks.push({ name: f.name, s: f.s, e: f.e, source: f.source, fixed: true });
    cut(f.s, f.e);
  }
  const judgingFixed = blocks.find((b) => /judg/i.test(b.name));
  if (judgingFixed) judgingFixed.isJudging = true;

  const place = (item, where) => {
    if (!item || !item.minutes) return;
    const fits = gaps.filter((g) => g.e - g.s >= item.minutes);
    if (!fits.length) { unplaced.push(`${item.name} (${item.minutes} min)`); return; }
    let g, s;
    if (where === "start") { g = fits[0]; s = g.s; }
    else if (where === "end") { g = fits[fits.length - 1]; s = g.e - item.minutes; }
    else {
      g = fits.reduce((a, b) => (b.e - b.s > a.e - a.s ? b : a));
      s = g.s + Math.round((g.e - g.s - item.minutes) / 2 / 5) * 5;
    }
    blocks.push({ name: item.name, s, e: s + item.minutes, source: item.source, isJudging: item.isJudging });
    cut(s, s + item.minutes);
  };

  // opening/closing are our defaults: only at the very start/end, dropped with a note if a fixed block is there
  const edge = (item, atStart) => {
    if (!item?.minutes) return;
    const g = atStart ? gaps.find((x) => x.s === S) : gaps.find((x) => x.e === E);
    if (g && g.e - g.s >= item.minutes) place(item, atStart ? "start" : "end");
    else notes.push(`${item.name} left out: a fixed-time block is at the ${atStart ? "start" : "end"} of the event.`);
  };
  edge(o.opening, true);
  edge(o.closing, false);
  if (!judgingFixed) place({ ...o.judging, isJudging: true }, "end");
  // lunch + breaks + extra blocks go together in the middle of the largest gap
  const middle = [o.lunch, ...(o.middle ?? [])].filter((b) => b && b.minutes > 0);
  const mid = middle.reduce((t, b) => t + b.minutes, 0);
  if (mid) {
    const fits = gaps.filter((g) => g.e - g.s >= mid);
    if (fits.length) {
      const g = fits.reduce((a, b) => (b.e - b.s > a.e - a.s ? b : a));
      let t = g.s + Math.round((g.e - g.s - mid) / 2 / 5) * 5;
      for (const b of middle) { blocks.push({ name: b.name, s: t, e: t + b.minutes, source: b.source }); t += b.minutes; }
      cut(g.s + Math.round((g.e - g.s - mid) / 2 / 5) * 5, t);
    } else for (const b of middle) place(b, "middle");
  }
  // leftover minutes = build time
  let n = 0;
  for (const g of gaps) {
    if (g.e - g.s >= 20) blocks.push({ name: `Build session ${++n}`, s: g.s, e: g.e, source: "computed", build: true });
    else blocks.push({ name: "Buffer / changeover", s: g.s, e: g.e, source: "computed" });
  }
  blocks.sort((a, b) => a.s - b.s || a.e - b.e);

  const out = blocks.map((b) => ({ name: b.name, minutes: b.e - b.s, start: show(b.s), end: show(b.e), source: b.source, fixed: Boolean(b.fixed), isJudging: Boolean(b.isJudging), build: Boolean(b.build) }));
  const judgingMinutes = blocks.filter((b) => b.isJudging).reduce((t, b) => t + (b.e - b.s), 0);
  return {
    start: absolute ? fmt(S) : null, end: absolute ? fmt(E) : null, totalMinutes: total,
    buildMinutes: blocks.filter((b) => b.build).reduce((t, b) => t + (b.e - b.s), 0),
    judgingMinutes, blocks: out, unplaced, notes,
    overlaps: blocks.some((b, i) => i && b.s < blocks[i - 1].e && blocks[i - 1].e > blocks[i - 1].s && b.e > b.s),
  };
}
