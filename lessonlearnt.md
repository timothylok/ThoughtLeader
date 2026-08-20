# Technical Lessons Learned: Building an Autonomous Research Agent on Cloudflare

*What happened when I built a self-running research loop on Cloudflare Workers,
then benchmarked it against the AI agent that built it.*

---

## 1. Context & Goal

I set out to build a **goal-directed research agent** that runs unattended on
Cloudflare: you give it a topic, a set of goals, and some seed URLs; it reads one
source per iteration, remembers what it read in a vector database, reasons over
that memory, records a finding, and self-assesses against the goals until they're
met or a budget runs out.

The whole thing was built by **Claude Code**. Which raised an obvious question
once it worked:

> If Claude Code can build the research agent, how does the agent's output compare
> to Claude Code just *doing the research directly*?

So I ran both on an identical task — the Australian AI startup ecosystem, same
five goals, same nine validated sources — and compared.

**Two things I did not expect going in:**

1. Almost every hard lesson came from *running* the system, not from designing it.
   12 bugs, and the two worst were completely invisible while broken.
2. The cost gap between the two approaches was **527×**, which inverted my
   initial conclusion about which tool "won".

---

## 2. The Cloudflare Implementation

### Architecture

| Component | Role |
|---|---|
| **Workers** | HTTP API + cron watchdog |
| **Workflows** | Durable execution — the loop itself, with per-step retries |
| **Workers AI** | Llama 3.3 70B for reasoning, BGE-small for embeddings |
| **Vectorize** | Semantic memory, one namespace per run |
| **D1** | Source queue, findings, spend ledger, kill switch |
| **Cron Triggers** | Restart runs that stall |

The loop body is six steps per iteration:

```
step.do  "next-source" → claim next URL from the D1 queue
step.do  "ingest"      → fetch + HTMLRewriter + chunk → embed → Vectorize
step.do  "recall"      → embed(goals) → Vectorize.query(namespace = runId)
step.do  "reason"      → Workers AI: excerpts + memory + prior findings
step.do  "record"      → finding → D1 + Vectorize, queue new sources
step.do  "assess"      → goals met? budget spent? stop requested?
step.sleep INTERVAL                      ← free, doesn't count toward step limits
```

### What worked well

**Workflows' durable execution is the real product.** Steps retry independently,
state survives hibernation, and `step.sleep` doesn't count against the step limit —
so a loop can idle 18 minutes between iterations to stay inside a daily budget
without consuming quota. That single property makes slow, long-horizon agents
practical.

**HTMLRewriter is dramatically faster than the obvious alternative.** It's native
streaming Rust, so a 211 KB page parses in ~229 ms of CPU where a regex pass over
the same string would be seconds.

**Namespaces beat metadata filters for tenancy.** Vectorize metadata indexes have
a nasty property: *vectors inserted before the index exists are permanently
invisible to it.* No backfill, no repair. Namespaces need no pre-declaration and
are safe to create at any time.

### What was painful

**The free tier can't do HTML.** Measured CPU per invocation, against a 10 ms
free-plan limit:

| Content type | Size | CPU | Fits in 10 ms? |
|---|---|---|---|
| `text/plain` | 4 KB | **1 ms** | ✅ |
| `text/markdown` | 21 KB | **1 ms** | ✅ |
| `text/html` | 399 B | 5 ms | ✅ barely |
| `text/html` | 12 KB | **15 ms** | ❌ |
| `text/html` | 211 KB | **229–644 ms** | ❌ 64× over |

Non-HTML costs ~1 ms *regardless of size* because it skips the parser entirely.
HTML carries ~4–5 ms of fixed overhead before any content. So the free tier is
viable — but only if you feed it `llms.txt`, `.md` mirrors, RSS and JSON APIs.

**Budget alerts don't do what you'd assume.** They are informational only: they
**do not pause or cap usage**, and because usage is processed daily they fire *the
day after* you cross a threshold. On a paid plan an autonomous loop needs its own
hard stop, in code.

### Surprises

- **Vectorize inserts are asynchronous** — 15–30 seconds before written vectors
  are queryable. An iteration literally cannot recall what it just wrote.
- **Workers AI returns `response` as a string *or* an object.** Prose gives a
  string; valid JSON gets auto-parsed into an object. Since my prompt *asked* for
  JSON, it crashed on the first real call with `raw.trim is not a function`.
- **Every AI response carries `usage.neurons`** — exact spend, no estimation
  needed. My arithmetic estimate had been 25% low.

---

## 3. The Claude Code Arm

There is no second implementation. Claude Code **built** the Cloudflare system;
the comparison was Claude Code **performing the research task directly** using
`WebFetch` on the same nine sources, in one pass.

### Build process

The build took roughly a working session and produced ~1,100 lines across eight
modules, plus a live dashboard and a 700-line README of measured constraints.

What actually made it work wasn't code generation — it was **validation before
execution**. Before writing anything, the sources in the research brief were
checked, and half of them failed:

- **Seedtable** — HTTP 403. Fetched via Cloudflare it returned 3,005 characters of
  intro text and **zero company names** (JS-rendered).
