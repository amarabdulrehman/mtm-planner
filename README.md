# MTM Planner

Reads a pack of messages (emails, WhatsApp texts, notices, in English or Roman Urdu) and plans a 4-hour hackathon: **venue, schedule, food, judging, budget**. Built at MTM Version 2.0, GDGoC CUI Wah.

## Run

```bash
npm install
# .env  ->  GEMINI_API_KEY=...   (optional: GEMINI_API_KEY_BACKUP=..., GEMINI_MODEL=...)
npm run plan -- pack.txt        # first run: plans from every message
npm run plan -- new-message.txt # every later message: same command, updates the plan
npm run ui                      # http://localhost:4321  plan, checks, messages, trace, outbox
npm run reset                   # start over with a new pack
```

Each run prints the trace and saves `out/plan.md`, `out/trace.txt` (all runs), `out/outbox.txt` (reply drafts), `out/submission.txt` (plan + full trace + outbox, the file to upload) and `out/state.json`.

## How it works

```
message text ──► READING (1 model call) ──► FACT STORE (code) ──► AREA CALLS (model, only if needed) ──► PLANNER (code) ──► VALIDATOR (code)
                 language -> facts          authority + newest      constraints code can't express          all arithmetic      6 checks
```

| Part | What it does | Why it exists / what breaks without it |
| --- | --- | --- |
| `src/reader.mjs` (model, area `reading`) | One call turns all new messages into typed facts (`budget.total`, `venue.option`, …), plus sender role and date, and free-text constraints. Irrelevant messages are marked ignored. | The only part that needs language understanding. Without it we would have to hard-code facts, which is not allowed. One call for the whole pack keeps tokens low. |
| `src/facts.mjs` (code) | Keeps every fact with its source. **Newest message wins** for the same figure (Rs 1,000 lunch → Rs 1,200). **Authority check**: only the right sender can set a figure (a caterer cannot cut the number of meals; only finance/organiser can record spending). | Without it, out-of-date or unauthorised messages would silently change the plan. |
| `src/resolvers.mjs` (model, area tag = venue/schedule/food/judging/budget) | Only when a message has a constraint the fact keys cannot express ("venue needs a generator"), one call for **that area** returns allowed operations (exclude a venue, require a feature, add a block, add a cost). Cached per area. | Handles kinds of constraint we have not seen. Area-scoped and cached, so an update only calls the areas it touches. |
| `src/planner.mjs` (code) | Teams = students ÷ team size. Judges needed = ⌈teams × judges per team ÷ max teams per judge⌉. Headcount = students + staff + judges needed. Cheapest venue that seats everyone; standard food unless the budget forces a cheaper option; schedule fills exactly the event length; budget = venue + food + judge fees + already-ordered items. | Arithmetic in code is exact and costs zero tokens. |
| `src/schedule.mjs` (code) | Builds the timeline. Blocks with a stated clock time ("judging 1-2 pm") are placed exactly. Opening goes at the start and closing at the end, judging just before closing, lunch and breaks mid-day. Every free minute becomes a build session. | Without it, fixed times in messages would be ignored or blocks would overlap. |
| `src/validate.mjs` (code) | Checks: figures complete, within budget, venue fits, schedule valid, enough judges, meals cover everyone, all areas covered. | Guarantees we never output an invalid plan. |
| `src/engine.mjs` (code) | Applies messages one by one. If a message makes a check that was passing fail, it is **rejected**, the previous facts are restored and the reason goes in the trace. | This is how a plausible-but-wrong message is caught while the plan stays valid. |
| `src/llm.mjs` | Every model call goes through here and is logged: number, model, area, input, output, token counts as reported by the API. Backup key on failure. | The trace is required and must be honest. |
| `src/outbox.mjs` (code, zero model calls) | After every run, one reply draft per sender on the channel they used (email or WhatsApp): venue booking, caterer order, judges needed, finance breakdown, plan summary for the dean, and the reason for every rejected message. Saved to `out/outbox.txt`, shown in the UI. Nothing is sent. | Senders, especially rejected ones, would never hear the decision. |
| `ui/` | Live page: plan, checks, messages with status, rejected messages with reasons, full trace. | Judges can read the result at a glance. |

**Update cost:** a new message makes 1 reading call, plus 1 call per area **only** if it adds a new constraint for that area. A figure change (e.g. printing Rs 10,000 → Rs 15,000) = 1 call. Limit is 5.

**Safeguards tested against an independent test suite:** numbers that are negative, not numbers, or money below Rs 50 with no clear unit ("printing is now 6") are not applied; increases ("eight additional staff") add to the current figure; two equally authoritative messages with the same date and different figures are disclosed as a conflict; teams that do not divide evenly are disclosed; a judging window that is too short reports exactly how many teams can be covered; judges are assigned team by team with clock times; dietary splits (e.g. 13 of 112 vegetarian) appear in the food plan; instructions inside messages are treated as data; roles are normalised in code; the model's JSON is extracted even with extra text around it; empty files and duplicate files make no model calls.

**Small-model bonus:** every call uses `gemini-3.5-flash-lite`; if it fails, the fallbacks are the same model on a second key, then `gemini-3.1-flash-lite`, both small "lite" models. A last-resort OpenAI-compatible provider (e.g. Groq) is used only if configured in `.env`. The trace ends with "Models used in all runs", so a judge can check every call's model.

**Planning defaults** (our choices, shown as assumptions in the plan): opening 15 min, lunch 30 min, closing 15 min, 1 judge per team unless a message says otherwise. Requests that nobody approved (e.g. a DJ) are listed but not included.

No pack facts or messages are written in the code.
