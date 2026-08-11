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
- **Extractability and relevance are two separate validations.** Probing every source
  through the pipeline caught the bot-blocked half of one seed list. It did not catch
  two sources that fetch perfectly and are about something else: both Wikipedia
  "Science and technology in X" URLs are redirects to the country articles, so the
  confident "35,112 ch / 29 chunks" in the brief measured the wrong document — and one
  of them was 1.84 MB and killed a run. Downstream, 91% of a run's chunks went uncited.
  Check the extracted text against the source's *stated purpose*, not just its length;
  a large character count reads as success and hides this completely.

The test: could you name the exact command that proved this source works? And a second
command that proved it is about what you think it is?

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
  debug endpoint, the cron watchdog, the report call, the recall embedding and a `dryRun`
  that left a row the watchdog would resurrect — every one of them could spend freely.
- Meter from the provider's own usage field, never from arithmetic. Estimating embeddings
  and omitting two call sites made the spend guard read **21% low**, so real usage passed
  the free allocation while `/usage` still showed headroom. **A guard tested only against
  the number it computes itself will always pass** — reconcile against the provider's
  figure at least once.
- Treat every write inside a retryable step as if it will run three times. Partial
  execution is the normal case.

### 7.1 No code deployment during a live run

**`wrangler deploy` while a run is in flight is never acceptable.** A deploy resets the
Durable Object behind the live Workflow, and the catch-all can write a terminal status to
a run that is still healthy (bugs.md #4). This has now cost time twice, so it is its own
rule rather than a bullet:

```sh
# Gate. Not a print. Exits non-zero when anything is running.
curl -s "$WORKER_URL/state" \
  | grep -q '"status": "running"' && { echo "RUN IN FLIGHT — refusing to deploy"; exit 1; }
wrangler deploy
```

- **The check must abort, not report.** The second violation happened *after* running the
  check: it printed `runs in flight: 1`, and the deploy was chained with `&&` so it ran
  anyway. Observing a blocker and proceeding is worse than never checking, because it
  produces a log line that looks like diligence.
- Verify with `wrangler workflows instances list` too. A `dryRun` leaves
  `status='running'` with **no instance**, so `/state` alone can both raise a false alarm
  and — via the watchdog — hide a real one.
- If a deploy is genuinely urgent mid-run, `POST /stop` first and let the run reach its
  assess step. Losing an iteration beats corrupting the run's recorded state.

## 8. Right Tool For The Phase

**Don't ask which tool wins. Ask which phase each one owns.**

- Use the fast, expensive, high-quality path to **design and validate**; use the slow,
  cheap, autonomous path to **execute repeatedly**.
- Put cost in the comparison table from the start. A missing cost figure inverted the
  conclusion of this project's benchmark once it was known ($10 vs $0.019 per run).
- Report the losing result plainly when it is the true one, including when it is your
  own build that lost.

---

## 9. Fix The Invariant, Not The Incident

**A fix verified against the path that failed will miss the path that hasn't yet.**

Three times in this project a fix was applied to the exact reported symptom and left an
identical defect one branch away:

- Bug #8 stopped a failed `LOOP.create()` leaving a row in `status='running'` with no
  instance. The `dryRun` branch **three lines below** created that same zombie by
  design, and the watchdog would have launched a throwaway test as a real run (#18).
- Bug #12 added `normalizeUrl()` to kill fabricated and duplicate URLs — and applied it
  to model proposals only. Seeds stayed verbatim, so `UNIQUE(run_id, url)` compared two
  canonical forms that could never collide (#14). **Canonicalisation applied to one side
  of a comparison is not canonicalisation.**
- The spend guard metered the reasoning call exactly and left three other AI call sites
  estimated or uncounted, so it read 21% low (#17).

Before closing a bug, state the **invariant** it protects — *"no row sits in `running`
without an instance"*, *"every URL in the table is canonical"*, *"every AI call is
metered"* — then grep for every writer to that invariant. The incident is one violation
of it, not the whole of it.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites
due to overcomplication, clarifying questions come before implementation rather than
after mistakes, the risks named during planning get measured rather than assumed, and
bug fixes close the invariant rather than the incident.
