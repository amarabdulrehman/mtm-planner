// OUTBOX (plain code, zero model calls). After every run, one reply draft per sender, on the
// channel they used (email or WhatsApp), telling them what the plan decided, including why a
// message of theirs was rejected. Drafts are only displayed and saved (out/outbox.txt); nothing is sent.
const rs = (n) => (n == null ? "?" : "Rs " + Number(n).toLocaleString("en-US"));

function channelOf(m) {
  const c = String(m.channel ?? "").toLowerCase();
  if (c.includes("whatsapp") || c.includes("sms") || c.includes("text")) return "WhatsApp";
  return "Email";
}

export function buildOutbox(state) {
  const p = state.plan;
  if (!p) return [];
  const drafts = [];
  const bySender = new Map();
  for (const m of state.messages) {
    // "Dean office", "Dean's office" and "Dean’s office" are one sender
    const name = String(m.sender).toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).map((w) => w.replace(/s$/, "")).join(" ");
    const key = `${name}|${m.role}`;
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key).push(m);
  }
  const sched = p.schedule;
  const window = sched?.start ? `${sched.start}-${sched.end}` : `${p.event.hours} hours`;
  const judgingBlock = sched?.blocks.find((b) => b.isJudging);
  const at = (b) => (sched?.start ? b.start : `${b.start.replace("+", "")} after the start`);
  const span = (b) => (sched?.start ? `${b.start}-${b.end}` : `from ${b.start.replace("+", "")} to ${b.end.replace("+", "")} after the start`);

  const valid = Boolean(state.validation?.ok);
  for (const msgs of bySender.values()) {
    const m = msgs[msgs.length - 1];
    const rejected = msgs.filter((x) => x.status === "rejected");
    const lines = [];
    const why = rejected.map((x) => `- Your message "${x.summary}" was not applied: ${x.reasons.join("; ")}.`);
    // an invalid plan is never presented as decided: only the organiser hears what is missing
    const role = valid ? m.role : m.role === "organizer" ? "invalid" : "none";
    switch (role) {
      case "invalid":
        lines.push("The hackathon plan is NOT valid yet. Failing checks:");
        for (const c of state.validation?.checks ?? []) if (!c.ok) lines.push(`- ${c.name}: ${c.detail}`);
        break;
      case "none":
        break;
      case "organizer":
        lines.push(`The hackathon plan is ${state.validation?.ok ? "complete and passes all checks" : "NOT yet valid"}:`);
        lines.push(`- ${p.event.students} students in ${p.event.teams} teams, ${p.event.headcount} people on site, ${window}.`);
        if (p.venue) lines.push(`- Venue: ${p.venue.name} (${p.venue.capacity} seats), ${rs(p.venue.price)}.`);
        if (p.food) lines.push(`- Food: ${p.food.quantity} x ${p.food.option} @ ${rs(p.food.pricePerHead)}.`);
        lines.push(`- Judging: ${p.judging.judgesNeeded} judges, ${p.judging.judgingMinutes} min.`);
        lines.push(`- Budget: ${rs(p.budget.spent)} of ${rs(p.budget.total)}, ${rs(p.budget.remaining)} remaining.`);
        { const all = state.messages.filter((x) => x.status === "rejected");
          if (all.length) lines.push(`- ${all.length} message(s) were not applied; reasons are in the attached trace.`); }
        break;
      case "venue":
        if (p.venue) lines.push(`Please confirm the booking of ${p.venue.name} for ${p.event.headcount} people (${window}) at ${rs(p.venue.price)}.`);
        break;
      case "caterer":
        if (p.food) {
          lines.push(`Please confirm our order: ${p.food.quantity} x ${p.food.option} at ${rs(p.food.pricePerHead)} each = ${rs(p.food.quantity * p.food.pricePerHead)}.`);
          if (p.food.special?.length) lines.push(`Of these: ${p.food.special.map((x) => `${x.count} ${x.name}`).join(", ")}; the rest regular.`);
          lines.push(`We need meals for all ${p.event.headcount} people on site, so the quantity cannot be reduced.`);
          const lunch = sched?.blocks.find((b) => /lunch/i.test(b.name));
          if (lunch) lines.push(`Lunch is served at ${at(lunch)}.`);
        }
        break;
      case "judging":
        lines.push(`We need ${p.judging.judgesNeeded} of the ${p.judging.judgesAvailable} confirmed judges, ${p.judging.maxTeamsPerJudge} teams each at ${p.judging.minutesPerTeam} min per team.`);
        if (judgingBlock) lines.push(`Judging runs ${span(judgingBlock)}.`);
        lines.push(`Honorarium: ${p.judging.judgesNeeded} x ${rs(p.judging.feePerJudge)} = ${rs(p.judging.feeTotal)}.`);
        break;
      case "finance":
        lines.push(`Planned spend is ${rs(p.budget.spent)} of ${rs(p.budget.total)} (remaining ${rs(p.budget.remaining)}):`);
        for (const l of p.budget.lines) lines.push(`- ${l.item}: ${rs(l.amount)}`);
        break;
      case "judge":
        if (judgingBlock) lines.push(`Thank you for letting us know. Judging runs ${span(judgingBlock)}; please arrive before it starts.`);
        else lines.push("Thank you for letting us know.");
        break;
      default: {
        if (!valid) break;
        const reqs = p.budget.requests.filter((r) => msgs.some((x) => String(r.source).startsWith(`#${x.id} `)));
        for (const r of reqs) lines.push(`Your request (${r.item}, ${rs(r.amount)}) is not in the plan: it has not been approved by the organisers.${r.affordable ? " It would still fit the remaining budget if they approve it." : " It would not fit the remaining budget."}`);
        if (!reqs.length && !rejected.length) {
          if (msgs.every((x) => x.status === "ignored")) continue; // nothing to tell (e.g. lost & found)
          lines.push("Thank you, noted.");
        }
      }
    }
    lines.push(...why);
    if (!lines.length) continue;
    // reply on the sender's last known channel (a later message may not say how it came)
    const known = [...msgs].reverse().find((x) => /email|whatsapp|sms|text/i.test(String(x.channel ?? "")));
    const channel = channelOf(known ?? m);
    drafts.push({
      to: m.sender, role: m.role, channel,
      subject: channel === "Email" ? (m.role === "organizer" ? "Hackathon plan summary" : `Hackathon: ${m.role} confirmation`) : null,
      body: lines.join("\n"),
      replyTo: msgs.map((x) => x.id),
    });
  }
  return drafts;
}

export function outboxText(drafts) {
  if (!drafts.length) return "No drafts.";
  return drafts
    .map((d) => `=== ${d.channel} to ${d.to} (re: message ${d.replyTo.map((i) => "#" + i).join(", ")})${d.subject ? `\nSubject: ${d.subject}` : ""}\n${d.body}`)
    .join("\n\n");
}