- **F6S** — HTTP 405. Extracted exactly **68 characters**: `"Request ID: jEWj…"` —
  a bot-block page.
- **"Accenture New Zealand"** listed as an NZ AI startup — Accenture is a global
  consultancy of ~800,000 people. It was the *only* concrete NZ company in the
  brief, and it was wrong.

That validation step saved the entire NZ arm of the project from being built on a
single bad datapoint.

### What was painful

**The tooling is more restrictive than raw `fetch`.** Same web, different results:

| Source | Claude Code `WebFetch` | Cloudflare `fetch` |
|---|---|---|
| InnovationAus | ❌ HTTP 403 | ✅ 4,181 chars |
| Wikipedia | ❌ near-empty | ✅ 35,951 chars |
| Cut Through Venture | ⚠️ refused cross-host redirect | ✅ followed automatically |

The Worker got **more raw material**; Claude Code did **more with less**.

### Surprises

**The expensive mistakes were architectural assumptions, not syntax.** The fatal
bug was a sentence I wrote into my own README as justification:

> *"1 fetch + ~4 binding calls per iteration — fine by design."*

Wrong. Cloudflare's subrequest budget is per **invocation**, not per step. A
resumed Workflow instance accumulates subrequests across iterations, and the run
died at iteration 11 of 12 after 27 minutes with no report. Nothing in the docs
contradicts the assumption directly — only a long run disproved it.

---

## 4. Key Differences

Same task, same goals, same sources.

| | **Cloudflare loop** | **Claude Code** |
|---|---|---|
| Wall clock | 24 m 52 s | **~2 m 30 s** |
| Cost per run | **$0.019** (free tier: $0) | **$10.00** |
| Cost ratio | 1× | **527× more expensive** |
| Goals answered well | 1 of 5 | **5 of 5** |
| Named companies surfaced | ~8 | **60+** |
| Persistent artefact | ✅ queryable vector memory | ❌ transcript only |
| Runs unattended | ✅ | ❌ |
| Discovered new sources | ✅ | ❌ |

**Development speed.** Claude Code, no contest. Minutes versus a session.

**Deployment friction.** Cloudflare is genuinely low-friction — `wrangler deploy`
is seconds — with one sharp edge: **deploying resets the Durable Object behind an
in-flight Workflow.** I did exactly that mid-benchmark, and my catch-all handler
marked a *still-running* workflow as failed. The dashboard lied about a healthy run.

**Debugging.** Cloudflare's `wrangler tail --format json` gives real per-invocation
`cpuTime` — that's how the 10 ms problem was quantified instead of guessed. But
Workflows failures surface *at the step that noticed*, not the step that caused it.

**State management.** The single most important Workflows rule:

> **State must be rebuilt only from step return values.**

Instances hibernate across `step.sleep` and replay `run()` from the top. Any local
variable not derived from a `step.do` return will silently diverge.

**Observability.** Cloudflare wins outright. A `/live` dashboard showed iteration
count, findings, sources and neuron spend in real time. Claude Code's equivalent is
scrollback.

---

## 5. Lessons Learned

### Running it beats reviewing it

12 bugs. **Not one** was found by reading code. The two worst were invisible while
broken:

- **Vector IDs keyed on the iteration counter.** A failed iteration doesn't advance
  the counter, so the next attempt reused it and `upsert` silently overwrote a
  different source's vectors. Chunk counts looked correct. No errors anywhere.
  Only a *two-source* retrieval test exposed it — a single-item test cannot.
- **`Number(v) || fallback` discards a legitimate `0`.** `MAX_SOURCE_DEPTH="0"`,
  documented as "disable this", evaluated to `2`. The flag did the exact opposite
  of its documentation, at five call sites.

### Knowing a rule isn't applying it

Cloudflare's docs say: *"Non-idempotent API/Binding calls are always done after
checking if the operation is still needed."* I **quoted that in my own README**,
then wrote a step that inserts a row and *then* does three fallible things. Six
retries produced six duplicate rows.

Treat every write inside a step as if it will run three times.

### Grounding beats filtering for hallucination

The loop invented ~40% of its own sources — `australianstartup.org`,
`startupaus.org`, and `startmate.com.**au**` (real company, wrong TLD).

Syntax validation can't catch these; they're perfectly-formed URLs. The fix was to
stop asking the model to *generate* URLs and instead **harvest real links from
pages already fetched**, letting the model only *select* from what demonstrably
exists. Result: 6 proposed → 1 accepted, and the queue grew 3→4 instead of 9→27.

But measuring honestly matters. Of 5 rejections, only **2 were fabricated**. Three
were real sites that simply weren't linked from the page being read. **Grounding is
conservative, not precise** — it eliminates fabrication and also discards useful
sources. That's a trade, not a free win.

### Cost changes the verdict, not just the invoice

My first benchmark concluded *"Claude Code wins outright — this isn't close."* That
was written before I knew the cost: **$10 vs $0.019.**

The corrected question isn't "which is better" but "**is the quality gap worth
527×?**"

