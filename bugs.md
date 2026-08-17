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
| [13](#bug-13--report-cites-iteration-numbers-as-if-they-were-sources) | Report cites iteration numbers as if they were sources | 🟠 Traceability | ✅ **Fixed & verified** (run `d2cd8b42`) |
| [14](#bug-14--url-variants-bypass-dedupe-and-are-re-fetched) | URL variants bypass dedupe and are re-fetched | 🟡 Quality/cost | **Fixed & verified** |
| [15](#bug-15--large-html-ingest-is-over-the-cpu-limit-and-only-passed-on-burst-allowance) | Large HTML ingest is over the CPU limit and only passed on burst allowance | 🔴 Fatal (intermittent) | **Open** |
| [16](#bug-16--source-validation-confirmed-extractability-not-topic) | Source validation confirmed extractability, not topic | 🟠 Research quality | **Open** |
| [17](#bug-17--the-hard-spend-stop-undercounts-by-21-and-let-the-free-allocation-run-out) | The hard spend stop undercounts by ~21% and let the free allocation run out | 🔴 Guard failure | ⚠️ **Verified FAILED** — reasoning exact, embeddings still 0 (see #21) |
| [18](#bug-18--dryrun-leaves-a-run-the-watchdog-will-start-for-real) | `dryRun` leaves a run the watchdog will start for real | 🟠 Latent spend | **Fixed** |
| [19](#bug-19--the-meter-counts-steps-cloudflare-bills-attempts) | The meter counts steps; Cloudflare bills attempts | 🔴 Guard failure | Fixed, **unverified** |
| [20](#bug-20--daily_neuron_budget-resets-on-a-utc-day-cloudflares-allocation-does-not) | `DAILY_NEURON_BUDGET` resets on a UTC day; Cloudflare's allocation does not | 🟠 Guard shape | **Open** (mitigated) |
| [21](#bug-21--embeddings-return-no-neurons-field-so--0-meters-them-as-free) | Embeddings return no `neurons` field, so `?? 0` meters them as free | 🔴 Guard failure | **Fixed & measured** |
| [22](#bug-22--a-finding-is-attributed-to-a-source-that-returned-no-content) | A finding is attributed to a source that returned no content | 🔴 False attribution | ✅ **Fixed & verified** (`8ca445dd`) — and **confirmed in production** on daily run `5a8c9aeb` against the original incident |
| [23](#bug-23--the-usage-ledger-has-no-model-column-so-the-reconciliation-rule-cannot-be-run) | The usage ledger has no model column, so the reconciliation rule cannot be run | 🟡 Guard observability | ✅ **Fixed & verified** (`764f7709`) — **confirmed in production**: exact per-model match on run `5a8c9aeb` |
| [24](#bug-24--the-fresh-excerpt-window-is-a-newest-n-cut-and-it-destroyed-a-verdict) | The fresh-excerpt window is a newest-N cut, and it destroyed a verdict | 🔴 Silent research regression | **Fixed & measured** (0/8 → 3/3), uncommitted |
| [25](#bug-25--a-finding-is-attributed-to-a-source-that-supplied-none-of-its-content) | A finding is attributed to a source that supplied none of its content | 🔴 False attribution | **Open** — #22's invariant one branch away |
| [26](#bug-26--eight-samples-of-a-config-experiment-that-tested-nothing) | Eight samples of a config experiment that tested nothing | 🟠 Test validity | Diagnosed; practice added |

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

---

## Bug 13 — Report cites iteration numbers as if they were sources

**Severity:** 🟠 Traceability · **Status:** **Open** (found in run `76fb1813`)

**How it showed up.** The final report of run `76fb1813` cites claims as `[1]`,
`[3]`, `[5]`, `[6]`, `[10]` — with no legend anywhere in the document. Run
`0d5ed883`, on the *old* report prompt, printed full URLs inline
(`https://smallbizai.au/...`). The rewrite made citations look more scholarly and
made them **unresolvable**.

**Root cause.** Two changes met badly. `synthesise()` in `src/workflow.ts` builds
the findings payload as:

```ts
const body = findings.map((f) => `[${f.n}] ${f.finding}`).join('\n\n');
```

so the only bracketed identifiers the model can see are **iteration numbers**.
The rewritten `REPORT_SYSTEM` in `src/prompt.ts` then demands *"Cite the source
URL for each substantive claim."* No URL is present in the payload, so the model
cites the identifiers that are — and they point at iterations, not sources.

**Impact.** Every citation in the report is a dead reference. Resolving one means
cross-referencing `/state?run=` by hand. This is a **regression against the old
prompt**, and it partly undercuts the grounding work in bug #12: citations that
cannot be checked are not much better than citations that are wrong.

**Second, worse symptom — run `0f4fdd5c`.** With the same prompt, the NZ run's
report cited **full URLs** rather than `[n]`. Neither run's findings contain a URL
anywhere in their text, so those URLs were **reconstructed from entity names**, not
recalled from the payload. The tell: the report cites
`https://www.creativehq.co.nz/` when the actual source is `https://creativehq.co.nz/`
— the model invented the `www.`. So the same root cause produces either dead
references or **plausible fabricated ones**, and the fabricating symptom is more
dangerous because it looks correct and passes casual review.

**Fix (identified, not yet applied).** Carry the URL into the synthesis payload
so the model has something real to cite — `recentFindings()` already selects
`source_url`. Not deployed: a run was in flight, and deploying mid-run is bug #4.

**Lesson.** A prompt that demands a field the payload does not contain will not
produce an error. It produces a confident substitute.

---

## Bug 14 — URL variants bypass dedupe and are re-fetched

**Severity:** 🟡 Quality/cost · **Status:** **Open** (found in run `76fb1813`)

**How it showed up.** Run `76fb1813` fetched the same pages twice under URLs
differing only in punctuation:

| Seed | Model-added duplicate | Chunks each |
|---|---|---|
| `smallbizai.au/australian-ai-companies-...-2026/` | same URL **without** trailing slash | 41 |
| `www.startmate.com/portfolio` | `startmate.com/portfolio` (no `www.`) | 9 |
| `www.startupdaily.net/` | `startupdaily.net/` (no `www.`) | pending |
| `www.innovationaus.com/` | `innovationaus.com/` (no `www.`) | pending |

**Impact.** 3 of the 5 sources the model added were pages already in memory.
Roughly **25% of a 12-iteration fetch budget** went to re-reading known content,
and smallbizai alone stored **82 duplicate vectors** where 41 would do — inflating
recall competition as well as embedding cost.

**Root cause — normalisation is applied to one side of the comparison only.**
The pieces that should prevent this all exist:

- `normalizeUrl()` (`src/ingest.ts:42`) lowercases the host, strips a leading
  `www.`, drops the fragment and tracking params, and strips a trailing slash.
- `selectNextSources()` (`src/ingest.ts:225`) applies it to every model proposal.
- `sources` carries `UNIQUE (run_id, url)` (`schema.sql:28`) and `enqueueSources()`
  inserts with `INSERT OR IGNORE`.

But **seed URLs are never normalised.** `src/index.ts:143` filters
`body.sources` for strings and hands them to `createRun()` verbatim. So seeds are
stored as `https://www.startmate.com/portfolio` while proposals are canonicalised
to `https://startmate.com/portfolio`. The two forms are different strings, the
UNIQUE constraint cannot see the collision, and `INSERT OR IGNORE` dutifully
inserts. The dedupe machinery works perfectly on inputs that never meet.

**Fix (identified, not yet applied).** Normalise seeds through the same
`normalizeUrl()` at `/start`, so both sides of the UNIQUE constraint are in one
canonical form. No schema change needed.

**Correction to the bug #12 write-up.** That entry credits `normalizeUrl()` with
"killing the `www` and trailing-slash duplicates." It does — for proposals. The
claim is true of the function and false of the system, and run `76fb1813` produced
the exact duplicates the entry says were eliminated.

**Lesson.** Bug #12's own write-up listed *"duplicate hostnames of existing seeds"*
as a symptom and then shipped a fix that normalised only the new URLs. **A
canonicalisation applied to one side of a comparison is not a canonicalisation** —
and a fix verified against the half you changed will report success.

---

## Bug 15 — Large HTML ingest is over the CPU limit and only passed on burst allowance

**Severity:** 🔴 Fatal (intermittent) · **Status:** **Open** (found in run `98adcf63`)

**How it showed up.** Run `98adcf63` failed at `ingest:11` with
`Error: Worker exceeded CPU time limit.` — three attempts, 10 s and 20 s apart,
all identical. The page was
`en.wikipedia.org/wiki/Science_and_technology_in_New_Zealand`. Probing that exact
URL minutes earlier had **succeeded**, which is what made the failure look like
per-invocation accumulation (bug #1's pattern) rather than what it is.

**The measurement that settled it.** `wrangler tail --format json` reports
`cpuTime` per request. Probing five pages:

| Request | cpuTime | Outcome |
|---|---|---|
| `/step` probe — NZ Wikipedia (1.84 MB raw) | **241 ms** | ❌ `exceededCpu` |
| `/step` probe — 3 other large HTML pages | **20 ms** each | ❌ `exceededCpu` |
| `/step` probe — Callaghan (70 KB) | **11 ms** | ✅ ok |
| `/state`, `/usage` | 1–3 ms | ✅ ok |

The enforced ceiling sits **between 11 ms and 20 ms** — the Free plan's 10 ms CPU
limit. `smallbizai` fails here at 20 ms yet ingested cleanly at iteration 1 of run
`76fb1813`. The same page, either side of the limit, minutes apart.

**Root cause.** HTML extraction costs 20–241 ms CPU. The limit is 10 ms. Every
successful HTML ingest this project has performed was inside burst allowance, not
inside budget. `README` §4.2 already stated HTML ingest needs a Workers Paid plan;
the loop ran it anyway and *appeared* to work for 40+ iterations across four runs.

**Not accumulation.** gen-0 of the failing run completed 8 HTML iterations. The
per-page cost is what varies (~7× between pages), so `ITERATIONS_PER_GEN` is not
the lever — source selection is.

**Fix (identified).** Prefer plain-text sources. Wikipedia's `?action=raw`
endpoint returns `text/x-wiki` and parses in the ~1 ms class — and yields **more**
text than the HTML path (60,000 chars vs 42,826 for `Economy_of_New_Zealand`).
Small HTML pages (≤70 KB) stay within budget and need no change.

**Lesson.** **Intermittent success is not headroom.** A limit you pass most of the
time is a limit you have not measured. The repo already recorded that the same
page measured 229/594/644 ms across runs — that variance *was* the warning, and it
was read as noise rather than as proximity to a ceiling.

---

## Bug 16 — Source validation confirmed extractability, not topic

**Severity:** 🟠 Research quality · **Status:** **Open**

**How it showed up.** Chasing bug #15, `?action=raw` on
`Science_and_technology_in_New_Zealand` returned **95 characters**:

```
#REDIRECT [[New_Zealand#Science_and_technology]] {{Redirect category shell|
```

It is a **redirect**. The HTML path silently followed it and parsed the entire
**New Zealand country article** — 1.84 MB, the largest and most CPU-expensive page
in the set, and the direct cause of bug #15's failure.
`Science_and_technology_in_Australia` is the same: 46 chars of wikitext, redirecting
to the Australia article.

**Impact.** `AI_Research.md` §3 and §5 list both as science-and-technology sources
with confident extraction figures (35,951 ch / 29 chunks and 35,112 ch / 29
chunks). Those numbers are real but they measure **general country articles**. Two
of the 14 seeds were not what the brief said they were, and one of them broke a run.

**Root cause.** Validation asked *"does this URL return substantive extractable
text through the real pipeline?"* — the right question, and it passed. It did not
ask *"is the returned text about the topic claimed?"*

**Fix (identified).** When probing, check the extracted text against the source's
stated purpose, not just its length. `?action=raw` makes redirects visible in one
line, so probe the raw endpoint first even when ingesting HTML.

**Lesson.** CLAUDE.md §5 says to test every source through the actual pipeline.
That caught the bot-blocked half of the seed list. It did not catch a source that
works perfectly and is about something else. **Extractability and relevance are
two separate validations, and passing the first one loudly hides the second.**

---

## Bug 17 — The hard spend stop undercounts by ~21% and let the free allocation run out

**Severity:** 🔴 Guard failure · **Status:** ⚠️ **Fixed in part — verification FAILED
2026-08-12.** The reasoning path now meters exactly; the embedding path still records
nothing. See [bug #21](#bug-21--embeddings-return-no-neurons-field-so--0-meters-them-as-free).

**How it showed up.** A 1-iteration verification run failed immediately:

```
AiError: 4006: you have used up your daily free allocation of 10,000 neurons
```

`GET /usage` at that moment reported **7,900.76 neurons across 54 calls** against a
`DAILY_NEURON_BUDGET` of 10,000. The loop believed it had 2,099 neurons of headroom
while Cloudflare had already cut it off. **The only hard stop in the system was
reading 21% low.**

**Root cause — three leaks, all of them avoidable.** `addNeurons()` is called in
exactly two places (`workflow.ts:201`, `index.ts:334`) and counts
`reasoning.neurons + chunks * 0.64`:

| AI call | Metered |
|---|---|
| Reasoning — `workflow.ts:161` | ✅ exact, from `usage.neurons` |
| Embedding — `memory.ts:36` | ⚠️ **estimated** at `chunks * 0.64` |
| Recall query embedding, one per iteration | ❌ **never counted** |
| Report synthesis — `workflow.ts:282`, `max_tokens: 1200` | ❌ **never counted** |

The report call is the largest single generation in a run and is completely
invisible to the meter. `recall()` embeds a query every iteration and is likewise
invisible. And `memory.ts:36` *receives* a real `usage.neurons` from every embed
call — the callers throw it away and substitute arithmetic that this repo had
already measured as 25% low.

**Impact.** `DAILY_NEURON_BUDGET` was deliberately set equal to the 10,000-neuron
free allocation so that a Workers Paid account would never pay for Workers AI. Because
the meter undercounts, **actual usage crossed the free allocation while the guard
read 79%** — on Paid, that is the exact moment billing starts. The guard did not
merely mis-report; it failed at its one job.

**Fix (applied).** `embed()` now returns `{ vectors, neurons }` from the response's
own `usage.neurons`; `remember()` and `recall()` propagate it; `synthesise()`
returns its neurons and the `report` step meters them. All arithmetic is gone.
Audited every `AI.run` call site in the codebase:

| Call site | Metered at |
|---|---|
| `memory.ts:45` embed | returned to every caller |
| `workflow.ts:167` reason | `workflow.ts:208`, with ingest + recall + remember |
| `workflow.ts:299` synthesise | `workflow.ts:252` |
| `index.ts:341` `/step` reason | `index.ts:363`, with all embeds |
| `index.ts:251` `{"ai":…}` debug probe | `index.ts:257` — **was leaking too** |
| `/search` query embed | `index.ts:232` — **was leaking too** |

The audit found two further unmetered call sites beyond the three that caused the
failure. The `probe` path spends nothing (no AI call), so the ~20 source probes run
during the bug #15 investigation were genuinely free.

**Verification pending.** The fix cannot be confirmed until the allocation resets at
UTC midnight: the test is to run a full iteration and reconcile `/usage` against the
Cloudflare-side figure. Until that comparison is done this is *believed* fixed, which
is exactly the status that let the original bug through.

**Lesson.** CLAUDE.md §6 says *prefer measured values to arithmetic*, and §7 says
*build and verify the kill switch before the thing it stops*. Both were followed for
the reasoning path and quietly abandoned for the other three call sites. **A guard
tested only against the number it computes itself will always pass.** The test that
would have caught this is comparing `/usage` to the Cloudflare-side figure — which
is precisely what bug #10's fix was supposed to make unnecessary.

---

## Bug 18 — `dryRun` leaves a run the watchdog will start for real

**Severity:** 🟠 Latent spend · **Status:** **Fixed**

**How it showed up.** A `dryRun` smoke test for bug #14 left run `de733a13` sitting at
`status='running'`, 0/1 iterations, 1 source pending — with **no workflow instance
behind it** (`wrangler workflows instances list` shows no `run-de733a13-gen-0`).

**Root cause.** `/start` creates the run row, then skips `LOOP.create()` when
`dryRun` is set, and never marks the row terminal. The watchdog in `scheduled()`
selects on exactly that shape:

```sql
SELECT ... FROM runs WHERE status = 'running' AND updated_at < <now - 2h>
```

with `pendingSourceCount > 0` and `iterations < max_iterations`. **Two hours after
any dry run, the watchdog would launch it as a real run and spend neurons on a
throwaway test.** `POST /stop` does not help: it sets a flag read at the next
assess step, and there is no instance to read it.

**Root cause, restated less kindly.** The comment directly above the `dryRun`
branch already describes this exact failure —

> *"if instance creation then fails, that row is a zombie: status='running' with
> work queued, which the watchdog would resurrect hours later into a run nobody
> started. Fail it closed instead."*

Bug #8 fixed that for the *create-failure* path and left the `dryRun` path,
three lines away, producing the same zombie by design.

**Fix.** `finishRun(env.DB, runId, 'stopped', null)` on the `dryRun` branch, so a
dry run ends terminal and the watchdog ignores it.

**Lesson.** Bug #8's fix was verified against the path that had failed, not against
the invariant it was protecting. The invariant is *"no row may sit in `running`
without an instance"* — and checking that invariant across all writers would have
found this immediately. **Fix the invariant, not the incident.**

---

## Bug 19 — The meter counts steps; Cloudflare bills attempts

**Severity:** 🔴 Guard failure · **Status:** **Fixed, verification pending**
(found 2026-08-11 auditing bug #17's fix, before that fix had ever run)

**How it showed up.** Not from a run — from asking what bug #17's audit had actually
checked. That audit enumerated *which* `AI.run` sites were metered and closed all
five. It never asked *when* they were metered. Both surviving leaks live in the gap
between the AI call returning and the step committing.

**Root cause.** `step.do` re-executes its **entire closure** on retry, and
**Cloudflare bills every attempt**. Metering at the end of a step therefore records
only the final, successful attempt and silently discards every earlier one that
reached the AI call and then failed further down. Three open windows:

| Step | Retries | Billed but never recorded |
|---|---|---|
| `ingest:${n}` | 2 | `remember()` embeds, then `VECTORIZE.upsert` / `markSourceResult` throws |
| `record:${n}` | default | `remember()` embeds, then `enqueueSources` / `addedSourceCount` throws |
| `report:${gen}` | default | `synthesise()` runs at `max_tokens: 1200` — the largest call in a run — then `finishRun` throws |

**This is not hypothetical.** `schema.sql` already records that `record:11` in run
`19ac529b` produced **six** finding rows, because the closure ran six times
(bug #3). Six finding embeds were billed that iteration; at most one was metered.
The provider figures agree: on UTC 2026-08-11 Cloudflare counted **60** reasoning
calls against **54** `addNeurons` writes.

**Why bug #17's fix could not catch it.** #17 replaced arithmetic with
`usage.neurons` and aggregated the iteration's total in one write at the end of
`record`. That is a correct sum of a run with no retries — and a run with no retries
is exactly what a verification run is. **A clean run cannot test this.**

**Fix (applied, version `19c44a8a`).** Every `AI.run` records its own spend the
moment it returns, in its own write, before any other work in the step — including
before `embed()`'s own `!res.data.length` guard throws, since that call was billed
too. No caller aggregates. `assess` reads the committed total with `neuronsToday()`
instead of carrying one through the iteration.

| Call site | Metered at |
|---|---|
| `memory.ts:46` embed (all embed traffic, via `remember` + `recall`) | `memory.ts:55` |
| `workflow.ts:168` reason | `workflow.ts:176` |
| `workflow.ts:308` synthesise | `workflow.ts:322` |
| `index.ts:349` `/step` reason | `index.ts:363` |
| `index.ts:259` `{"ai":…}` debug probe | `index.ts:265` (already immediate) |

Metering before the retry looks like double-counting and is not: the retried call
was billed as well, so recording each attempt is what matches the invoice. **The
step-end aggregate was the bug.**

**Cost of the fix.** One extra D1 write per AI call — roughly three more
subrequests per iteration against the free plan's 50-per-invocation budget
(bug #1). `ITERATIONS_PER_GEN` stays at 8; the run that died on subrequests died at
n=11, so the margin narrows but holds.

**Side effect worth having.** `usage.calls` now increments once per AI call rather
than once per iteration, so it is directly comparable to `count` in Cloudflare's
`aiInferenceAdaptiveGroups` dataset. The 60-vs-54 discrepancy above becomes a
standing check rather than a one-off observation.

**Verification.** Same run as #13 and #17, plus the call-count comparison. Note what
it can and cannot show: on a clean run the meter should match Cloudflare **exactly**,
which proves call-site coverage and nothing about retry accounting. The retry path is
only testable by forcing a step to fail after its AI call.

**Lesson.** Bug #17's lesson was *meter every call*. That was the incident. The
invariant is **every billed call is recorded before anything else can fail** — and
#17's own fix violated it at three sites while closing five. Four bugs in this log
(#8→#18, #12→#14, #17→#19) are now the same shape: a fix verified against the path
that failed, leaving the identical defect one branch away. CLAUDE.md §9.

---

## Bug 20 — `DAILY_NEURON_BUDGET` resets on a UTC day; Cloudflare's allocation does not

**Severity:** 🟠 Guard shape · **Status:** **Open** (mitigated, not fixed) ·
found 2026-08-12 by a verification run that failed on a fresh UTC day

**How it showed up.** The bug #13/#17/#19 verification was armed for 00:05 UTC on the
theory — written into `HANDOFF.md` as fact — that the free allocation *"resets at UTC
midnight"*. It fired on time, `/usage` correctly read **0 neurons for 2026-08-12**,
and the run died anyway:

```
AiError: 4006: you have used up your daily free allocation of 10,000 neurons
```

Six minutes later, at 00:11Z, a probe embed **succeeded**. Nothing was deployed or
changed in between.

**What the hourly data shows.** `aiInferenceAdaptiveGroups` grouped by
`datetimeHour`, cumulative from first use:

| Hour (UTC) | Neurons | Calls | Cumulative |
|---|---|---|---|
| 2026-08-10T23:00 | 1,617.2 | 71 | 1,617 |
| 2026-08-11T00:00 | 1,882.5 | 55 | 3,500 |
| 2026-08-11T01:00 | 2,144.3 | 61 | 5,644 |
| 2026-08-11T03:00 | 4,392.6 | 105 | **10,037** |
| 2026-08-11T04:00 | 251.4 | 9 | 10,288 |

Calendar-day Aug 11 totals **8,670.8** — comfortably under 10,000 — yet enforcement
refused calls at ~04:15Z that day. **The only sum that reaches 10,000 is one that
crosses the UTC-midnight boundary and includes Aug 10's 23:00Z hour.**

**Best-supported explanation: a rolling ~24-hour window, not a calendar day.** It
accounts for both observations — the 04:15Z Aug 11 cutoff (trailing 24h = 10,288)
and the recovery between 00:05Z and 00:11Z Aug 12 (the 00:05–00:11 slice of Aug 11's
busy 00:00 hour ages out, dropping the trailing total back under the line). Not
proven: that would need minute-level data. What *is* proven is the negative — the
allocation is not a UTC calendar day, and analytics' per-day figure is not the number
enforcement uses.

**Why this matters beyond a failed test.** `addNeurons()`/`neuronsToday()` key on
`utcDay()`. At 00:00Z the guard resets to 0 and believes it has a full 8,000-neuron
budget while Cloudflare may still be holding most of a 24-hour window against the
account. The guard and the thing it is guarding **are measured over different
windows**, so the guard can authorise spending that the platform refuses. On the free
plan that costs a run; on Paid, where nothing refuses anything, it is the difference
between the free allocation and a bill.

**Mitigation applied.** `DAILY_NEURON_BUDGET` 10000 → **8000**, which buys headroom
against the mismatch but does not correct the shape.

**Real fix (not applied).** Meter over a trailing 24-hour window rather than a
calendar day — the `usage` table would need per-call or per-hour rows instead of one
row per day, and `neuronsToday()` becomes `neuronsInTrailing24h()`. Deferred: it is a
schema change, and the mitigation holds for one daily run of ~2,400 neurons.

**Lesson.** `HANDOFF.md` asserted the reset time as a fact and the verification was
scheduled against it; the assertion had never been measured. This is CLAUDE.md §6
exactly — *never let an assumption become a justification in the docs* — and it is
the second time in this project that a sentence in a doc, not a line of code, was
the defect. The fix habit is the probe that replaced the schedule: **test the
condition, don't trust the clock.**

---

## Bug 21 — Embeddings return no `neurons` field, so `?? 0` meters them as free

**Severity:** 🔴 Guard failure · **Status:** **Fixed & measured** · found 2026-08-12 by the
reconciliation that was supposed to close bug #17

**How it showed up.** The verification run `d2cd8b42` — one iteration, one small
source — reconciled against Cloudflare:

| | `/usage` | Cloudflare | Delta |
|---|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 75.39326477050781 | 75.39326477050781 | **exact, to 14 dp** |
| `@cf/baai/bge-small-en-v1.5` | **0** | 1.203904999782 | **−100%** |
| total | 75.393 | 76.597 | −1.57% |
| calls | 6 | 9 | −3 |

The call gap is correct and expected: three embed attempts were refused with `4006`
during bug #20, cost 0 neurons, and recorded 0. The **neuron** gap is the bug.

**Root cause.** The two models return different `usage` shapes. Queried directly
against the REST API:

```
@cf/baai/bge-small-en-v1.5    usage = {prompt_tokens, completion_tokens, total_tokens}
@cf/meta/llama-3.3-70b-...    usage = {prompt_tokens, …, neurons: 1.3963143825531006}
```

**Embedding responses carry no `neurons` field at all.** `res.usage?.neurons ?? 0` in
`memory.ts` therefore records exactly zero for every embed, forever, without error.

**Why bug #17's fix asserted the opposite.** #17's entry states *"`embed()` now
returns `{ vectors, neurons }` from the response's own `usage.neurons`"* and *"All
arithmetic is gone."* The first half is true and the second half is why it fails:
removing the (bad) arithmetic without checking that the replacement field **exists**
swapped a 25%-low estimate for a 100%-low measurement. The repo's own memory note
— *"Workers AI response shape varies"* — was about `response`, and the same lesson
was not carried to `usage`.

**Impact.** Embeddings were 529.50 of 8,670.74 neurons on UTC 2026-08-11 — **6.1%**
of spend. The guard is systematically ~6% low. Smaller than the original 21%, and
worse in one respect: it is silent, permanent, and sits behind a fix that was
recorded as complete.

**Fix applied 2026-08-12, version `a39be94e`.** A single `meterCall(db, model, usage)`
in `db.ts` is now the only way spend enters the ledger, and all five `AI.run` sites
route through it; `addNeurons` is no longer exported. It resolves cost in strict
order:

1. `usage.neurons` when the provider supplies it (text generation),
2. else `total_tokens × rate/1e6` for a model in
   `EMBEDDING_NEURONS_PER_M_INPUT_TOKENS`,
3. else **`console.error` naming the model and its usage block**, then 0.

Only embedding models belong in the rate table — text-generation models price input
and output tokens differently, so a single input-token constant would be wrong for
them, and a text model that stopped returning `neurons` must shout rather than be
quietly mispriced.

**Independent validation of the rate.** A direct REST embed with exactly
`prompt_tokens: 9` was attributed **0.016567499997** neurons by Cloudflare;
`9 × 1841/1e6 = 0.016569`. That implies an effective rate of 1,840.83 against a
published 1,841 — the published figure is rounded, and the residual error is
**0.009%**. This check is independent of the earlier 287,613-token consistency
check, which was circular (the token count was itself derived from the rate).

**Live confirmation.** One `/search` embed after the fix: the meter moved by
**0.014728** neurons where it had previously moved by exactly 0.

**Superseded proposal.** Cloudflare publishes **1,841 neurons per million
input tokens** for `bge-small-en-v1.5`. The provider still returns an exact
`total_tokens`, so the cost is `total_tokens * 1841 / 1e6` — the provider's own
measurement times the provider's own published rate, not a guess at token counts
like the `chunks * 0.64` this replaced. Consistency check: 529.4954 neurons ÷
(1841/1e6) = 287,613 tokens over 170 calls = ~1,692 tokens/call, which is the right
size for batched chunk embedding.

**The real defect is `?? 0`.** It converts *unknown* into *free* — the single most
dangerous default a spend guard can have. Any model whose cost cannot be determined
must be **loud**, never silently zero. The rate constant must be keyed by model id,
and an unknown model with no `neurons` field must log an error rather than record 0.

**Lesson.** CLAUDE.md §7 says *meter from the provider's own usage field, never from
arithmetic*, and §6 says *prefer measured values*. Both were followed literally and
still produced a 100% undercount, because **nobody checked that the field being read
exists**. The reconciliation against the provider — the one test #17's own lesson
identified as necessary — is what caught it, on the first run it was ever performed.
Three fixes to this guard have now each passed their own repro (#10, #17, #19); only
the external comparison found the truth.

---

### Qualified 2026-08-14 — it is per *model*, not per model class

This bug's title over-generalises, and the correction belongs next to it. Probing
every embedding model on the free tier, one call each:

| model | dims | `usage` returned |
|---|---|---|
| `@cf/baai/bge-small-en-v1.5` (ours) | 384 | tokens, **no `neurons`** |
| `@cf/baai/bge-m3` | 1024 | **`null` — no usage object at all** |
| `@cf/qwen/qwen3-embedding-0.6b` | 1024 | tokens **and `neurons`** |

So *some* embedding models do return the field. More useful for the guard: **`bge-m3`
is strictly worse than the model this bug was about.** With no usage object at all it
can be priced from neither `neurons` nor `total_tokens`, so adopting it would meter as
0 regardless of what the rate table says. It is 42% cheaper than ours (1,075 vs 1,841
neurons/M) and a stronger retrieval model, and it is unusable here for exactly the
reason §10 exists.

`@cf/qwen/qwen3-embedding-0.6b` is the same price as `bge-m3` and **does** return
`neurons`, which would let `priceCall` drop its embedding rate table entirely and make
this bug's whole class impossible rather than merely fixed. Blocked on dimension: 1024
against a 384-dim Vectorize index, which is fixed at creation. See `HANDOFF.md`
→ *Start here*, item 2.

**The meta-point.** #21's fix was written from one model's behaviour, and the
*correction* to it was then generalised to "embeddings do not return `neurons`" — one
level down, the same error. Print the raw response of **each** model you call.


---

## Bug 22 — A finding is attributed to a source that returned no content

**Severity:** 🔴 False attribution · **Status:** **Fixed & verified** (`8ca445dd`),
**confirmed in production** on daily run `5a8c9aeb` · found 2026-08-13 reading the first
unattended daily run `4306b012`

**How it showed up.** Iteration 3 claimed `https://innovationaus.com/feed` as its
source and reported a specific figure:

> *"The technology sector in Australia is the fastest-growing productivity engine,
> contributing $248.5 billion (8.9% of GDP)…"* — `source_url: https://innovationaus.com/feed`

That source **failed**: `HTTP 403`, `chunks: 0`. It contributed no text to the run.
The same $248.5bn figure appears again at iteration 5, attributed to
`Economy_of_Australia`, which was fetched **two iterations later**.

**What is actually wrong.** The iteration's `source_url` is the URL claimed from the
queue, and it is written onto the finding regardless of whether the fetch produced
anything. When ingest yields nothing the reasoning step still runs — on recalled
memory from previous iterations — and the resulting finding is stamped with the URL
that failed. The content is not necessarily fabricated (the figure is plausibly real
and recalled from the Tech Council feed read at iteration 2), but the **attribution
is wrong**, and it is wrong in the direction that looks like evidence.

This is bug #13's neighbour, not a regression of it. #13 made citations real URLs
from the `SOURCE:` line, and that still holds — every URL in this report is real.
#13 fixed *what a citation points at*; it did not establish that the thing it points
at **contributed anything**.

**Invariant to close:** *a finding's `source_url` yielded at least one chunk.*
Every writer to `recordFinding` needs checking, not just the workflow path —
`/step` in `index.ts` writes findings too (CLAUDE.md §9).

**Candidate fixes (none applied).** Either skip the reasoning step entirely when
`chunks === 0` and mark the iteration as a fetch failure, or let it run on recall
but record `source_url = null` / an explicit `recall-only` marker so the report
cannot present it as sourced. The second is probably right — the recall is doing
useful work; only the attribution is false.

**The 403 was transient — corrected 2026-08-13.** The first reading of this run
recorded the seed as bot-blocked and recommended removing it. Probing it through the
Worker's own ingest path (`POST /step {"probe": …}`) **five times returned 200 with
15,660 bytes / 13 chunks every time**, in 8–14 ms. All five seeds fetch. Nothing was
removed.

That correction makes this bug **more** important, not less. A permanently blocked
seed fails once and gets deleted; a seed that fails intermittently keeps producing
zero-chunk iterations, and every one of them mints a finding attributed to a source
that contributed nothing. This will recur.

**The method note is the real lesson.** "Bot-blocked" was inferred from a single
observation inside a run and written into two documents as a property of the source.
One command through the actual pipeline disproved it. CLAUDE.md §6 — *re-measure
rather than extrapolate from one sample* — applies to failures exactly as it does to
timings, and a failure is the easier one to over-read, because it arrives with an
explanation attached.

### Escalated 2026-08-13 — reproduced on run `9174a7bc`, and it reaches the report

Severity raised from 🟠 Traceability to 🔴 **False attribution**. The same seed 403'd
again with 0 chunks, at the same position, and finding #3 was again stamped with its
URL. This run shows the consequence arriving in the deliverable:

> The Australian technology sector contributes $248.5 billion (8.9% of GDP)…
> **(https://innovationaus.com/feed)**

That is in the **final report**, citing a source that returned nothing on that run.
It is not bug #12 (the URL is real and was genuinely queued) and not bug #13 (the
citation is a URL, not an iteration number). It is a third failure mode on the same
surface: **a real URL, correctly formatted, attributed to content it did not
supply.** For a research loop the report is the product, so this is now a defect in
the output, not in bookkeeping.

Counted properly the failure is **not intermittent in the place that matters**:
0 of 2 in real runs, at iteration 3 both times.

### The probe method was wrong too — corrected again

The "transient, not blocked" finding above rested on five probes returning 200. Those
were **five consecutive requests in a single burst** — one connection, one colo,
seconds apart — which is close to *one* independent sample, not five. Re-stated
honestly: the source **fails in runs (0/2) and succeeds in probe bursts (5/5)**.
Neither "bot-blocked" nor "transient" is established, and the difference between the
two contexts is now the thing to investigate — not the source's status.

**Lesson, third pass on the same seed.** The first reading over-read one failure as a
property. The correction over-read one burst as five samples. Both errors have the
same shape: *treating correlated observations as independent evidence.* Repetition is
not replication unless something between the trials actually changed — a different
connection, a different time of day, a different code path. Before quoting an
n-of-5, state what varied across the five.

### Fixed & verified 2026-08-13, version `8ca445dd`

**Invariant closed:** *a finding's `source_url` names a source that contributed at
least one chunk to that iteration.*

Grepping every writer to it found the defect in **six** places across two paths, not
the one that was reported:

| Path | Site | Was |
|---|---|---|
| workflow | `recordFinding` | `ingested.url` unconditionally |
| workflow | finding vector `sourceUrl` | `ingested.url ?? ''` |
| workflow | `buildPrompt` "JUST READ" | `ingested.error ? null : ingested.url` |
| `/step` | `recordFinding` | `source.url` unconditionally |
| `/step` | finding vector `sourceUrl` | `source.url` |
| `/step` | `buildPrompt` "JUST READ" | `ingestError ? null : source.url` |

All six now derive from one value per path — `contributedUrl = chunks > 0 ? url :
null`.

**Keyed on `chunks`, not on `error`.** The reported incident was a 403, so an
`error`-keyed guard would have passed its repro — and missed a fetch that returns
200 and yields zero chunks (empty body, nothing left after boilerplate stripping).
That is the same invariant violated over a different dimension, which is the trap
#17→#19→#21 fell into three times (CLAUDE.md §9).

**The finding vector mattered as much as the row.** Recalled excerpts carry their
`sourceUrl` into later iterations' prompts, so a false attribution written to
Vectorize propagates forward instead of staying in one D1 row.

**The report side was part of the invariant, not extra scope.** Fixing only the
table would leave the report free to invent an attribution for a null-source
finding, which is where the damage actually lands. The `SOURCE:` placeholder is now
`NONE — synthesised from earlier material; do NOT cite a URL for this finding`.

**Verification** — a run seeded with exactly one dead URL
(`…title=ZZQQ_No_Such_Page_For_Bug22&action=raw`, HTTP 404):

- **`/step` writer** (`63ac5d92`): fetch failed, `chunks=0`, finding row written with
  `source_url = NULL`. **PASS**
- **workflow writer** (`797a52f2`, real 1-iteration run): `sources: failed chunks=0`,
  finding `source_url = null`, and the report **cited no URL** — *"synthesised from
  earlier material and does not have a URL to cite"*. **PASS**

**What this verification cannot prove.** It exercised only the *fetch-error* route to
zero chunks. The 200-with-zero-chunks branch is closed by construction — both paths
read `chunks`, and nothing else writes these fields — but it was **not exercised**,
because no seed on hand produces it. Nor did it test the retry path: `record:n` can
re-run, and the upsert overwrites `source_url` with the same derived value, so a
retry is idempotent by inspection rather than by test.

**Cosmetic, not filed.** In this degenerate run (one source, zero chunks, a
meta-goal) the report echoed the literal string `SOURCE: NONE` into its prose. Harmless
where there is nothing to cite; worth a look if it shows up in a real mixed run.

**Incidental confirmation.** A stray `POST /start` during this work hit a genuine
`workflow create failed: Error: internal error` (`b063f5e2`) and was correctly closed
as `failed` with 0 iterations — **#8 and #18 holding under a real failure**, not a
simulated one.

### Confirmed in production 2026-08-13 — daily run `5a8c9aeb`

The verification above used a **manufactured** dead URL (a 404 Wikipedia title) in a
degenerate one-source run. The unattended 16:00Z daily run then exercised the same fix
against the **original incident**, unprompted:

`innovationaus.com/feed` 403'd for the third consecutive real run, and:

| n | `source_url` |
|---|---|
| 1 | `https://startupdaily.net/feed` |
| 2 | `https://techcouncil.com.au/feed` |
| **3** | **`null`** |
| 4 | `…title=Australia&action=raw` |
| 5 | `…title=Economy_of_Australia&action=raw` |

**The report contains no citation to `innovationaus.com/feed`.** The $248.5bn figure —
the exact claim that was falsely attributed to it on `4306b012` and again on
`9174a7bc` — is now cited to the two Wikipedia sources that actually supplied it. The
defect closed on the same sentence that exposed it, in the deliverable, with nobody
watching.

Note also that the `SOURCE: NONE` echo flagged as cosmetic above **did not appear** in
this real mixed run — it was an artefact of a report with nothing else to write about.

**And the seed's status is now 0/3 in runs.** The escalation note above said the gap
between run-failures and probe-successes "is now the thing to investigate." It still
is; three for three is no longer comfortably called intermittent. But the fix means
that investigation is a **source-quality** question, not a correctness one — a
zero-chunk fetch can no longer contaminate the report while it stays unresolved. That
is the difference between an open bug and an open decision.

---

## Bug 23 — The `usage` ledger has no model column, so the reconciliation rule cannot be run

**Severity:** 🟡 Guard observability · **Status:** **Fixed & verified** (`764f7709`),
**confirmed in production** on daily run `5a8c9aeb` · found 2026-08-13 reconciling run
`4306b012`

**How it showed up.** The post-run reconciliation for UTC 2026-08-12:

| | Neurons | Calls |
|---|---|---|
| `/usage` (ours) | 1079.800795738281 | 32 |
| Cloudflare — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 929.4913461208344 | 11 |
| Cloudflare — `@cf/baai/bge-small-en-v1.5` | 152.91250247231102 | 26 |
| **Cloudflare total** | **1082.4038485931454** | **37** |
| **Delta** | **−2.6031 (0.24% low)** | **−5** |

The 5-call gap is the expected benign shape: run `04fc1149` was refused with `4006`
at ~00:05Z, and refused calls appear in Cloudflare's `count` while costing nothing
and correctly recording nothing (same as #21's 3-call gap).

**The 2.6031 neurons are not explained by refusals**, and there are at least two
explanations that fit:

1. **Account-wide spend our ledger cannot see.** The #21 investigation made direct
   REST calls to both models on this same UTC day, bypassing the Worker entirely —
   one llama probe alone is recorded in #21 as `neurons: 1.3963143825531006`, and a
   direct embed as `0.016567499997`. Cloudflare's figure is account-wide; ours is
   Worker-wide. These are *supposed* to differ.
2. **Our embedding rate is slightly low.** Embeddings are the only category still
   priced by our own arithmetic (`db.ts` — `total_tokens × 1841 / 1e6`). 2.6031 is
   **1.70% of Cloudflare's embedding total**, which is the right order for a rate
   constant being marginally off.

**The bug is that these cannot be told apart.** `usage` is `(day, neurons, calls)`
with no model column, so our side cannot be split the way Cloudflare's is.
`HANDOFF.md` rule 3 says *"compare per model, not in aggregate — an exact match on
reasoning plus a 100% miss on embeddings sums to something that looks like noise"* —
and that rule is currently **unexecutable against our own ledger**. Explanation 1 is
benign and explanation 2 is #21's successor; a 0.24% aggregate delta is exactly the
shape that would hide either one.

**Fix (not applied).** Add `model` to the `usage` table and group by
`(day, model)` — `meterCall` already receives the model id and is the single
writer, so this is a schema change plus one changed `INSERT`, and it makes the
per-model comparison a query instead of an inference. Worth doing together with
#20's per-hour rows, since both are the same `usage` schema change.

**Lesson.** #21's lesson was *reconcile against the provider, not against yourself*.
That was adopted as a rule and written into the handoff — but the data structure it
depends on was never built, so the second time the rule was applied it could only
produce an aggregate number and a hypothesis. **A verification habit needs the
instrumentation that makes it decisive, or it degrades into a number you have to
argue about.** The direction of the error is still the one that matters: low.

### Resolved by circumstance 2026-08-13 — clean run `9174a7bc`

Run `9174a7bc` had the account entirely to itself (04:47–06:00Z, no REST probes, no
refusals), which is the clean-room case the 2026-08-12 reconciliation lacked:

| | Neurons | Calls |
|---|---|---|
| Ours | 990.3514279829101 | 20 |
| Cloudflare — llama-3.3-70b | 840.8383 | 6 |
| Cloudflare — bge-small-en-v1.5 | 149.4996 | 14 |
| **Cloudflare total** | **990.3379** | **20** |
| **Delta** | **+0.0135 (+0.0014%, HIGH)** | **0** |

**Call counts match exactly**, and 6 reasoning calls is precisely 5 iterations + 1
report — `meterCall()` coverage under load is confirmed.

**The residual is accounted for to the neuron.** #21 measured the published rate
1,841 against Cloudflare's effective 1,840.83, a 0.009% overstatement. Applied to
149.4996 embedding neurons that predicts **0.0138**; observed **0.0135**.

**This settles the −2.6031 from 2026-08-12** in favour of explanation 1. A low
embedding rate is **disproven** — the rate is fractionally *high*, and a 1.7%
shortfall would have shown up here as ≈2.5 neurons low rather than 0.0135 high. The
earlier gap was the out-of-band REST probes from the #21 investigation, which spend
on the account and never touch our ledger.

**The bug stays open.** Nothing was fixed — the ambiguity was resolved by the
accident of an empty window, which is not a property anything guarantees. The next
reconciliation that overlaps a probe, a `/search`, or a second run is back to an
aggregate and a hypothesis. Add the model column.


### Fixed & verified 2026-08-13, version `764f7709`

`usage` is now one row per **(day, model)** instead of one per day:

```sql
CREATE TABLE usage (
  day TEXT NOT NULL, model TEXT NOT NULL,
  neurons REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);
```

`meterCall` already had the model id and is the single writer, so `addNeurons`
took one extra argument. `GET /usage` gained a `byModel` block (and an optional
`?day=`), which is the shape `aiInferenceAdaptiveGroups` reports — the two sides
can now be compared like for like.

**The dangerous part was not the column, it was `neuronsToday`.** It read
`SELECT neurons FROM usage WHERE day = ?` — a *single row*. Against a per-model
table that returns whichever model SQLite happens to hand back first, so the guard
would have reported one model's spend as the whole day's and authorised several
times the budget. It is now `COALESCE(SUM(neurons), 0)`. Every read of the table
was audited, not just the one the bug named: `neuronsToday` (SUM), `usageHistory`
(GROUP BY day), `usageByModel` (new).

**Migration.** Old rows carry the literal model `(pre-#23: model not recorded)`
rather than being assigned to a model or dropped — an honest unknown, per §10.
Totals were captured before and after: **10037.851645107545 neurons / 113 calls on
both sides, identical to the last digit.**

Order matters and there is an unavoidable window: the migrated schema breaks the old
code's `ON CONFLICT(day)`, and the new code breaks against the old schema. Migrate
then deploy back to back, with nothing running — verified no run in flight before
each half, ~6 h clear of the daily cron.

**Verification — a real per-model reconciliation, which is the thing that was
impossible before.** Baseline both sides, spend on both models via `/step`, compare
the deltas:

| model | CF delta | ours | diff | calls |
|---|---|---|---|---|
| `llama-3.3-70b-instruct-fp8-fast` | 129.2331 | 129.2331 | **0.0000** | 1/1 |
| `bge-small-en-v1.5` | 11.3690 | 11.3700 | +0.0010 | 3/3 |

Neurons and call counts match per model. The +0.0010 on embeddings is +0.0088%,
which is the published-rate rounding #21 measured (0.009%) — the same signature
seen at every scale so far.

**A flaw in the verification itself, worth more than the fix.** The first attempt
compared against analytics that had only partly landed and printed `FAIL`: the
poll broke out as soon as *any* model's count moved, showing llama at 0 while bge
was mid-flight. The memory note says *re-query until the figure stops moving* — and
"stops moving" means **every series stable across two consecutive reads**, not
"something changed." Polling to first movement produces a confident wrong answer,
in whichever direction the lag happens to fall.

**Not fixed, and not attempted:** #20's window shape. The trailing-24h fix needs
per-*hour* rows, and this migration deliberately did not add them — it would have
meant changing what the guard measures at the same time as changing where it stores
it, and those want separate verification. The table is now easier to extend that way.

**What this does not prove.** Only two models were exercised, both already known to
`priceCall`. A model with no entry in the rate table still routes to the loud
`console.error` path from #21; that branch remains untested here.

### Confirmed in production 2026-08-13 — daily run `5a8c9aeb`

The verification above was a hand-built `/step` exercise. The unattended daily run is
the first reconciliation of a **real** 5-iteration workload done the way rule 3 always
said it should be — per model, as a query rather than an inference:

| model | Cloudflare | ours | diff | calls |
|---|---|---|---|---|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 994.9426 | 994.9426 | **0.0000** | 7/7 |
| `@cf/baai/bge-small-en-v1.5` | 160.8152 | 160.8298 | +0.0146 | 17/17 |

Exact on reasoning; +0.0091% on embeddings, which is the published-rate rounding #21
measured (0.009%) — **the same signature now reproduced at four scales**: one call,
three calls, 14 calls, 17 calls. A constant proportional bias is the signature of a
rate constant, not of a missed call site; a coverage gap would scale with call count,
not with neurons.

**7 reasoning calls is 5 iterations + 1 report + 1 out-of-band `/step`** — the count
reconciles to a specific, nameable set of calls rather than to a plausible total.
That is what the model column bought: before it, this run would have produced a single
aggregate delta and the same hypothesis-shaped answer as 2026-08-12.

**What it still cannot prove** is unchanged and worth restating, because a clean PASS
invites the opposite conclusion: this run had **no retries**, so #19's retry
accounting remains untested (see #19). Every reconciliation so far has been of a run
where nothing failed after an AI call returned.

---

## Bug 24 — The fresh-excerpt window is a newest-N cut, and it destroyed a verdict

**Severity:** 🔴 Silent research regression · **Status:** **Fixed & measured** (uncommitted)

**How it showed up.** Goal 1 read **Answered** on daily run `5a8c9aeb` (2026-08-13) and
**Unanswered** on the next three — `b099c83d`, `dc0a0b39`, `8772de4e` — with all three
of its supporting specifics gone from the reports:

| `5a8c9aeb` | `b099c83d` and after |
|---|---|
| Farmbot **$22m Series B** (agtech) | Bailador / PropHero |
| CUREator+ **6 startups / $13.5m** (biotech) | Stirling **NZ$3.8m** (Blackbird) |
| Alloy Robotics **$11.5m Seed** | Kantoko **$3.5m** seed |

The obvious reading — the live feed moved on and took the facts with it — is **wrong**.
`startupdaily.net/feed` fetched at 2026-08-17 00:50Z had a newest item dated **Fri 14
Aug 06:50Z**, ten hours *before* the 08-14 run, and had published nothing since. All
three losing runs read byte-identical material, which is why their iteration-1 findings
are verbatim identical. **And that frozen feed still contained Farmbot, CUREator+ and
Alloy Robotics.** The loop stopped reporting facts that were still in front of it.

**Root cause.** `workflow.ts` passed `pieces.slice(0, FRESH_EXCERPTS)` with
`FRESH_EXCERPTS = 6`. At `chunk(size=1400, overlap=160)` that is characters 0–7,600 of
13,162 — and **RSS is newest-first**, so it is a newest-N window, not a summary of the
source. Mapping every item to its offset in the frozen feed:

```
IN  @ 1214  Bailador / PropHero                     <- cited 08-14/15/16
IN  @ 2301  NSW e-bike laws
IN  @ 3463  Kiwi AI startup banks $3.15m (Stirling) <- cited 08-14/15/16
IN  @ 4707  Google Pixel cameras
IN  @ 5784  Zac Altman ADHD $3.5m (Kantoko)         <- cited 08-14/15/16
IN  @ 7229  Farmbot $22m Series B          (cut at 7600 - title only)
--------------- first-6-chunk boundary ---------------
OUT @ 8273  CUREator+ 6 startups $13.5m             <- cited 08-13
OUT @ 9351  Why founders have a problem taking action
OUT @10869  Elon Musk v eSafety
OUT @12124  Big 3 VCs / robot testing $11.5m (Alloy)<- cited 08-13
```

Four items published between the two runs (Bailador, e-bikes, Stirling, Pixel) pushed
the goal-1 evidence over the cut. On 08-13 those four did not exist, so the window began
at Kantoko and all three cited items were inside it. The evidence was embedded in
Vectorize the whole time; recall never retrieved it, competing against 200+ chunks from
the other four seeds.

**The mechanism is window competition, not fact arrival.** A feed refreshing does not add
evidence, it *evicts* evidence — and an off-topic post (e-bikes, Pixel phones) evicts
exactly as effectively as a relevant one.

**Measured, both arms verified at the runtime rather than from the value passed in.**
One `/step` iteration per sample against the frozen feed, single seed, no prior findings:

| specific (offset) | window = 6 chunks, n=8 | window = 11 chunks, n=3 |
|---|---|---|
| Bailador / Stirling / Kantoko (@1.2k–5.8k) | 8/8 | 3/3 |
| Farmbot $22m (@7,229, straddles the cut) | 3/8 | **3/3** |
| **CUREator+ $13.5m (@8,273, outside)** | **0/8** | **3/3** |
| **Alloy Robotics $11.5m (@12,124, outside)** | **0/8** | **2/3** |

Sample B2 reconstructed the sector framing unprompted — *"Other **sectors** mentioned
include **agtech**, with Farmbot raising $22 million Series B, and **biotech**, with six
Aussie biotechs receiving $13.5m in CUREator+ grants"* — from the identical feed that had
returned Unanswered three runs running.

**Fix — a character budget, not a chunk count.** `freshExcerpts(pieces, budget)` in
`ingest.ts`, `FRESH_CHARS_DEFAULT = 16_000`, used by **both** the workflow and `/step`.
A count was the wrong unit: it cut a source small enough to show whole, and its meaning
drifts as the source grows. A budget says the useful thing — show the source whole when
it fits, bound the prompt when it does not — and always returns at least one chunk.

**Verified after the fix.** Startup Daily: `budget=16000 chunksUsed=11 charsUsed=14820`,
the whole feed, agtech + biotech recovered 2/2. `Australia` wikitext (49 chunks) bounded
at `chunksUsed=11 charsUsed=15400`.

**Cost.** Reasoning neurons per iteration ~142 mean (8,400 chars) → ~193 mean (~15,400
chars), **+36%**. Estimated whole-run effect ~1,054 → ~1,325 neurons, well under the
8,000 budget. The report call is unaffected — it reads findings, not chunks.

**What this does not prove.** The measurement is of iteration 1's **finding**, not of the
report's **verdict**; the finding → Answered step was not run. One source, one feed
state, one hour — three independent generations at `temperature: 0.4`, so the honest
claim is *"the window recovers this feed's goal-1 evidence"*, not *"the window improves
runs"*. And **16,000 is feed-specific**: it is "all of Startup Daily today" and will
stop being that as the feed grows.

---

## Bug 25 — A finding is attributed to a source that supplied none of its content

**Severity:** 🔴 False attribution · **Status:** **Open**

**How it showed up.** `dc0a0b39`'s report (2026-08-15):

> Notable funding rounds include Stirling's NZ$3.8 million
> (**startupdaily.net/feed**, **techcouncil.com.au/feed**,
> **en.wikipedia.org/…title=Australia**)…

Stirling came from Startup Daily, in iteration 1 of that same run. Two of the three
citations are false. `8772de4e` does the same for Alloy Robotics, citing it to the Tech
Council feed alone.

**Corroborated on the flagship number.** A single-source `/step` against the `Australia`
wikitext, with `recalled: 0`, returns *"Not stated in the sources read so far … the
provided source is about general information on Australia … but does not mention AI
startups."* So the **$248.5 billion / 8.9% of GDP** figure that every production report
cites to that URL is not in the read window either — it is a Tech Council figure that
reached the finding through recall.

**Root cause — #22's invariant, one branch away (CLAUDE.md §9).** `recall()` injects
other sources' chunks into the iteration prompt; the model restates them; the finding is
stamped with *this* iteration's `contributedUrl`; `REPORT_SYSTEM` faithfully copies that
SOURCE line into the citation. #22 was implemented as **"the source row had `chunks > 0`"**
(`workflow.ts:165`) when the invariant it named was **"a finding is attributed only to a
source that contributed the content."** A *successful* fetch credited with another
source's facts satisfies the code and violates the invariant.

**Why this is worse than #22.** #22 mis-cited a source that fetched nothing, which is a
narrow and detectable case. This mis-cites sources that fetched perfectly, on claims that
are individually true, so nothing in the run looks wrong. It is the same defect class as
#13 → #22: a citation that is real, and to a source that never said it.

**Not fixed.** Candidates, in rough order of cost: carry each recalled chunk's
`sourceUrl` into the prompt as an attributable citation (the data is already in
`Recalled.sourceUrl` and already rendered in the `[mem n]` block); or restrict the
report's citable set to the source that produced each finding; or require per-claim
attribution in the finding schema. The first is closest to the existing grain.

---

## Bug 26 — Eight samples of a config experiment that tested nothing

**Severity:** 🟠 Test validity · **Status:** Diagnosed; practice added

**How it showed up.** While measuring #24, three "arm B" samples came back with
`neurons: 140.83984375` — **byte-identical to an arm A sample**. Identical token counts
mean identical prompts, which meant the window override was not applied. It was not:

- `wrangler dev --remote --var FRESH_EXCERPTS:11` — not applied
- `.dev.vars` — not applied
- `.env` (loaded, and shown by wrangler as `Using secrets defined in .env`) — not applied
- `wrangler.jsonc` `vars` — **applied**, and the startup banner printed
  `env.FRESH_EXCERPTS ("11")` … while the handler still read `6`

The banner is not evidence the running code sees the value. The real cause of the last
one: `TaskStop` killed the wrangler **parent** processes, their `workerd` children
survived holding `127.0.0.1:8787`, and every request was answered by the **first** server
— the `FRESH_EXCERPTS=6` one — while three later servers sat behind it. `netstat -ano`
showed **five distinct PIDs** on the port. A single wrangler instance opens ~5 sockets, so
socket count alone is not the tell; **distinct PIDs** is.

**Net effect:** the control arm had n=8 and the treatment arm n=0, and every sample looked
clean, self-consistent and publishable. Re-run on a fresh port (`--port 8788`, one PID),
the treatment arm separated immediately.

**Practice, now applied.** `/step` reports `freshCharBudget`, `freshChunksUsed` and
`freshCharsUsed` — the setting **actually applied**, from inside the handler, next to the
result it produced. This is CLAUDE.md §10 in a new costume: a knob verified only against
the value you passed in always passes. Before trusting a config experiment:

1. Print the effective setting from inside the request, not from the launcher.
2. `netstat -ano | grep <port>` and count **distinct PIDs**.
3. Treat an identical cost/latency figure across arms as a failed manipulation until
   proven otherwise — it was the first and cheapest tell here.
