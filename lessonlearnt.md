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
