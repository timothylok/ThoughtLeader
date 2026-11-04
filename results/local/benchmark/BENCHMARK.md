# Benchmark — Cloudflare research loop vs Claude Code

**Task:** identical. Same topic, same 5 goals, same 9 validated seed sources
(`AI_Research.md`). Run `19ac529b`, 2026-08-11.

**Run twice:** `19ac529b` (pre-fix, failed) and `0d5ed883` (post-fix, completed).

**Headline after fixes:** the loop now **finishes** — 12/12 iterations, no
duplicates, final report written, trampoline exercised. It remains **~10× slower
and materially less specific** than Claude Code, but costs **$0.019 against
$10.00** — Claude Code is **~527× more expensive per run**.

---

## 1. Results

| | **Loop — run 1 (pre-fix)** | **Loop — run 2 (post-fix)** | **Claude Code** |
|---|---|---|---|
| Outcome | ❌ **Failed at n=11/12** | ✅ **Completed 12/12** | ✅ Complete |
| Termination | subrequest exhaustion | `max-iterations` (clean) | n/a |
| Wall clock | 27 m 38 s | **24 m 52 s** | **~2 m 30 s** |
| Final report | **none** | ✅ **2,717 chars, per-goal, cited** | ✅ full, per-goal |
| Findings | 16 rows / 11 iters (**5 dupes**) | **12 rows / 12 iters, 0 dupes** | 1 synthesis |
| Sources fetched | 10 of 23 | 11 of 27 (15 left pending) | 7 of 9 |
| Chunks stored | 120 | 120 | n/a |
| **Cost** | ~1,162 neurons = **$0.013** | ~1,726 neurons = **$0.019** | **$10.00** |
| Cost ratio | — | **1×** | **527× more expensive** |
| Persistent artefact | ✅ queryable vectors | ✅ queryable vectors | ❌ transcript only |
| Live progress view | ✅ `/live` | ✅ `/live` | ❌ |

### Fix verification (run 2)

| Bug | Evidence it is fixed |
|---|---|
| #1 subrequests | Ran past n=11 to completion; `ITERATIONS_PER_GEN=8` |
| #2 vector IDs | 120 chunks across 11 sources, all retrievable |
| #3 idempotency | **12 findings for 12 iterations, zero duplicates** |
| #4 deploy-mid-run | No deploy during run; no false terminal status |
| Trampoline (never tested before) | `gen-0` → `continue:0`, `gen-1` → `report:1`, both ✅ Completed |

### Why run 1 failed

```
Last successful step: reason:11
Error: Too many subrequests by single Worker invocation
Attempts: 6 (all failed identically)
```

A **resumed Workflow instance accumulates subrequests across iterations within a
single invocation.** My README claimed each `step.do` gets its own execution
context and that "1 fetch + ~4 binding calls per iteration" was comfortably under
the 50-subrequest cap. **That assumption was wrong** — the budget is per
*invocation*, and by iteration 11 the instance had exhausted it. Fixed by cutting
`ITERATIONS_PER_GEN` 100 → 8 so each trampoline generation starts fresh.

### The cost picture

| | Per run | Weekly for a year |
|---|---|---|
| Claude Code | **$10.00** | **$520.00** |
| Loop (1,726 neurons) | **$0.019** — $0 actual, inside the free allocation | **$0.99** — $0 on free tier |

**$10 buys 527 completed loop runs**, or ~91 days of the free 10,000-neuron/day
allocation. The first benchmark recorded Claude Code's cost as "not separately
metered", which hid the single most decisive variable in the comparison.

---

## 2. Content quality

Both arms answered the same five goals. Scored on what they actually produced.

| Goal | Loop run 2 (post-fix report) | Claude Code |
|---|---|---|
| 1 — Sectors | Fintech, proptech, health, education + Athena/Brighte/Airtasker. **No counts, no "fastest growing"** | 240 companies / 17 sectors **with per-sector counts**; Q2-2026 funding split |
| 2 — Native vs enabled | ✅ **Got the 2016 founding-date rule** (run 1 missed it) but **no split %**, and **mis-cited it to airtree.vc** | The rule **and** the 45%/55% split, correctly attributed |
| 2 — *re-run on the new prompt* (`76fb1813`) | ✅ rule **plus Canva vs Atlassian** as exemplars; still no split % | — |
| 3 — Funding | AirTree, Blackbird (130+ cos), Vexev $8.6M, Firmus $2.85B @ $15B. **No stages** | Adds A$1.7B/64 rounds, two-thirds AI share, diversity split |
| 4 — Geography | **Only South Australia** (OpenAI partnership). Missed Sydney/Melbourne/Brisbane/Perth entirely | Full **state-by-state table** with counts and specialisations |
| 5 — Named companies | ~8 companies, each with a source URL | **60+ companies** grouped by sector |

**Claude Code still won every goal**, but run 2 narrowed the gap on goal 2 by
recovering the AI-native definition. Goal 4 remains the loop's clear failure: it
answered a question about four cities by describing a fifth state.

> **Superseded, 2026-08-11.** Goal 4's failure was a *prompting* failure, not a
> retrieval one. `src/prompt.ts` was rewritten to require answering the goal actually
> asked, and the identical payload re-run as `76fb1813` returns **Unanswered** for
> goal 4 with the gap named — while still recording the South Australia / OpenAI
> discovery in finding n=7, just no longer mis-filed under a question about cities.
> The four-city breakdown genuinely is not in these nine sources, so *Unanswered* is
> the correct answer and Claude Code's table came from material the loop never saw.
> Full controlled A/B in `PROMPT-REWRITE.md`.