| | Per run | Weekly for a year |
|---|---|---|
| Claude Code | $10.00 | **$520.00** |
| Cloudflare loop | $0.019 | **$0.99** |

For a one-off decision someone will act on: obviously yes. For the tenth topic this
month: obviously not.

---

## 6. What I'd Do Next Time

**Validate sources before building anything.** Half the seed list was bot-blocked
or fabricated. An hour of checking saved a project built on sand.

**Measure the platform limit that scares you, first.** The 10 ms CPU budget was
flagged as the top risk during planning and then *assumed* to fit. It didn't — by
64×. Verification step two should have been the measurement, before anything
depended on it.

**Build the kill switch before the loop.** An autonomous loop with a live quota
meter and no brake is the one genuinely bad outcome. `DAILY_NEURON_BUDGET` records
exact spend per UTC day and halts at the limit — and every path was closed,
including the debug endpoint and the cron watchdog, both of which initially bypassed
it.

**Never deploy while a run is in flight.** Cheap rule, learned expensively.

**Use each tool for what it's good at.** Not "which wins" — this:

> **Use Claude Code to design and validate the brief. Use the loop to execute it,
> repeatedly, unattended.**

Claude Code caught the bot-blocked sources and the Accenture error. The loop found
PsiQuantum's $179.2M DARPA contract and South Australia's OpenAI partnership,
neither of which Claude Code surfaced. Different strengths.

---

## 7. Closing Summary

**What I'd repeat.** Validating every source through the real pipeline before
committing. Writing measured numbers with their source URLs, so they can be
re-checked when the platform moves. Recording bugs as *symptoms* rather than
diffs — most of these were silent, and the symptom is what you'll recognise next
time.

**What I'd avoid.** Trusting an architectural assumption because no documentation
contradicts it. Deploying mid-run. Treating a spend guard as done before checking
every path that can reach the model.

**What I'd change.** Measure the scariest limit first. Test retrieval across two
items, never one. Put the cost of every option in the comparison table from the
start — the missing $10 quietly inverted my conclusion.

**Advice for others.** If you're building an autonomous agent on Cloudflare:
Workflows' durable execution is the reason to do it, `step.sleep` is the reason it
can be cheap, and the free tier is real *if* you avoid HTML. But budget your time
for the running, not the writing. The code took a session. The bugs took the rest —
and every single one came from watching it actually run.

---

*Full engineering notes, measured constraints, the 12-bug log and the raw benchmark
data are in the repo.*

---

## 8. Addendum — session 2, 2026-08-11

