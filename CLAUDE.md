# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

# Project lessons

*Earned building the research loop in this repo. Full write-up in `lessonlearnt.md`,
bug log in `bugs.md`. These are not general advice — each one cost real time here.*

## 5. Validate Inputs Before Building On Them

**Check the source, don't trust the brief.**

- Test every external source through the **actual pipeline** before designing around it.
  Half the seed list in this project was bot-blocked (HTTP 403/405) or returned a
  block page rather than content.
- Verify factual claims in a brief before they become requirements. One brief named
  "Accenture New Zealand" as an AI startup; it is a global consultancy, and it was the
  only concrete source for an entire arm of the work.
- Numbers cited without a checkable source are unverified, not true. Say which is which.

The test: could you name the exact command that proved this source works?

## 6. Measure The Limit That Scares You — First

**The risk you flag in planning is the one to verify before anything depends on it.**

- If a platform limit could invalidate the design, measure it in step one, not step seven.
  The 10 ms CPU limit was correctly identified as the top risk here, then *assumed* to
  fit. It was over by 64×.
- Prefer measured values to arithmetic. Workers AI returns exact `usage.neurons`; the
  estimate built from token maths was 25% low.
- Re-measure rather than extrapolate from one sample. The same page measured 229 ms,
  594 ms and 644 ms across runs.
- **Never let an assumption become a justification in the docs.** The fatal bug here was
  a sentence written into the README explaining why the design was safe.

## 7. Safety Rails Before Autonomy

**Anything that runs unattended needs a brake you have tested.**

- Build and verify the kill switch **before** the thing it stops. Test it by triggering
  it, not by reading the code.
- Assume platform-level guards do not exist. Cloudflare budget alerts do not cap usage
  and fire a day late; the only real stop is in application code.
- Close every path to the guarded resource. The spend guard here initially missed the
  debug endpoint and the cron watchdog — both could spend freely.
- **Never deploy while a run is in flight.** A deploy resets the Durable Object behind a
  live Workflow. Check `/state` or `wrangler workflows instances list` first.
- Treat every write inside a retryable step as if it will run three times. Partial
  execution is the normal case.

## 8. Right Tool For The Phase

**Don't ask which tool wins. Ask which phase each one owns.**

- Use the fast, expensive, high-quality path to **design and validate**; use the slow,
  cheap, autonomous path to **execute repeatedly**.
- Put cost in the comparison table from the start. A missing cost figure inverted the
  conclusion of this project's benchmark once it was known ($10 vs $0.019 per run).
- Report the losing result plainly when it is the true one, including when it is your
  own build that lost.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites
due to overcomplication, clarifying questions come before implementation rather than
after mistakes, and the risks named during planning get measured rather than assumed.
