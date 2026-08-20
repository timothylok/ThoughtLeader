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

- **The brief is a source, and it is the one never probed.** A plan can assert that data
  exists as confidently as it asserts a fact. Here B2 — "most active investors in
  Australian AI, by deal count" — was carried through eight runs, a benchmark and a
  decision record before anyone checked whether *any* source publishes that ranking. None
  does. Worse, the wrong side had already been diagnosed: the ledger's investor coverage
  was 2 of 4 rows, so a workstream was queued to improve extraction, when at 4 of 4 there
  would still have been nothing to compare against. **Before building the thing that
  produces one side of a comparison, fetch the other side.** One search cancelled the
  workstream.
- **Where no source exists, write NOT MEASURED into the artefact and say what not to
  conclude.** Filling the gap from whatever ranked lists exist puts an unfalsifiable
  number where a measurement belongs — §10 in a document instead of in a guard.

The test: could you name the exact command that proved this source works? And a second
command that proved it is about what you think it is? And for anything your plan compares
against — the command that proved the other side exists at all?

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
- **An unset credential must deny, and that is the case you cannot test with it set.**
  The write endpoints here went unauthenticated for nine days because the risk was filed
  as "the URL must not leak" — a `.gitignore` entry instead of a gate. When the gate was
  added, the fail-open default was ruled out by deploying the code *before* creating the
  secret and confirming production returned 401 to a **correct** token. Every other test
  sends the credential, and every one of them passes against a guard that never checks.
- **Name the protected set by verb, not by method.** "Every route that writes or spends"
  includes `GET /search`, which mutates nothing and bills neurons because recall embeds
  the query. "Every POST" does not — and that is the same call site §7 already lost a
  spend guard to.

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

## 10. Unknown Is Not Zero

**A default that turns "I couldn't measure this" into "this was free" will never
raise an alarm.**

The spend guard in this project was wrong three times, and each fix passed its own
test:

- #17 estimated embeddings with arithmetic and omitted two call sites → **21% low**.
- #19 replaced that with exact figures but summed them at the *end* of a retryable
  step, while the provider bills **every attempt** → lost every retried call.
- #21 replaced *that* with `usage.neurons` — a field embedding responses **do not
  return** — so `?? 0` recorded them as free → **100% low** on 6% of spend.

Each fix was more "correct" than the last and each shipped a new silent undercount.
The pattern is not carelessness about arithmetic; it is a default that fails quiet:

```ts
const cost = res.usage?.neurons ?? 0;   // "unknown" and "free" are now the same value
```

- **Verify the field exists before building on it.** "The provider returns X" is a
  claim about a specific model, not the API. Print the raw response for *each* model
  you call.
- **Make unpriceable loud.** Log an error naming the model; never silently record 0.
- **Reconcile against the provider, not against yourself.** A guard checked against
  its own computation always passes. One command comparing `/usage` to Cloudflare's
  analytics found what three rounds of code review did not.
- **Ask what a clean run cannot prove.** The verification run confirmed call-site
  coverage and was structurally incapable of testing retry accounting.

The test: for every number your guard reports, can you name the external source you
checked it against — and the case where it would read low without failing?

---

## 11. Repetition Is Not Replication

**Correlated observations are not independent evidence, however many of them you have.**

Three times in one session here a confident claim rested on samples that were not
independent:

- One in-run `403` became *"the seed is bot-blocked"* — written into two documents as a
  property of the source, with a recommendation to delete it.
- The correction over-shot: five probes returning `200` became *"the 403 was
  transient."* Those five were consecutive requests in a single burst, one connection,
  seconds apart — closer to **one** sample than to five.
- One late, sparse monitor run became *"it is not a liveness signal"* — a design
  verdict from n=1. The next run performed perfectly.

- **Before quoting an n, state what varied across the trials.** A different connection,
  a different hour, a different code path. If nothing varied, you have one observation
  repeated, and the honest n is 1.
- **Failures are the easier case to over-read**, because they arrive with an
  explanation already attached. A `403` *looks* like bot-blocking, so the hypothesis
  arrives pre-confirmed.
- **Name the contexts that disagree instead of picking one.** *"Fails in runs 0/3,
  succeeds in probe bursts 5/5, cause unknown"* is more useful than either verdict, and
  it points at the thing actually worth investigating — the difference between the two
  contexts.
- Applies to timings and costs identically (§6, *re-measure rather than extrapolate*).
  This is the same rule pointed at failures and at qualitative judgements.

The test: if you are about to write a property of a thing rather than a description of
an event, ask how many *independent* observations support it.

---

## 12. Verify The Manipulation Before You Believe The Result

**An experiment that cannot have applied its own treatment will still produce a
clean-looking table.**