**The loop marks its own homework honestly.** Its report concludes: *"The findings
do not provide a comprehensive answer to any of the goals, and more information is
needed."* That self-assessment is accurate and is arguably worth more than a
confident-sounding answer would be.

**One citation error:** it attributed the 2016 AI-native definition to
`airtree.vc`, which is not where that fact came from. Grounded-looking citations
are not automatically correct citations.

### Where the loop actually won

It **discovered sources on its own** and found facts the Claude Code arm missed —
in both runs:

- Run 1: enqueued **SmartCompany** and **Austrade** unprompted; surfaced
  **PsiQuantum's $179.2M DARPA contract**
- Run 2: surfaced **South Australia's OpenAI partnership** (data-centre
  investment, public-sector skills programme) — absent from the Claude Code report

That is the loop's real advantage: given time it explores outward, while a
single-pass agent only reads what it was handed.

### Where autonomous discovery hurt

9 seeds became **23 sources**. Of the 14 the model added, several were plausible
but **non-existent or defunct** — `australianstartup.org`,
`australianinnovation.org`, `startupaus.org` (now the Tech Council) — plus
duplicates of existing seeds under different hostnames (`smallbizai.au/`,
`startmate.com/portfolio` without `www`). It also spent a full iteration on the
SmartCompany homepage, whose own finding concedes it "does not offer specific
insights into the Australian AI startup ecosystem."

**~40% of the loop's fetch budget went to sources it invented.**

Run 2 was **worse**, not better: 9 seeds → **27 sources**, 18 model-added, and
15 still pending when the iteration cap hit. Bug #12 was deliberately left unfixed
for run 2 so the comparison isolated bugs #1–#4. It is **now fixed** — links are
harvested from pages actually fetched (`HTMLRewriter`), and the model may only
*select* from that observed set rather than invent URLs. Unmeasured as yet.

---

## 3. Tooling asymmetries observed

Both arms hit the same web; they did not get the same results.

| Source | Claude Code (`WebFetch`) | Worker (`fetch`) |
|---|---|---|
| InnovationAus | ❌ **HTTP 403** | ✅ 4,181 chars |
| Wikipedia (Science & tech in AU) | ❌ near-empty response | ✅ 35,951 chars |
| `cutthroughventure.com/reports` | ⚠️ refused cross-host redirect, needed a manual retry | ✅ followed automatically |

`WebFetch` is stricter about redirects and is blocked where Cloudflare's egress is
not. The Worker got **more raw material**; Claude Code did **more with less**.

---

## 4. Bugs this benchmark exposed

Three fatal/major ones below; the full log of **12** is in `../bugs.md`. None
would have been found without running the thing.

**1. Subrequest exhaustion (fatal).** Per-invocation, not per-step.
→ `ITERATIONS_PER_GEN` reduced **100 → 8** so each trampoline generation starts
with a fresh subrequest budget.

**2. Duplicate findings on retry.** The `record` step inserted a finding, then
failed on a later subrequest, and each of 6 retries inserted again. This is
exactly the non-idempotency trap the Workflows docs warn about — quoted in the
README, then violated in the code.
→ `UNIQUE(run_id, n)` index + `ON CONFLICT DO UPDATE`.

**3. A deploy mid-run marked a healthy run failed.** Deploying reset the Durable
Object (`"Durable Object reset because its code was updated"`); the catch-all
wrote `status='failed'` while the workflow was still running and recovering.
→ `isTransient()` distinguishes platform interruptions from real failures.

**Operational rule learned: never `wrangler deploy` while a run is in flight.**

---

## 5. When to use which

**Use Claude Code when** the answer's *quality* matters more than its price. It is
~10× faster, more specific, synthesises better, and needs no infrastructure. On
output alone it won every goal in both runs.

But "wins outright" was the wrong call in the first draft of this benchmark, made
before the $10 figure was known. At **527× the cost**, the honest question is not
"which is better" but "is the quality gap worth 527×?" For a one-off decision that
someone will act on, yes. For the tenth topic this month, plainly not.

**Use the loop when** the job is *continuous* rather than one-shot:

- It runs unattended for days on a schedule; Claude Code needs someone present.
- It accumulates **queryable vector memory** — 120 chunks still searchable via
  `/search` after the run died. Claude Code's findings live in a transcript.
- It **discovers sources you didn't supply** (SmartCompany, Austrade, the
  PsiQuantum fact).
- It costs **$0.019 per run** — 527 runs for the price of one Claude Code run —
  and needs no human present.

**The honest framing:** this benchmark was a one-shot research question — Claude
Code's home ground and the loop's worst case. A fairer test of the loop is
"re-run weekly for three months and tell me what changed": $520 of Claude Code
time versus **$0.99** of neurons, and something Claude Code cannot do unattended
at all.

**Practical answer:** use Claude Code to *design and validate* the brief (it caught
that 2 of 4 original sources were bot-blocked and that "Accenture NZ" was not a
startup), then hand the validated brief to the loop for repeated execution. That
plays each to its strength rather than picking a winner.

---

## 6. Reproducing

```sh
# Loop arm
set -a; . ./.env; set +a          # WORKER_URL — see .env.example
curl -X POST "$WORKER_URL/start" \
  -H 'content-type: application/json' -d @benchmark/run-payload.json
open "$WORKER_URL/live?run=<id>"

# Claude Code arm: see benchmark/claude-code-report.md
```

Raw loop output: `/state?run=19ac529b`. Claude Code output:
`benchmark/claude-code-report.md` (written before the loop finished, unedited
afterwards, so the comparison is not retrofitted).
