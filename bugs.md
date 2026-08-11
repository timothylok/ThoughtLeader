# Bug log

Every bug found while building and benchmarking the research loop, 2026-08-11.
All were found by **running the system**, not by review — several were invisible
while broken, which is why the "How it showed up" column matters more than the fix.

| # | Bug | Severity | Status |
|---|---|---|---|
| [1](#bug-1--subrequest-budget-is-per-invocation-not-per-step) | Subrequest budget is per invocation, not per step | 🔴 Fatal | Fixed |
| [2](#bug-2--vector-ids-keyed-on-iteration-counter-destroyed-data) | Vector IDs keyed on iteration counter destroyed data | 🔴 Silent data loss | Fixed |
| [3](#bug-3--non-idempotent-step-write-duplicated-rows-on-retry) | Non-idempotent step write duplicated rows on retry | 🟠 Data integrity | Fixed |
| [4](#bug-4--deploy-mid-run-marked-a-healthy-run-failed) | Deploy mid-run marked a healthy run failed | 🟠 False state | Fixed |
| [5](#bug-5--recall-cannot-see-what-the-same-iteration-just-wrote) | Recall cannot see what the same iteration just wrote | 🟠 Design flaw | Fixed |
| [6](#bug-6--workers-ai-response-is-string-or-object) | Workers AI `response` is string *or* object | 🟠 Crash | Fixed |
| [7](#bug-7--numberv--fallback-discarded-a-legitimate-0) | `Number(v) \|\| fallback` discarded a legitimate `0` | 🟠 Inverted config | Fixed |
| [8](#bug-8--failed-workflow-creation-left-a-zombie-run) | Failed workflow creation left a zombie run | 🟡 Latent spend | Fixed |
| [9](#bug-9--catch-all-in-ingest-made-the-retry-policy-dead-code) | Catch-all in ingest made the retry policy dead code | 🟡 Resilience | Fixed |
| [10](#bug-10--step-spent-neurons-without-metering-them) | `/step` spent neurons without metering them | 🟡 Guard bypass | Fixed |
| [11](#bug-11--navigation-boilerplate-was-being-embedded) | Navigation boilerplate was being embedded | 🟡 Quality/cost | Fixed |
| [12](#bug-12--model-invented-non-existent-source-urls) | Model invented non-existent source URLs | 🟡 Quality | **Fixed & measured** |

---

## Bug 1 — Subrequest budget is per invocation, not per step

**Severity:** 🔴 Fatal · **Status:** Fixed

**How it showed up.** Benchmark run `19ac529b` died at iteration 11 of 12 after 27
minutes with no final report:

```
Last successful step: reason:11
Error: Too many subrequests by single Worker invocation
Attempts: 6 (all identical)
```

**Root cause.** Cloudflare's subrequest cap (50 free) applies **per Worker
invocation**, not per `step.do`. A resumed Workflow instance accumulates
subrequests across iterations within one invocation.

**Why it survived review.** I assumed each step got a fresh execution context and
wrote that assumption into `README.md` as justification: *"1 fetch + ~4 binding
calls per iteration — fine by design."* No doc directly contradicts it, so the
assumption stood until a long run disproved it.

**Fix.** `ITERATIONS_PER_GEN` 100 → 8 (`wrangler.jsonc`). Each trampoline
generation is a new instance and therefore a fresh subrequest budget.

**Lesson.** Never size a long-running Workflow against per-step cost. When a loop
fails *only after many iterations*, suspect accumulation before suspecting the
step that reported the error.

---

## Bug 2 — Vector IDs keyed on iteration counter destroyed data

**Severity:** 🔴 Silent data loss · **Status:** Fixed

**How it showed up.** A two-source retrieval test: ingest source A, ingest source
B, then search for a phrase unique to A. **Only B's chunks came back.** The
relational store showed correct chunk counts for both (7 and 20), and no error was
raised anywhere.

**Root cause.** Vector IDs were `${runId}:${type}:${n}:${i}` where `n` is the
iteration counter. A failed iteration does not advance the counter, so the next
attempt reused `n` — and `upsert` overwrote source A's vectors with source B's.

**Fix.** Key chunks by **stable source id** (`chunkKey(sourceId, i)`), findings by
iteration (`findingKey(n)`) — `src/memory.ts`.

**Lesson.** Counters look unique but are only unique per *successful* iteration.
Upsert then destroys data with no error. **A single-item retrieval test cannot
detect this** — always test across two distinct ingested items.

---

## Bug 3 — Non-idempotent step write duplicated rows on retry

**Severity:** 🟠 Data integrity · **Status:** Fixed

**How it showed up.** Run `19ac529b` recorded **16 findings for 11 iterations** —
6 rows for iteration 11 alone.

**Root cause.** The `record` step inserted a finding, then failed on a later
subrequest (Bug 1). Each of 6 retries re-ran the insert.

**Fix.** `UNIQUE(run_id, n)` index + `INSERT … ON CONFLICT DO UPDATE`
(`schema.sql`, `src/db.ts`). Existing duplicates deduped: 16 → 11.

**Why it survived review.** Cloudflare's *Rules of Workflows* states this exactly
— *"Non-idempotent API/Binding calls are always done after checking if the
operation is still needed"* — and it is **quoted in this repo's own README**. The
rule was known, documented, and still violated at the write site.

**Lesson.** Treat every write inside a step as if it will run 3+ times. Partial
step execution is the normal case, not an edge case.

---

## Bug 4 — Deploy mid-run marked a healthy run failed

**Severity:** 🟠 False state · **Status:** Fixed

**How it showed up.** Deployed the `/live` route while a run was in flight. The
run showed `status=failed`, `reason="Durable Object reset because its code was
updated"` — while `wrangler workflows instances describe` showed the instance
**still Running** and progressing normally. The dashboard lied.

**Root cause.** A deploy resets the Durable Object backing an in-flight instance.
Workflows resumes from the last successful step, but the catch-all in `run()` had
already written a terminal status.

**Fix.** `isTransient()` in `src/workflow.ts` filters
`Durable Object reset|code was updated|internal error|network connection lost`
before calling `failRun()`.

**Operational rule.** **Never `wrangler deploy` while a run is in flight.** Check
`/state` or `wrangler workflows instances list` first.

---

## Bug 5 — Recall cannot see what the same iteration just wrote

**Severity:** 🟠 Design flaw · **Status:** Fixed

**How it showed up.** Two consecutive iterations both reported `recalled=0`
despite 27 chunks being stored. Polling `/search` afterwards showed matches
appearing between **15 and 30 seconds** after write.

**Root cause.** Vectorize inserts are asynchronous. A query issued in the same
iteration as its matching upsert returns nothing.

**Fix.** The current source's text is carried directly into the prompt via
`IngestResult.excerpts`; Vectorize supplies only *earlier* material
(`src/workflow.ts`, `src/prompt.ts`).

**Lesson.** In production the 18-minute pacing would have hidden this entirely —
the bug was only visible because `/step` fires iterations back-to-back. Fast
manual testing exposed a real architectural dependency that slow operation masks.

---

## Bug 6 — Workers AI `response` is string *or* object

**Severity:** 🟠 Crash · **Status:** Fixed

**How it showed up.** First real iteration died with
`TypeError: raw.trim is not a function`.

**Root cause.** `env.AI.run()` returns `response` as a **string** for prose but as
an **already-parsed object** when the model emits valid JSON — which this prompt
explicitly requests, so it failed on the first call rather than in an edge case.

**Fix.** `parseReasoning()` accepts `unknown` and branches on `typeof`
(`src/prompt.ts`).

**Bonus discovery.** Every response carries `usage.neurons` with exact spend.
Estimates were 25% low (126 estimated vs 160 measured) — this now feeds the spend
guard instead of arithmetic.

---

## Bug 7 — `Number(v) || fallback` discarded a legitimate `0`

**Severity:** 🟠 Inverted config · **Status:** Fixed

**How it showed up.** Set `MAX_SOURCE_DEPTH="0"` (documented as "seeds only") to
make a termination test deterministic. The loop **kept crawling** model-proposed
URLs and reached 4 sources from 1 seed.

**Root cause.** `Number("0") || 2` evaluates to `2`. The flag did the exact
opposite of its documentation. Present at **five** call sites.

**Fix.** `num()` in `src/types.ts`, falling back only on non-finite values.

**Lesson.** Config values of `0` almost always mean "off" — precisely the case the
`||` idiom breaks. Grep for `Number(...) ||` in any config-reading code.

---

## Bug 8 — Failed workflow creation left a zombie run

**Severity:** 🟡 Latent spend · **Status:** Fixed

**How it showed up.** `/state` listed two runs at `n=0/2` with `status=running`
that no one had successfully started.

**Root cause.** The database row is written before `LOOP.create()` (the first step
needs its sources). When creation failed, the row remained `running` with queued
sources — and the cron watchdog would resurrect it hours later as a run nobody
started.

**Fix.** `/start` wraps `LOOP.create()` and calls `failRun()` on failure,
returning HTTP 502 (`src/index.ts`).

---

## Bug 9 — Catch-all in ingest made the retry policy dead code

**Severity:** 🟡 Resilience · **Status:** Fixed

**How it showed up.** Found by reading my own first draft, not by failure.

**Root cause.** The ingest step declared `retries: { limit: 2 }` but wrapped its
entire body in a catch-all that swallowed every error and returned a "failed
source" result. Retries could never fire — a transient Workers AI blip would be
permanently recorded as a dead source.

**Fix.** Only the `fetch` is caught (a 404 is a fact about the source, not worth
retrying). Embedding and storage failures propagate so the retry policy works
(`src/workflow.ts`).

---

## Bug 10 — `/step` spent neurons without metering them

**Severity:** 🟡 Guard bypass · **Status:** Fixed

**How it showed up.** After adding `DAILY_NEURON_BUDGET`, running a full `/step`
iteration left `/usage` reporting `0`.

**Root cause.** The spend guard was wired into the workflow only. The debug
endpoint — exactly where quota gets burned during experimentation — was a blind
spot.

**Fix.** `/step` records its own `usage.neurons` and returns **HTTP 429** once the
budget is spent. The cron watchdog also checks the budget before restarting
anything (`src/index.ts`).

**Lesson.** A spend guard is only as good as its least-guarded path. Enumerate
every route that can call the model.

---

## Bug 11 — Navigation boilerplate was being embedded

**Severity:** 🟡 Quality/cost · **Status:** Fixed

**How it showed up.** The first extracted chunk of a Cloudflare blog post was
entirely a **language switcher** — "Deutsch, Español, Français, 日本語…".

**Root cause.** Language switchers and category menus live in bare `<li>`/`<p>`
outside any `<nav>`, so the element-removal selector missed them.

**Fix.** `denoise()` line filter in `src/ingest.ts` (keep lines ≥30 chars or
ending in sentence punctuation).

**Effect.** 22,164 → 8,699 chars and 18 → 7 chunks: a **61% reduction** in vectors
stored and embedding cost, with no loss of article text.

---

## Bug 12 — Model invented non-existent source URLs

**Severity:** 🟡 Quality · **Status:** **Fixed & measured** (run `2ff3e9c4`)

**How it showed up.** Run `19ac529b` grew from 9 seeds to **23 sources**. Of the
14 the model added, several do not exist or are defunct —
`australianstartup.org`, `australianinnovation.org`, `startupaus.org` (now the
Tech Council) — plus duplicate hostnames of existing seeds (`smallbizai.au/`,
`startmate.com/portfolio` without `www`).

**Impact.** Roughly **40% of the fetch budget** went to sources the model
invented. One full iteration was spent on a homepage whose own finding conceded it
*"does not offer specific insights into the Australian AI startup ecosystem."*

**Confirmed worse on rerun.** Left unfixed for run `0d5ed883` so the benchmark
isolated bugs #1–#4: 9 seeds became **27 sources**, 18 model-added, 15 still
pending at the iteration cap.

**Root cause.** `sanitizeUrls()` validated URL *syntax*, not existence.
`australianstartup.org` is syntactically perfect and does not exist. The deeper
problem is upstream: asking the model to "propose URLs worth reading next" makes
it generate from **parametric memory**, which is where fabrication lives.

**Fix — grounding, not filtering.**

1. `fetchSource()` harvests real `<a href>` links during the existing
   `HTMLRewriter` pass (capped at 120, resolved absolute) — **zero extra
   subrequests**, which matters because subrequests are what caused bug #1.
2. `selectNextSources()` intersects the model's proposals with links actually
   observed on a fetched page. Anything else is dropped and logged:
   `rejected ungrounded URLs: …`
3. `normalizeUrl()` canonicalises host/fragment/trailing-slash/tracking params,
   killing the `www` and trailing-slash duplicates.
4. `MAX_ADDED_SOURCES_PER_RUN = 10` as a backstop.

**Rejected alternatives.** `HEAD`-validating each proposal costs one subrequest
per URL — trading a quality bug for the fatal one (#1). A domain allowlist would
kill the loop's one genuine advantage (it found SmartCompany, Austrade, the
PsiQuantum DARPA contract and the South Australia/OpenAI partnership unprompted).

**Known limitation.** Plain-text and markdown sources contain no `<a href>`, so
they contribute no candidates and nothing is queued from those iterations. That is
the safe default, but the free-tier profile — which deliberately prefers `.md` and
`llms.txt` sources — gets little autonomous discovery as a result.

**Measured — run `2ff3e9c4`**, 3 iterations on HTML seeds, 249 neurons ($0.0027):

| Iteration | Source | Links seen | Proposed | Accepted | Rejected |
|---|---|---|---|---|---|
| 1 | startupdaily.net | 114 | 2 | **0** | 2 |
| 2 | startmate.com/portfolio | 120 | 2 | **0** | 2 |
| 3 | blackbird.vc/portfolio | 120 | 2 | **1** | 1 |

**6 proposed → 1 accepted (83% rejected).** Queue grew 3 seeds → 4 sources, versus
9 → 27 in run `0d5ed883`.

Verifying each rejected URL by hand:

| Rejected URL | Actually exists? | Verdict |
|---|---|---|
| `australianstartup.org` | ❌ **DNS failure** | ✅ correct — fabricated |
| `ausindustry.gov.au` | ❌ **DNS failure** | ✅ correct — fabricated |
| `startmate.com.au` | ✅ HTTP 200 | ⚠️ false positive (wrong TLD guess for `startmate.com`, real site, not linked) |
| `startmate.com/blog` | ✅ HTTP 200 | ⚠️ false positive — real, but not linked from the page read |
| `austrade.gov.au` | ✅ HTTP 200 | ⚠️ false positive — real, but not linked from the page read |
| `blackbird.vc/blog` (**accepted**) | ✅ HTTP 200 | ✅ correct — genuinely linked |

**Honest reading: 2 of 5 rejections were fabricated domains; 3 were real sites
that simply weren't linked from the page being read.** Grounding is therefore
*conservative*, not precise — it eliminates fabrication completely but also
discards real, potentially useful sources.

That trade is deliberate. A fabricated URL costs a wasted iteration plus a failed
fetch; a missed real URL costs only the discovery. But it does blunt the loop's
main advantage, so `MAX_SOURCE_DEPTH=0` versus grounding is now a genuine choice
rather than grounding being strictly better.