Six more bugs (#13–#18), and the pattern behind them is worth more than the fixes.

### The prompt rewrite was the one change with no evidence. Now it has some.

Re-running the identical payload with only the prompt changed is the cheapest
experiment in this whole project — ~1,950 neurons, about two cents — and it settled a
question that had been sitting open. The rewrite fixed the goal-4 substitution
failure: asked about four cities, the old prompt answered about a fifth state; the new
one returns **Unanswered** and names the gap. That is a smaller-sounding win than it
is. An unattended loop that answers the wrong question is worse than one that reports
a gap, because the wrong answer looks like output.

It also *introduced* a regression, which is the honest half of the result: the report
began citing `[3]`, `[10]` — iteration indices, not sources — because the new prompt
demanded a URL the payload never contained. A prompt that asks for a field you did not
supply does not fail. It produces a confident substitute.

### Three limits, one shape

Bug #1 was "subrequests are per invocation, not per step." Bug #15 turned out to be
CPU, and bug #17 was neuron accounting. All three had the same structure: **a limit
that a working system was already exceeding, hidden by variance.**

HTML ingest cost 20–241 ms CPU against a ceiling between 11 ms and 20 ms — and it
*worked* for 40+ iterations across four runs before killing one. The repo had already
recorded the same page measuring 229/594/644 ms across runs. That variance was the
warning, and it was filed as noise rather than as proximity to a ceiling.
**Intermittent success is not headroom.** If a limit is passed only most of the time,
it has not been measured.

The spend guard failed the same way, and worse, because it was the safety rail. It
metered the reasoning call exactly and left the report call, the recall embedding and
the embedding cost either estimated or uncounted — 21% low, so real usage crossed the
free allocation while `/usage` read 7,900 of 10,000. On a Paid plan that is the moment
billing starts. Every Workers AI response hands you exact `usage.neurons`; three call
sites threw it away in favour of arithmetic. **A guard tested only against the number
it computes itself will always pass.**

### Fixes that passed their own tests and left the bug next door

Three times, a verified fix left an identical defect one branch away:

- Bug #8 closed a zombie `status='running'` row on the create-failure path. The
  `dryRun` branch three lines below created the same zombie by design — and the
  watchdog resurrects that shape after two hours, so a throwaway test would have
  launched itself as a real run (#18).
- Bug #12 added URL normalisation and applied it to model proposals only. Seeds stayed
  verbatim, so the `UNIQUE` constraint compared two canonical forms that could never
  collide (#14).
- The spend guard, above.

Each fix was tested against its reproduction and passed. The lesson is to state the
**invariant** — *no row sits in `running` without an instance*, *every URL in this
table is canonical*, *every AI call is metered* — and then check every writer to it.
Now CLAUDE.md §9.

### The research briefs were blocked on sources, not on the agent

Both briefs got a clean standalone run, and both results were about source access.
NZ executed perfectly and answered almost nothing: 91% of its chunks came from two
Wikipedia country articles that were never cited, because the bodies holding the real
NZ startup data are all JS-rendered. AU needs a Paid plan, because the one source
carrying the company data is 348 KB of HTML.

Two of the seeds turned out to be **redirects** — both "Science and technology in X"
Wikipedia URLs point at the country articles, so the brief's confident "35,112 ch / 29
chunks" measured the wrong document, and that 1.84 MB page is what killed a run.
Validating every source through the real pipeline caught the bot-blocked half of the
seed list. It did not catch a source that fetches perfectly and is about something
else. **Extractability and relevance are two separate checks, and passing the first
one loudly hides the second.**

### What I got wrong in this session

Worth recording, since the point of this file is the process rather than the code.
I diagnosed the CPU failure as per-invocation accumulation — bug #1's pattern — and
said so before measuring; `wrangler tail` showed it was per-page cost instead. I filed
bug #14's root cause as "no normalisation" when `normalizeUrl()` existed and was
half-applied, and claimed `recentFindings()` already selected `source_url` when it did
not. And I deployed during a live run *after* running the check, because the check
printed its result and the deploy was chained with `&&`. Nothing broke, by luck.
**Observing a blocker and proceeding is worse than never checking, because the log
line looks like diligence.**

The corrections are all in `bugs.md`. Every one of them came from the same place as
the bugs: reading the code or the measurement instead of trusting the last thing I
wrote down.

---

## 9. Addendum — session 3, 2026-08-12

Two verifications, four bugs, and one uncomfortable pattern that only became visible
because the verifications were run at all.

### The guard was wrong three times, and each fix passed its own test

Session 2 closed bug #17 — the spend guard reading 21% low — and recorded it as
fixed. It was not. Reconciling `/usage` against Cloudflare's own analytics found two
further defects behind it:

| | What it did | How wrong |
|---|---|---|
| #17 | estimated embeddings, omitted the report call and the recall embed | 21% low |
| #19 | summed exact figures at *step* end, while Cloudflare bills every retried attempt | lost every retry |
| #21 | read `usage.neurons` on embeddings, which do not return that field | 100% low on embeddings |

Each fix was more principled than the one before. #17 replaced arithmetic with
measurement, exactly as the repo's own rules demand. #19 fixed *when* the measurement
was recorded. #21 was the one that mattered most and was invisible to every previous
check, because `res.usage?.neurons ?? 0` makes *unknown* and *free* the same number.

The generalisable form, now CLAUDE.md §10: **a default that fails quiet cannot raise
an alarm.** The three fixes were all improvements and all shipped a fresh silent
undercount, because none of them asked whether the field being read existed for the
model being called.

### The only test that worked was the external one

Three rounds of code review — including one explicitly hunting for "a fourth leak" —
found the two extra call sites but never questioned the field itself. What found it
was one command comparing our number to Cloudflare's:

```
reasoning  75.39326477050781  vs  75.39326477050781   exact, 14 dp
embedding  0                  vs  1.203904999782      -100%
```

The split by `modelId` is what made it legible: had the totals been compared alone,
a 1.57% gap would have looked like rounding. **Reconcile per-component, not in
aggregate — an exact match on one component and a total failure on another sum to
something that looks like noise.**

Worth stating plainly: the user asked for this reconciliation specifically, and
flagged a fourth leak as "a live possibility rather than a formality." That framing
was correct and the code review was not.

### Assertions in docs are load-bearing, and this one cost a run

The verification was scheduled for 00:05 UTC because `HANDOFF.md` said the allocation
"resets at UTC midnight." Nobody had measured it. The run fired on time, with our
meter reading 0 for the new day, and was refused; a probe six minutes later
succeeded. The allocation is not a calendar day (#20) — hourly data shows the only
sum reaching 10,000 spans the previous midnight.

This is the third time in this project a **sentence in a document**, not a line of
code, was the defect — after the README's subrequest justification (#1) and its CPU
claim (#15). The habit that replaced it: **probe the condition, don't trust the
clock.** The retry script now tests for capacity instead of waiting for a time.

### What a passing test cannot tell you

The verification run confirmed #13 and call-site coverage. It was structurally
incapable of testing #19's retry accounting, because a run with no retries never
exercises the path. Saying so at the time mattered more than the pass did — a green
result on a test that cannot fail is the same shape as the bug it was meant to catch.

### What I got wrong in this session

- I stated the analytics/enforcement gap was "two counters that genuinely disagree,"
  having re-queried 75 minutes apart and seen no movement. The hourly breakdown
  showed a rolling-window mismatch instead. The evidence I had was consistent with
  both; I picked one and asserted it.
- I misread the 4006 cutoff as 20:16Z when it was 04:15Z, which made the window
  hypothesis harder to see for longer than it needed to be.
- I deployed a config change at 00:05:16Z while a scheduled run fired at 00:05:53Z.
  The gate passed honestly — nothing *was* running — but it only checks for work in
  flight, not work armed to start seconds later. It landed safely by ~37 seconds, by
  luck rather than design. **A gate that cannot see the thing about to happen is not
  a gate for that thing.**
- I claimed the 1,841 neurons/M rate "reproduces Cloudflare's figure exactly" from a
  check that was circular — the token count was itself derived from the rate. The
  honest validation came later, from an independent 9-token call.

---

## 10. Addendum — session 4, 2026-08-13

The session began by **reading the first unattended run instead of building on it**.
That choice is the whole session: nothing on the plan would have found either bug.

### A citation surface fails in more ways than one

Bug #13 (session 2) stopped the report citing iteration numbers as if they were
sources, and it held — every URL in every report since has been real. Bug #22 is what
was left: a real URL, correctly formatted, attached to a fetch that **returned
nothing**. The failing seed 403'd, the reasoning step ran anyway on recalled memory,
and the finding was stamped with the URL that had just failed. Two runs later that
attribution reached the final report as a citation under a specific dollar figure.

Three failure modes on one surface, found one at a time:

| | What was wrong | Fixed by |
|---|---|---|
| #12 | the URL did not exist | `normalizeUrl()` + grounding |
| #13 | the citation was an iteration number | `SOURCE:` line in the prompt |
| #22 | the URL was real but supplied none of the content | `contributedUrl = chunks > 0 ? url : null` |

Each fix was correct and none of them implied the next. **"The citation is real" and
"the citation is true" are different properties**, and only the second one is what a
research report is for.

Two details of the fix mattered more than the fix:

- **Keyed on `chunks`, not on `error`.** The incident was a 403, so an error-keyed
  guard would have passed its own repro and missed a 200 that yields zero chunks —
  the same invariant violated over a different dimension. That is precisely the trap
  #17→#19→#21 fell into three times.
- **Six sites, two paths.** Grepping the invariant rather than fixing the reported
  line found the D1 row, the Vectorize metadata, and the prompt's "JUST READ" header
  on *both* the workflow and `/step`. The vector one propagates: a false attribution
  written to memory is recalled into later iterations' prompts.

### A verification rule needs the instrumentation that makes it decisive

Session 3's lesson was *reconcile against the provider, not against yourself*, and it
was written into the handoff as a standing rule. The next time it was applied it
produced a 0.24% aggregate delta and two competing explanations — because the rule
says *compare per model* and our ledger had no model column (#23). The rule was
adopted; the data structure it depends on was never built.

That is a distinct failure from forgetting a lesson. **A habit that cannot return a
decisive answer degrades into a number you argue about**, and the argument is
comfortable because the number is small. The fix was one column and one changed
`INSERT`. The dangerous part was not the column but `neuronsToday()`, which read a
*single row*: against a per-model table it would have reported one model's spend as
the whole day's and let the guard authorise several times the budget. **Adding a
dimension to a table changes the meaning of every existing read of it.**

### Repetition is not replication

The same reasoning error three times in one session, twice on the same seed:

1. One in-run 403 → "the seed is bot-blocked," written into two documents as a
   property of the source and a recommendation to delete it.
2. Five probes returning 200 → "the 403 was transient." Those five were consecutive
   requests in one burst, down one connection, seconds apart — closer to *one*
   sample than five.
3. One late, sparse monitor → "it is not a liveness signal," recorded as a design
   verdict. The next run emitted all six events on time.

Every one of these treated correlated observations as independent evidence, and each
was stated with more confidence than the evidence carried. The honest statement about
the seed is still uncomfortable and still correct: **it fails in runs (0/3) and
succeeds in probe bursts (5/5), and nobody knows why.** Before quoting an n, state
what varied across the trials. Failures are the easier case to over-read, because
they arrive with an explanation already attached.

### The unattended run is the verification that counts

Both fixes were verified before deploying — #22 against a manufactured 404 seed, #23
against a hand-built `/step` exercise. Both passed. Then the 16:00Z daily run
exercised them **against the original incident, unprompted**: the same seed 403'd for
the third time, iteration 3 recorded `source_url = null`, and the report cited it
nowhere — the $248.5bn figure now attributed to the two sources that actually supplied
it. The per-model reconciliation came back exact on reasoning and +0.0091% on
embeddings, the published-rate rounding for the fourth time at a fourth scale.

A manufactured test proves the code does what you wrote. **The unattended run is the
only thing that proves you fixed the thing that happened.**

### What a clean run still cannot prove

Three reconciliations in a row have now been of runs where nothing failed after an AI
call returned, so **#19's retry accounting is exactly as untested as it was two
sessions ago** — while the accumulating PASSes make the meter feel proven. Testing it
means deliberately failing a step after its AI call. Worth saying every time, because
a green result on a test that cannot fail is the same shape as the bug it was meant to
catch.

### What I got wrong in this session

- Called a seed bot-blocked from one observation, then over-corrected from a probe
  burst, then generalised a monitor design verdict from one bad run. Same error, three
  times, in a session whose whole subject was over-reading single samples.
- Reported the daily run's cost as ~930 neurons when 929.49 was the day's *reasoning*
  total across all runs — the isolation the number implied did not exist until #23 was
  fixed later that day.
- Broke a poll loop on the first sign of movement in the analytics and printed a
  confident `FAIL`. "Stops moving" means every series stable across two consecutive
  reads, not "something changed."
- Kept treating the refreshed RSS feed as a confound to be apologised for across three
  runs, when three-for-three it was the finding: on this source profile, **the seeds
  that pay are the ones that change**.

---

## 11. Addendum — session 5, 2026-08-17

Read four unattended daily runs before touching anything, which is the habit that keeps
paying. The headline is that **the previous session's central claim was wrong, and wrong
in a way three consecutive runs could not have exposed.**

### "The live feed is the mechanism" was one level too coarse

Session 4 wrote into three documents that the daily improvement tracked
`startupdaily.net/feed` refreshing overnight — three for three, "stop treating it as
noise." Then goal 1 went **Answered → Unanswered** and stayed there for three runs.

The feed had not changed. Its newest item was dated 2026-08-14 06:50Z and it published
nothing for the next three days, so `b099c83d`, `dc0a0b39` and `8772de4e` read
byte-identical material — and that material still contained Farmbot, CUREator+ and Alloy
Robotics, the three specifics whose disappearance looked like the feed moving on.

What actually moved was a six-chunk prefix (bugs.md #24). RSS is newest-first, so
`pieces.slice(0, 6)` is a newest-N window; four posts arriving in 24 hours pushed the
agtech/biotech evidence past character 7,600 of 13,162. **A feed refreshing does not add
evidence, it evicts evidence** — and an e-bike story evicts as effectively as a funding
round.

The correlation was real. The causal story attached to it was backwards in the way that
matters: it credited *arrival* when the operative event was *eviction*, and it turned a
liability into a recommendation. "The seeds that pay are the ones that change" is false
as written; what pays is a seed whose *visible window* is on-topic, and high churn makes
that worse, not better.

### Three runs of agreement were one observation

This is §11 (repetition is not replication) landing on a claim I had already been careful
about. The three improving runs were not three trials of "does refresh cause movement" —
the feed refreshed in all three, so nothing varied. The frozen feed supplied the missing
cell of the table for free: same sources, three days, verdicts identical and findings
verbatim identical. Internal variance at `temperature: 0.4` is near zero; the pipeline is
effectively a deterministic function of its visible window. That single control cell said
more than the three positive runs combined, and it existed only because nobody posted for
three days.

### What the reconciliation taught, again

UTC 2026-08-14 reconciled per model to **0.000000000** on reasoning and +0.00905% on
embeddings, 20/20 calls. The predicted "small unexplained excess on Cloudflare's side"
from three out-of-band probes was **not there** — the probes had landed on UTC 08-13,
because they were made on the morning of the 14th *NZST*. Two lessons, both cheap:

- A hand-recorded date is a local-time claim until proven otherwise, and this project
  meters, budgets and reconciles in UTC.
- `bge-m3` returns **no usage object** and Cloudflare still bills it (0.007522115 in
  analytics). Unmeterable by us is not unbilled — which strengthens its disqualification
  rather than softening it.

The +0.00905% embedding bias reproduced on three separate days with three different token
totals. That is genuine replication — the trials differ — where the four "scales" quoted
in session 4 were one signature seen four times.

### What I got wrong in this session

- **Ran an eight-sample experiment that tested nothing** (bugs.md #26). Three config
  channels failed to bind silently and a stale server held the port; the control arm had
  n=8 and the treatment n=0, and every number looked clean. The tell that broke it was
  two arms billing the identical neuron figure — cost identity as a manipulation check.
  Now CLAUDE.md §12.
- **Got the process diagnosis wrong twice and the cleanup wrong three times.** The
  original write-up said `TaskStop` killed the parents and orphaned their children; the
  truth is `TaskStop` failed to kill **6 of 8** parents, and killing the children
  returned SUCCESS on all eight while the parents respawned them in seconds. Then
  `Get-NetTCPConnection` reported 2 owning processes where `netstat` showed 8, and I
  declared the ports clean with six servers still live. Only re-verifying — which I was
  asked to do, not prompted by any suspicion of my own — caught it. Three kill
  operations reported SUCCESS while the thing carried on: **a tool's success message
  describes a syscall, not the world.**
- **Probed a candidate source from the wrong machine.** `techboard.com.au/feed` returns a
  Cloudflare challenge to a local curl and clean RSS to the Worker — the exact inverse of
  `innovationaus.com/feed`, and a reminder that the probe rule specifies *through the
  Worker* for a reason.
- Left `"FRESH_EXCERPTS": "11"` in `wrangler.jsonc` during the experiment. Harmless because
  nothing was deployed, but it is precisely the shape of §7.1's near-miss, and it only
  stayed harmless because the deploy gate is a habit rather than a reminder.

---

## 12. Addendum — sessions 6-9, 2026-08-18 to 2026-08-20

Four sessions in which the loop stopped trying to answer a research question and started
tracking change, because the evidence said it could never do the first one.

### The brief was the bug

Eight production runs, and goal 1 ("which sectors, and which are growing fastest") scored
Unanswered / Partial / Answered / Unanswered x3 / Partial x2. Goal 2 was **Partial six
runs running** and never once reached Answered.

The reflex reading is that the loop is weak. The actual cause was visible in the goal text
the whole time:

| clause | kind of answer | outcome |
|---|---|---|
| "most active investors in Australian AI" | distribution | never answered |
| "typical stages" | distribution | never answered |
| "notable recent rounds" | instance | answered every run |

**A goal that mixes two tiers cannot be scored by either.** Every loop success across
eight runs was an instance — a named company, a dollar figure, a URL. Every failure was an
aggregate. Six Partials in a row was not a research result; it was the brief describing
two jobs and grading them as one.

So the brief split (`benchmark/AU-BRIEF-DECISION.md`): Claude Code writes a monthly
**baseline** of distributions; the loop runs daily and reports **deltas** against it. This
is CLAUDE.md §8 — fast expensive path to design and validate, slow cheap path to execute
repeatedly — applied to the brief itself, which was the one place it had never been
applied.

**Churn inverts under this design.** Session 6 concluded that "churn against a fixed
window is a liability", which was true *while the loop re-derived its answer daily*.
Startup Daily holds 10 items and replaced 9 of them in 43 hours; under re-derivation that
destroyed a verdict (bugs.md #24). Under capture-to-ledger it is simply five events a day
arriving on schedule, and eviction stops mattering because nothing needs to still be there
tomorrow.

### Identity is not similarity

Change detection needed a second kind of memory, and the first instinct — persist the
Vectorize index across runs — was wrong. Recall's top-8 answers *"what is related to
this?"*. The question is *"have I already reported this?"*, which is **identity**: a
`UNIQUE(key)` row and `ON CONFLICT DO NOTHING`. A similarity index cannot answer it — two
reports of one round score high against each other, and so do two different rounds by the
same investor. Cheaper and more correct, which is a rarer combination than it sounds.

Keying it took two attempts, and the second was decided by measurement rather than by
argument. `company + stage` was the intuition; the first live run showed **stage present on
2 of 4 rows and amount on 4 of 4** (#27). A key on a field that is usually absent collapses
every stageless round by one company into one row *and* splits a round the moment a second
source happens to say "Seed".

### The model cannot be asked to know what it was never told

Three defects in this stretch share one shape. On the first delta run the model re-offered
an event it had just been shown under `ALREADY RECORDED`; the `UNIQUE` constraint rejected
the row, and the finding still described it (#28). Only the insert knows what was novel,
and no prompt can convey that.

The fix was structural, not textual: the report's "New events" section is now rendered from
`eventsForRun()` in code, and the model is handed the answer rather than asked for it. The
same move settled #25 — attribution moved from a URL the model writes to an `[S1]` marker
the server resolves, which is `selectNextSources`'s trust model generalised. **Fabrication
made impossible by construction beats fabrication forbidden by instruction**, and by this
point instruction had lost on this surface three times.

### "None" and "never measured" were the same word

`control.baseline` was the empty string for both delta runs, so the report printed
`Divergence from baseline: None.` — which reads as *checked and clean* and meant *nothing
to check against* (#30). Worse, a run producing no findings at all still emitted it.

This is §10 exactly, moved out of the spend guard and into the deliverable. `?? 0` made
"unmeasurable" and "free" the same number; an empty baseline made "not measured" and
"clean" the same word. **Neither can ever raise an alarm.** The §10 test — name the case
where this reads wrong without failing — has the same answer both times: every case.

### The gap was in the plan, not in the extractor

The most useful thing in these four sessions was a workstream that got cancelled.

Session 7 deferred the baseline pass with a reason that sounded rigorous: the ledger's
stage and investor coverage was 2 of 4 rows, so B2 ("most active investors") was "not
comparable yet", and extraction should be improved first. Then the baseline pass ran and
found that **no source ranks Australian investors by deal count** — not Cut Through
Venture, across its entire published catalogue. The ranked lists that surface in search are
aggregator pages whose counts cite nothing.

At 4-of-4 extraction coverage there would still have been nothing on the other side of the
comparison. The diagnosis had pointed at the side that was cheap to inspect.

**Before building the thing that produces one side of a comparison, fetch the other side.**
One search would have cancelled a planned workstream. This is §5 aimed at your own brief,
which is the one source that never gets probed because it does not look like a source.

B2 is now recorded in the baseline as **NOT MEASURED**, with an explicit instruction not to
flag investor divergence. Filling it from what was available would have reproduced #30 one
section over — a number that cannot raise an alarm, sitting where a measurement should be.

### What a baseline has to do that a summary does not

It has to be **diverged from**, and that imposes rules a prose write-up escapes:

- **Shares, not only dollars.** Quarters differ in size. AI models and data infrastructure
  went $100M to $730M across Q1 to Q2 2026, which is 5.6% to 42.6% *of the quarter*. The
  second pair is what a single daily event can contradict.
- **Constructed numbers labelled as constructed.** The round-size bounds are one-third to
  three times a published median, because no source publishes ranges; Q4 2025 is a
  subtraction carrying about $400M of error because three different CY2025 totals
  circulate. Unlabelled, both read as measurements within a month.
- **Coverage limits stated inline.** Q1 2026's sector list is a top ten summing to $1.63B
  of a stated $1.8B, so "not listed" means *below $76M*, not zero. A baseline that omitted
  this would manufacture a divergence every week, and every one would look real.

### What I got wrong in this stretch

- **Added a source on shape and never on content** (#29). `smartcompany.com.au/feed`
  extracts perfectly — 18,718 characters — and carries no funding events at all: a Google
  Drive outage, an Easter public holiday, AirPods, a store opening. The loop correctly
  reported "nothing new" and was right; the source was wrong. §5 verbatim, one session
  after §5 was written down.
- **Deferred the baseline pass twice with a reason that was the wrong diagnosis** — see
  above. It sounded like rigour and was measured from the wrong side.
- **Nearly wrote a migration that reimplemented the key it migrated to.** A migration that
  reimplements its target key agrees with itself and disagrees with production; it imports
  the Worker's own `eventKey` instead.
- **Lost the test suite to a cleared scratchpad** between sessions and had to rewrite it.
  Tests that live outside the repo are not tests. `npm test` — 40 assertions — is now in
  the repo.

---

## 13. Addendum — session 10, 2026-08-20

Three items, and the middle one is the one worth keeping: the thing that was broken was
the instrument, not the system.

### The limitation you wrote down is still a defect

`0 16 * * *` was the daily cron, and every place it appeared carried a comment saying
Cron Triggers are UTC only and this drifts to 05:00 NZDT in September. Three files agreed
about it. Nobody fixed it, because writing the caveat felt like handling it.

Six weeks out, that is a run happening at the wrong hour for six months while the README
insists on 04:00. The fix is two arms — `0 15` and `0 16` both registered, both firing —
and a gate that starts a run only on the arm that is 04:00 in `Pacific/Auckland` for the
instant scheduled. Simulating a year gives 365 distinct local days, all at 04:00.

**A documented limitation is a defect with a comment attached.** The test: if the comment
were deleted, would this read as a bug? Then it is one.

### The reader was the thing that was broken

The baseline in D1 was reported here as mojibake — `â€"` for every em dash, the arrows in
its own figures mangled — against a committed file that hashed to `d18d6d14…`. It was
wrong. `json.load(sys.stdin)` decodes with the **locale** codec, cp1252 on this machine,
and stored UTF-8 came back corrupted every single time it was read.

Two tells were available before the diagnosis and both were skipped:

- the "corrupt" character count was **exactly the byte count** of the correct file — two
  numbers that should never match, matching;
- after a re-post the Worker acknowledged as `chars: 6434`, the same read *still* reported
  6,501 mojibake chars. A value provably correct at the source, read as damaged.

§12 said to report the effective setting from inside the code path rather than from the
launcher, and I applied it to the Worker while treating my own `curl | python` as neutral.
It is not neutral. It is a second witness with a locale in its path, and it fails by
producing plausible wrong output instead of an error. **Distrust the witness that has a
locale in it, and re-read before believing damage.**

The cost was small — a no-op re-post and a wrong paragraph, corrected in the same session.
The lesson is not "use UTF-8". It is that a confident bug report about stored data is a
claim about a read, and the read is testable.

### A guard tested with the credential always passes

Every write endpoint was open: `POST /start`, `/stop`, `/baseline`, `/step` took no
credential, and the only thing between them and the internet was that the URL was
gitignored. That framing is what kept it alive — the risk was filed as "the URL must not
leak", so the fix was a `.gitignore` entry rather than a gate.

Two things worth carrying:

- **The protected set is "writes or spends", not "is a POST".** `GET /search` mutates
  nothing and bills neurons, because `recall` embeds the query — the same call site the
  spend guard missed in bugs.md #17. Naming the invariant as a *verb list* rather than a
  *method list* is what catches it.
- **An unset secret must deny, and that is the case you cannot test with the secret set.**
  So it was tested by deploying the code *before* creating the secret: production returned
  401 to a correct client token. Every other test — no header, wrong token, correct token
  plus one character — was run afterwards, and none of them would have caught a fail-open
  default.

§7 says test the kill switch by triggering it. The deploy-before-the-secret ordering is
that rule applied to a credential: arrange for the failure you are worried about, in
production, before anything depends on it not happening.

### What I got wrong in this stretch

- **Reported a data corruption that did not exist**, in detail, with the mangled figures
  quoted. Two independent tells were in the output before the claim was written.
- **Left the bug-log index stale at #26** while adding entries through #30 — the index is
  the only part of that file anyone reads first.
- **Nearly shipped the DST gate on wall-clock hour**, which cannot be tested except at
  04:00. Keying it on the UTC offset instead made it testable at any hour, for both
  regimes, and that is the only reason the year-long simulation exists.
