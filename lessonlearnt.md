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