Measuring the fresh-excerpt window here (bugs.md #24) produced eight tidy samples
across two "arms" that were the *same arm*. Three config channels (`--var`,
`.dev.vars`, `.env`) silently failed to bind, and a fourth bound while a stale
server on the same port kept answering — wrangler printed
`env.FRESH_EXCERPTS ("11")` the whole time. Control n=8, treatment n=0, and every
number was self-consistent.

- **Report the effective setting from inside the code path, next to the result.**
  Not from the launcher, not from the startup banner, not from the value you
  passed in. §10's rule about guards checked against their own computation is the
  same rule: the launcher and the handler are two different witnesses.
- **An identical cost or latency figure across arms is a failed manipulation until
  proven otherwise.** Two runs billing `140.83984375` neurons did not process
  different prompts. This was the first and cheapest tell, and it arrived long
  before the diagnosis.
- **A "restart" is not a restart until the old process is gone.** Every dev-server
  restart in that session left the previous one running and owning the port, so the
  first server started that day answered every request for hours. Take distinct PIDs
  from the **LISTENING** lines of `netstat -ano`, and **kill parents, not children** —
  killing the eight `workerd` children returned SUCCESS on all eight and their
  surviving parents respawned them within seconds. The cheapest reliable restart is a
  **fresh port**.
- **A tool reporting SUCCESS is describing a syscall, not the world.** Three separate
  process kills reported success here while the thing being killed carried on, and one
  read (`Get-NetTCPConnection`) returned 2 owners where `netstat` showed 8 — which
  produced a confident, wrong all-clear. When two tools disagree about how much is
  running, the one reporting **less** is the one to distrust, and the check that
  settles it is the observable effect: can you still reach the port?
- **State the arm sizes when reporting.** "n=8 vs n=3" makes an n=0 arm impossible
  to hide behind a percentage. This is §11 pointed at your own instrumentation
  rather than at the world.
- **Your own reader is an instrument, and it is not neutral.** A `curl | python`
  check reported the stored baseline here as mojibake for an entire investigation:
  `json.load(sys.stdin)` decodes with the **locale** codec, so clean UTF-8 came back
  corrupted on every read. Name the encoding on both sides —
  `sys.stdin.buffer.read().decode('utf-8')`, `open(p, encoding='utf-8')`. Two tells
  came before the diagnosis and both were skipped: the "corrupt" character count
  equalled the correct **byte** count, and a value the server had just acknowledged
  as correct still read as damaged. **When two witnesses disagree about stored data,
  distrust the one with a locale in its path**, and re-read before reporting damage.

The test: name the observation that would look different if the treatment had
never been applied. If every number in your table survives that question
unchanged, you have not run an experiment.

---

## 13. A Documented Limitation Is Still A Defect

**Writing the caveat is not handling it.**

The daily cron here was `0 16 * * *`, and `wrangler.jsonc`, `src/index.ts` and the README
each carried a comment saying Cron Triggers are UTC only and this becomes 05:00 NZDT in
September. Three files agreed about the problem. Nothing fixed it for nine days, because
the comment made it feel handled — and six weeks out it was a run at the wrong hour for
six months while the docs went on saying 04:00.

- **A caveat in a comment is a defect with an excuse attached.** If you deleted the
  comment, would the behaviour read as a bug? Then it is one, and it belongs in the bug
  log with a status, not in a paragraph.
- **Prefer the design that is testable at any time.** The first version of the fix gated
  on the local wall-clock hour, which can only be exercised at 04:00. Keying it on the
  **UTC offset** instead made both DST regimes testable at any hour — which is the only
  reason a 365-day simulation exists to prove no day is skipped or doubled.
- This is §6 for scheduled behaviour: the limit you flagged in planning is the one to
  measure first. A date six weeks away is still a date.

---

## 14. Prose Cannot Hold An Invariant — And Count It Before You Fix It

**If a rule is mechanically checkable, checking it in prose is a category error.**

The baseline here states round-size bounds as a table and the rule for using them in a
sentence: *"a round with no stage stated cannot be checked against this table."* Both were
handed to the model. In one report it broke all three parts — called a $20M Seed *"within
the expected range according to [B3]"* when B3 flags Seed above $12.0M, checked a stageless
round as a Seed anyway, and tried to resolve an investor divergence the baseline explicitly
forbids flagging. The data it needed was two columns the ledger already stored.

- **A false negative that asserts compliance is worse than silence.** *"None."* means
  nobody looked. *"Within the expected range according to [B3]"* means somebody looked and
  cleared it — over the largest divergence in the ledger. §10's rule is that "unmeasured"
  must not print as "clean"; this is its sharper form, where the system *claims* to have
  measured.
- **Ask which sections of the deliverable the model should be allowed to decide.** Three
  sections of this report moved into code, each after the model got it wrong in production:
  the event list (#28), the round-size check (#36), and the empty-baseline notice (#30).
  The pattern was visible after the first one.
- **Derive the constants, never copy them.** The B3 bounds are constructed and get
  recomputed on every baseline refresh, so they are parsed from the document rather than
  duplicated in code — and the tests read the real document, so a refresh that breaks the
  format fails `npm test` instead of the next unattended run. A copied constant is the
  stale comment of §13 with arithmetic attached.

**Where you cannot mechanise it, measure the violation rate before designing the fix.**

The same run leaked an already-recorded event into the report, and the prompt has forbidden
that from the start. The tempting fix is a better instruction, or a filter. Both are guesses
until you know whether the rule holds 95% of the time or half the time — and three anecdotes
cannot tell those apart.

- Counting it here took one function and produced **50%**: 4 of the 8 findings ever handed
  a non-empty list named something on it, across four runs on three days. That is a
  different problem from an occasional slip, and it is now a number rather than an argument.
- **Count on every writer.** The measurement went into the workflow *and* `/step`; a rule
  counted on one path is not counted (§9).
- **Backfill, or NULL means two things.** A new column recording violations reads every
  pre-existing row as clean unless history is written into it — "never measured" and "no
  violation" collapsing onto one value, which is §10 in a schema.
- One of the leaks had already been observed and filed as a *success*, because the events
  it named did stay out of the report. Both readings were true. **A rule can be broken
  inside an outcome you are recording as correct**, which is why the rate has to be counted
  rather than noticed.

The test: for each claim your deliverable makes, can code check it? If yes, the model
should not be the one making it. If no, what is the measured rate at which the rule you
are relying on actually holds?

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites
due to overcomplication, clarifying questions come before implementation rather than
after mistakes, the risks named during planning get measured rather than assumed,
bug fixes close the invariant rather than the incident, and the rules the system
relies on are counted rather than assumed.
