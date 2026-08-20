# Research Brief — Australian AI Startup Ecosystem

**Status:** ⚠️ **SUPERSEDED 2026-08-19.** This is the original ecosystem-survey brief and
the record of the sourcing done for it. The loop now runs a **delta** brief — record new
funding events, flag divergence from `baseline/AU-AI-FUNDING-2026H1.md` — which lives in
D1 at `control.daily_brief`, not in this file. Read it with the runbook in README §3.5.
Seeds are now **one**: `startupdaily` only (bugs.md #29, #35, #38).
Kept because §4 and §5 are the sourcing evidence, and §7 still describes the output.
**Every operational detail below is historical** — the cron is now two DST arms, not
`0 16 * * *` (bugs.md #31), and the daily brief has one seed and two goals. `README.md`
and `HANDOFF.md` are authoritative for anything live.
**Tool:** the research loop in this repo (`README.md`)
**Deliverable:** prose findings + synthesised report — **not** a company database

---

## 1. What this brief is, and is not

This produces an **iterative research report** on the Australian AI startup
ecosystem: the loop reads one source per iteration, recalls what it read earlier,
and writes a grounded finding, then synthesises a final report against the goals.

It does **not** produce a structured, deduplicated, scored company dataset. That
would require a `companies` table, JSON-schema extraction per iteration, and entity
resolution — none of which exist in the current build. Scoped out deliberately.

**Also scoped out:** composite scores like "innovation", "market potential" and
"team strength". They have no observable inputs, so an LLM would be inventing the
numbers and they would drift between runs. Findings record observable facts with
their source instead.

**New Zealand is phase 2.** It had zero validated sources at brief time (see §5).

---

## 2. Topic and goals

**Topic**

> The Australian AI startup ecosystem in 2026: who the companies are, which
> sectors they cluster in, how they are funded, and what distinguishes AI-native
> companies from AI-enabled incumbents.

**Goals** (the loop self-assesses against these and stops when they are met)

1. Identify the main sectors where Australian AI startups concentrate, and which
   are growing fastest.
2. Establish how "AI-native" companies are distinguished from "AI-enabled"
   incumbents, and roughly how the ecosystem splits between them.
3. Map the funding landscape: which investors are most active in Australian AI,
   typical stages, and notable recent rounds.
4. Identify the geographic clusters (Sydney, Melbourne, Brisbane, Perth) and what
   differentiates them.
5. Surface named example companies for each major sector, with sources.

---

## 3. Validated seed sources

Every URL below was fetched **through the actual ingest pipeline** and returned
substantive extractable text. Character/chunk counts are what the loop really got.

| Source | Extracted | Chunks | Why it's here |
|---|---|---|---|
| [SmallBizAI — Australian AI Companies by Industry](https://smallbizai.au/australian-ai-companies-complete-guide-by-industry-2026/) | 50,070 ch | 41 | **Best source.** 240 companies confirmed; industry + AI-native tagging |
| ⚠️ [Wikipedia — "Science and technology in Australia"](https://en.wikipedia.org/wiki/Science_and_technology_in_Australia) | 35,951 ch | 29 | **This is a REDIRECT to the `Australia` country article** — `?action=raw` returns 46 chars of `#REDIRECT`. The 35,951 ch measured is the general country article, not a science-and-technology source (bugs.md #16). Use `?title=Australia&action=raw` if you want it, and expect macro context only. |
| [CSIRO — AI research](https://www.csiro.au/en/research/technology-space/ai) | 12,612 ch | 11 | National science agency; research-to-commercialisation pipeline |
| [Startmate — portfolio](https://www.startmate.com/portfolio) | 10,805 ch | 9 | Leading AU accelerator cohort |
| [Cut Through Venture — reports](https://www.cutthroughventure.com/reports) | 7,574 ch | 6 | The standard AU venture funding dataset |
| [Startup Daily](https://www.startupdaily.net/) | 5,324 ch | 5 | Funding announcements, recent news |
| [InnovationAus](https://www.innovationaus.com/) | 4,181 ch | 4 | Policy and industry analysis |
| [Blackbird VC — portfolio](https://blackbird.vc/portfolio) | 3,681 ch | 3 | Largest AU venture fund |
| [Tech Council of Australia](https://techcouncil.com.au/) | 3,675 ch | 3 | Industry body, ecosystem-level data |

**Suggested `maxIterations`: 12** — 9 seeds plus room for a few model-proposed
sources. At ~173 neurons/iteration that is ~2,100 neurons, about 21% of the free
daily allocation.

---

## 4. Sources rejected, and why

Do not re-add these without re-testing. All four were in the original draft brief.

| Source | Verdict |
|---|---|
| [Seedtable — best AI startups in Australia](https://seedtable.com/best-ai-startups-in-australia) | ❌ **HTTP 403** direct. Via Cloudflare returned 3,005 ch of intro text and location strings with **zero company names** — the list is JS-rendered. |
| [F6S — AI companies Australia](https://www.f6s.com/companies/artificial-intelligence/australia/co) | ❌ **HTTP 405.** Pipeline extracted **68 characters**: `"Request ID: jEWjNNs3…"` — a bot-block page. |
| [Nucamp — top 10 startups](https://www.nucamp.co/blog/coding-bootcamp-australia-aus-australias-top-10-startups-that-tech-professionals-should-watch-out-for-in-2025) | ⚠️ Fetches fine (29,446 ch) but it is coding-bootcamp **marketing content**, and the URL says 2025 while the draft cited it as 2026. Excluded on authority, not accessibility. |
| AirTree VC — portfolio | ⚠️ 1,350 ch — JS-rendered, effectively empty. |

**Both blocked sites are actively refusing automated access.** Working around that
with Browser Rendering would likely breach their terms. They are excluded on
purpose, not by oversight.

### Corrected factual errors from the draft brief

- **"Accenture New Zealand (AI SaaS)" is not a NZ AI startup.** Accenture is a
  global consultancy of ~800,000 people. It was the only concrete NZ company named
  in the draft, and it was wrong.
- **URL/year mismatch** on the Nucamp citation (slug 2025, cited as 2026).
- **"270+ companies" (F6S) and "50 funded startups" (Seedtable) are unverified** —
  both sites block access, so neither number could be checked.
- **"240 Australian AI companies" (SmallBizAI) — verified.** The page states
  "240 companies" and uses "AI-native" 218 times, supporting the native/enabled
  classification claim.

---

## 5. New Zealand — sources validated 2026-08-11

All probed through the live pipeline. **5 of 9 candidates usable.**

### ✅ Validated NZ sources

| Source | Extracted | Chunks |
|---|---|---|
| [Wikipedia — Economy of New Zealand](https://en.wikipedia.org/wiki/Economy_of_New_Zealand) | 42,826 ch | 35 |
| ⚠️ [Wikipedia — "Science and technology in NZ"](https://en.wikipedia.org/wiki/Science_and_technology_in_New_Zealand) — **a REDIRECT to `New_Zealand`; 1.84 MB, killed run `98adcf63` on CPU. Do not use.** | 35,112 ch | 29 |
| [Callaghan Innovation](https://www.callaghaninnovation.govt.nz/) | 5,175 ch | 5 |
| [CreativeHQ](https://creativehq.co.nz/) | 3,796 ch | 3 |
| [NZ Growth Capital Partners](https://www.nzgcp.co.nz/) | 1,941 ch | 2 |

Blackbird's portfolio (already an AU seed) also carries NZ companies such as
**Halter**, and Startup Daily covers NZ rounds (e.g. **Outlier Space**, $10.5M
pre-seed).

### ❌ Rejected — JS-rendered, no extractable content

| Source | Extracted |
|---|---|
| NZTech (`/` and `/news/`) | 1,203 / 795 ch |
| AI Forum NZ (`/` and `/reports/`) | 1,445 ch both |
| Icehouse Ventures (`/` and `/portfolio`) | 925 / **141** ch |
| MBIE science-and-technology | **0 ch** |

**Structural finding: NZ ecosystem bodies are overwhelmingly JS-rendered**, far
more so than their Australian equivalents. The usable NZ sources skew to
government and encyclopaedic material, so NZ coverage will be weaker on named
startups and stronger on macro context. Rendering these would need Browser
Rendering (10 min/day on free) — not attempted.

### Combined AU+NZ brief — ❌ tried, and it failed

9 AU + 5 NZ = 14 seed sources at `maxIterations` 16 was run as `98adcf63` and
**died at iteration 11** on `Worker exceeded CPU time limit`, killed by the
1.84 MB redirect above. Do not re-run this shape. It was replaced by two standalone
runs — see `benchmark/AU-NZ-SPLIT.md`.

### Verdict after running both (2026-08-11)

| Brief | Run | Outcome |
|---|---|---|
| **AU standalone** | `76fb1813` | ✅ 12/12, full report, 1 Answered / 3 Partial / 1 Unanswered |
| **NZ standalone** | `0f4fdd5c` | ✅ 5/5 clean, but **0 Answered / 2 Partial / 3 Unanswered** |

**The NZ brief is not executable as written.** 98 of 108 chunks (91%) came from two
Wikipedia country articles and were never cited; the whole report rests on 10 chunks
from three small sites. The sources that would answer goals 1, 2 and 5 are NZTech,
AI Forum NZ and Icehouse Ventures — the JS-rendered ones rejected above. Either get
Browser Rendering onto those, or drop goals 1, 2 and 5 rather than let them come
back Unanswered every run.

**The AU brief needs a Workers Paid plan.** Goals 2 and 5 are answerable only from
`smallbizai`, which is HTML-only at 348 KB and cannot be parsed inside the ~10 ms CPU
budget. Its RSS feed exists, fills the 60,000-char cap, and contains **zero** hits
for `AI-native`, `Athena`, `Canva`, `fintech`, `proptech` or `240` — it is blog
posts, not the company guide. Full analysis and the CPU-safe alternative in
`benchmark/AU-SEEDS-PLAINTEXT.md`.

---

## 6. How to run it

> **As of 2026-08-12 this brief runs itself.** A cron (`0 16 * * *` = 04:00 NZST)
> starts the **plain-text, 3-goal** version daily from `control.daily_brief`; the
> report is written by ~05:50 NZST. See README §3.5.
>
> The 5-goal HTML brief below is the **original** and needs a **Workers Paid plan** —
> its seeds are 113 KB–1.8 MB of HTML against a 10 ms CPU limit (bugs.md #15). It is
> kept here as the record of what the full brief was, not as a runnable command.
>
> Goals 2 and 5 were **deleted** from the daily version, not merely left unanswered:
> both depend solely on `smallbizai`, which is HTML-only and whose RSS feed contains
> none of the company data (`benchmark/AU-SEEDS-PLAINTEXT.md` §3, §5). Goal 4 is on
> probation pending the first live run.

```sh
set -a; . ./.env; set +a          # WORKER_URL — see .env.example
W=$WORKER_URL

curl -X POST $W/start -H 'content-type: application/json' -d '{
  "topic": "The Australian AI startup ecosystem in 2026: who the companies are, which sectors they cluster in, how they are funded, and what distinguishes AI-native companies from AI-enabled incumbents.",
  "goals": [
    "Identify the main sectors where Australian AI startups concentrate, and which are growing fastest",
    "Establish how AI-native companies are distinguished from AI-enabled incumbents, and how the ecosystem splits between them",
    "Map the funding landscape: most active investors in Australian AI, typical stages, and notable recent rounds",
    "Identify the geographic clusters (Sydney, Melbourne, Brisbane, Perth) and what differentiates them",
    "Surface named example companies for each major sector, with sources"
  ],
  "sources": [
    "https://smallbizai.au/australian-ai-companies-complete-guide-by-industry-2026/",
    "https://en.wikipedia.org/wiki/Science_and_technology_in_Australia",
    "https://www.csiro.au/en/research/technology-space/ai",
    "https://www.startmate.com/portfolio",
    "https://www.cutthroughventure.com/reports",
    "https://www.startupdaily.net/",
    "https://www.innovationaus.com/",
    "https://blackbird.vc/portfolio",
    "https://techcouncil.com.au/"
  ],
  "maxIterations": 12
}'

curl "$W/state?run=<id>"                      # progress, findings, final report
curl "$W/search?run=<id>&q=agtech"            # semantic search over what it read
curl "$W/usage"                               # neuron spend vs daily budget
curl -X POST "$W/stop?run=<id>"               # halt at next assess
```

At the default 18-minute pacing, 12 iterations takes ~3.5 hours.

### The brief that actually runs daily

```sh
# Read / replace it — JSON in D1, so no deploy is needed to change it
npx wrangler d1 execute research-log --remote \
  --command "SELECT value FROM control WHERE key='daily_brief'"

# Force a run today after the cron has already fired
npx wrangler d1 execute research-log --remote \
  --command "DELETE FROM control WHERE key='daily_last_run'"
```

Source of truth on disk: `benchmark/run-payload-au-plaintext.json` (3 goals, 5
non-HTML seeds, `maxIterations: 6`, ~2,400 neurons ≈ 30% of the 8,000 budget).
**Keep the two in sync by hand** — D1 is what the cron reads; the file is only the
record of it.

---

## 7. Known limitations of the output

- **Findings are only as good as the seeds.** SmallBizAI carries most of the weight
  (41 of 111 chunks); a bias in it propagates.
- **The model may enqueue its own sources** (`MAX_SOURCE_DEPTH=2`) and it does
  hallucinate URLs. Bad ones fail the fetch and are recorded as failed sources
  rather than wedging the run — but check `/state` for what it actually added.
- **No recency guarantee.** Funding figures are whatever the pages said when read.
- **Not a dataset.** See §1. Company names will appear inside prose findings, not
  as structured rows.
- **HTML ingest needs a Workers Paid plan.** SmallBizAI alone is 242 KB, far past
  the Free plan's 10 ms CPU limit (README §4.2–4.3). **Settled 2026-08-12: staying on
  Free.** The daily brief therefore reads RSS and wikitext only.
- **The daily version cannot discover its own sources.** `MAX_SOURCE_DEPTH=2` is
  effectively 0 for plain text — RSS and wikitext expose no `<a href>` to harvest, so
  every source it will ever read is in the seed list. Source curation is a manual,
  human job now.
- **Macro-level findings only.** The two good RSS feeds carry recent posts, not
  industry datasets; the two Wikipedia articles are country-level. Expect sector and
  funding *signals*, not the 240-company mapping the original brief produced.
