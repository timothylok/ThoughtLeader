# AU and NZ as two standalone runs

The combined 14-source AU+NZ run (`98adcf63`) **failed** at iteration 11 of 16 —
`Worker exceeded CPU time limit` (bug #15). It was replaced by two standalone runs.

| | **AU — `76fb1813`** | **NZ — `0f4fdd5c`** |
|---|---|---|
| Outcome | ✅ 12/12, `max-iterations` | ✅ 5/8, `sources-exhausted` |
| Seeds | 9 (HTML) | 5 (2 plain-text, 3 small HTML) |
| Sources read | 12 of 14 | 5 of 5 |
| Model-added | 5 | **0** |
| Chunks stored | 152 | 108 |
| Report | 2,634 chars | 2,433 chars |
| Cost | ~1,950 neurons | **833 neurons** |
| Goal verdicts | 1 Answered, 3 Partial, 1 Unanswered | **0 Answered, 2 Partial, 3 Unanswered** |

The AU run doubles as the prompt-rewrite A/B — see `PROMPT-REWRITE.md`.

---

## 1. The NZ run worked and the NZ brief did not

The run executed cleanly. It answered almost nothing, and the reason is the source
list, not the loop.

**What it did find** — all of it real, specific and correctly attributed:

- **Elevate**, a NZ government **$300m fund of funds** investing into VC funds to
  fill the **Series A/B capital gap** for high-growth NZ tech companies.
- **NZGCP's Aspire fund**, investing directly into early-stage NZ startups at
  **proof of concept, seed and early expansion** stages.
- **Creative HQ** as a Wellington innovation hub.
- **Biostart** and **Dot Ingredients** as Callaghan Innovation collaborators.

Goal 3 is the strongest result of either run on funding *stages* — the AU report
never named a stage beyond one "Seed", and the NZ report names four.

**Where it came from is the problem:**

| Source | Chunks | Cited in report |
|---|---|---|
| `New_Zealand` (raw wikitext) | 49 | ❌ |
| `Economy_of_New_Zealand` (raw wikitext) | 49 | ❌ |
| `callaghaninnovation.govt.nz` | 5 | ✅ |
| `creativehq.co.nz` | 3 | ✅ |
| `nzgcp.co.nz` | 2 | used, not cited |

**98 of 108 chunks — 91% of everything ingested — contributed nothing.** The two
Wikipedia country articles are not about AI startups, so the entire report rests on
the 10 chunks from three small sites.

This is bug #16 compounding: the NZ Wikipedia source in `AI_Research.md` §5 was a
redirect to the country article all along. Swapping it to plain text fixed the CPU
crash and left it just as irrelevant.

**The sources that would answer goals 1, 2 and 5 are the ones §5 already
excluded** — NZTech, AI Forum NZ and Icehouse Ventures, all JS-rendered and
unextractable. Those bodies hold the named-company and sector data. Without them
the NZ brief is not executable, and no amount of prompting or iteration changes
that. §5 predicted this ("NZ coverage will be weaker on named startups and
stronger on macro context"); the run confirms it harder than expected.

**The honest verdict: do not re-run the NZ brief as written.** It costs 833 neurons
to produce three Unanswered verdicts. It needs Browser Rendering for the
JS-rendered bodies, or genuinely different sources, first.

## 2. Splitting was the right call, for a reason we did not anticipate

The split was requested to separate two research questions. It also removed the
failure: the combined run died on the NZ Wikipedia page, and the standalone NZ run
never touched it because that URL was replaced during the CPU investigation.

Worth being precise about the causation — **the split did not fix the CPU bug.**
Bug #15 is still open and every large-HTML source in the AU list is still over
budget. The AU run's 12/12 remains luck. What the split bought was a smaller blast
radius: a 5-source run that fails costs 833 neurons, not 2,300.

## 3. Plain text fixes CPU and disables discovery

The NZ run added **zero** model-proposed sources against the AU run's 5. Raw
wikitext contains `[[internal links]]`, not `<a href>`, so `HTMLRewriter` harvests
no candidates and grounding has nothing to select from.

This is **already documented** as a known limitation of the bug #12 fix — *"the
free-tier profile, which deliberately prefers `.md` and `llms.txt` sources, gets
little autonomous discovery as a result."* The NZ run is the first measurement of
it: not "little" but **none**.

That matters because `BENCHMARK.md` names autonomous discovery as the loop's one
advantage over a single-pass agent. The CPU-safe configuration and the
discovery-capable configuration are **mutually exclusive** on this plan:

| | Large HTML | Plain text |
|---|---|---|
| CPU per parse | 20–241 ms (limit ~10 ms) | ~1 ms |
| Reliability | intermittent | reliable |
| Link harvesting | yes | **none** |

Choosing plain text for a daily unattended schedule means accepting a
seeds-only loop — which makes `MAX_SOURCE_DEPTH=0` the honest setting rather than
a fallback, and turns `HANDOFF.md`'s third open question into a decided one.

## 4. What today's four runs actually settled

| Question | Answer |
|---|---|
| Did the prompt rewrite help? | **Yes** — goal-4 substitution fixed, full format contract, modest specificity gain. One regression (bug #13). |
| Does grounding stop URL fabrication? | **Yes** — 18 model-added → 5, zero invented domains. Exposed bug #14. |
| Is the AU brief executable? | **Yes**, but on borrowed CPU (bug #15). |
| Is the NZ brief executable? | **No** — 91% of ingested material was irrelevant; the sources that matter are JS-rendered. |
| Is the loop ready for a daily schedule? | **Not yet** — bug #15 makes any HTML run a coin flip. |

Spend across all four runs: **7,901 of 10,000 neurons**, ≈ $0.087.
