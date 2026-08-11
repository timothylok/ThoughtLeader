# Prompt rewrite — controlled A/B against run 2

**Question:** `src/prompt.ts` was rewritten after benchmark run 2 to fix that run's
weaknesses. No run had used it. Did it help?

**Method:** re-run `benchmark/run-payload.json` **unchanged** — same topic, same 5
goals, same 9 validated seeds, same `maxIterations: 12`. The prompt is the only
deliberate difference.

| | Run 2 `0d5ed883` | Replica `76fb1813` |
|---|---|---|
| Prompt | pre-rewrite | **post-rewrite** |
| Outcome | ✅ 12/12, `max-iterations` | ✅ 12/12, `max-iterations` |
| Report | 2,717 chars | 2,634 chars |
| Findings | 12, no dupes | 12, no dupes |
| Cost | ~1,726 neurons | ~1,950 neurons (approx.) |

One caveat on cost: `/usage` is a per-day cumulative counter and the next run
started before it was snapshotted, so the replica figure is inferred from
intermediate readings, not measured cleanly.

**A second variable rode along.** Bug #12 (URL fabrication) was deliberately left
unfixed for run 2 and is fixed here, so source-discovery differences below belong
to that fix, not to the prompt. They are reported separately for that reason.

---

## 1. What the rewrite was asked to do, and whether it did it

| Requirement added to the prompt | Result |
|---|---|
| One section per goal | ✅ (run 2 already did this) |
| Bold **Answered/Partial/Unanswered** verdict per goal | ✅ all 5 goals |
| Closing **Gaps** section | ✅ 5 targeted items |
| Answer *the goal actually asked* | ✅ **the headline result — see below** |
| Prefer counts, figures, dates, named entities | 🔶 modest, real, concentrated in goal 3 |
| Cite the source URL per claim | ❌ **regressed — see §3** |

---

## 2. The headline: goal 4 stopped answering a different question

`BENCHMARK.md` called goal 4 the loop's clear failure. Asked to identify clusters
in **Sydney, Melbourne, Brisbane and Perth**, run 2 answered about **South
Australia**.

**Run 2:**

> The findings suggest that South Australia is a notable geographic cluster for AI
> activity in Australia, with a new partnership with OpenAI…

**Replica:**

> **Unanswered**. The sources do not provide specific information on the
> geographic clusters of Australian AI startups or what differentiates them.

…and it carried the failure into Gaps as *"Differentiation of geographic clusters
in Sydney, Melbourne, Brisbane, and Perth."*

The instruction *"Answer the goal that was actually asked. If a goal names
particular things (cities, sectors, categories), address those things — do not
substitute a different one"* did exactly what it was written to do.

**The discovery was not lost.** Finding n=7 still records South Australia's OpenAI
partnership and its royal commission into AI. The loop stopped *mis-filing* that
material under a question about cities; it did not stop finding it. This matters
because `BENCHMARK.md` credits the SA/OpenAI fact as something the loop found and
the Claude Code arm missed.

## 3. The regression: citations became unresolvable

Run 2 cited inline URLs. The replica cites `[1]`, `[3]`, `[5]`, `[6]`, `[10]` —
**with no legend**, and those numbers are *iteration indices*, not sources.

`synthesise()` passes findings as `` `[${f.n}] ${f.finding}` ``, so iteration
numbers are the only bracketed identifiers in the payload. The rewritten
`REPORT_SYSTEM` then demands a source URL that the payload never contained, and
the model cited what it could see.

Logged as **bug #13**. A prompt that demands a field the payload does not carry
does not fail loudly — it produces a confident substitute.

## 4. Specificity: real but smaller than hoped

Measured across all 12 findings of each run:

| Metric | Run 2 | Replica |
|---|---|---|
| Avg finding length | 61 words | 60 words |
| Numeric tokens | 17 | **19** |
| Distinct proper nouns | 38 | **42** |

The aggregate barely moves. The gain is concentrated where the sources actually
support it — goal 3:

- **Run 2:** AirTree, Blackbird (130+ companies), Vexev $8.6M, Firmus $2.85B at
  $15B. No funding stages.
- **Replica:** the above plus Sequoia, Aerotruth **$1.3M Seed** (a named stage),
  MagicBrief $2M, and Startmate's 300+ startups / $4.5B portfolio value.

Goal 2 gained concrete exemplars — **Canva** as AI-native, **Atlassian** as
AI-enabled — where run 2 stated the 2016 founding-date rule with no companies
attached.

**Accuracy improved incidentally.** Run 2 mis-attributed the 2016 rule to
`airtree.vc` and filed **Airtasker** under proptech. The replica uses
**Archistar** for proptech and **Cluey Learning** for education, both correct.

**What neither run got:** the AI-native/AI-enabled split percentage and per-sector
growth rates. Both reports say so plainly. The Claude Code arm produced a 45%/55%
split from the same seed list, so this is a retrieval gap, not a prompting one.

## 5. Riding along: bug #12's fix, measured at scale

| | Run 2 | Replica |
|---|---|---|
| Sources total | 27 | **14** |
| Model-added | 18 | **5** |
| Pending at cap | 15 | **2** |
| Invented domains | several | **zero** |

No `australianstartup.org` this time. But the fix exposed **bug #14**: 3 of the 5
accepted URLs were existing seeds differing only by `www.` or a trailing slash.
`smallbizai` was fetched twice at 41 chunks each — 82 duplicate vectors — and
`startmate.com/portfolio` twice. Roughly **25% of the fetch budget** went to
re-reading pages already in memory.

Grounding solved fabrication and left duplication untouched.

## 6. Verdict

**The rewrite is worth keeping.** It fixed the substitution failure that
`BENCHMARK.md` identified as the loop's worst content bug, delivered its whole
structural contract, and modestly raised specificity — for no extra iterations and
roughly the same cost.

**It is not a quality leap.** The loop still trails the Claude Code arm on goals
1, 3 and 5, and goal 4 moved from *confidently wrong* to *honestly empty* rather
than to answered. That is a genuine improvement in a system meant to run
unattended — an unattended loop that answers the wrong question is worse than one
that flags a gap — but it is not the same as getting the answer.

**Two bugs to fix before the next run:** #13 (unresolvable citations) and #14 (URL
normalisation). Neither was deployed here; a run was in flight, and deploying
mid-run is bug #4.

## 7. Reproducing

```sh
set -a; . ./.env; set +a          # WORKER_URL — see .env.example

curl -X POST "$WORKER_URL/start" \
  -H 'content-type: application/json' -d @benchmark/run-payload.json

curl "$WORKER_URL/state?run=<id>"
```

Run at `ITERATION_INTERVAL=1 minute` to match run 2's pacing; the committed
default is 18 minutes. Pacing changes wall clock only, not neuron cost.
