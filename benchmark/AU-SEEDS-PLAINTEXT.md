# Converting the AU seeds to plain text

**Goal:** make the AU brief CPU-safe (bug #15) by seeding only sources whose
content-type is not `text/html`, so `fetchSource()` takes the cheap branch —
`if (!contentType.includes('html'))` in `src/ingest.ts` skips `HTMLRewriter`
entirely, ~1 ms instead of 20–241 ms.

**Result: it works, and it guts the brief.** Read §3 before running it.

---

## 1. Every AU seed is over budget

Raw byte sizes, measured directly. The largest page that has ever *passed* the CPU
limit here was 70,984 bytes at 11 ms:

| Seed | Raw bytes | Over the 71 KB pass mark |
|---|---|---|
| `en.wikipedia.org/wiki/Science_and_technology_in_Australia` | 1,836,550 | **26×** |
| `startupdaily.net/` | 840,816 | **12×** |
| `innovationaus.com/` | 426,746 | 6× |
| `startmate.com/portfolio` | 367,289 | 5× |
| `smallbizai.au/…-2026/` | 348,042 | 5× |
| `techcouncil.com.au/` | 280,382 | 4× |
| `blackbird.vc/portfolio` | 279,335 | 4× |
| `cutthroughventure.com/reports` | 134,265 | 2× |
| `csiro.au/…/ai` | 113,965 | 1.6× |

Not one of the nine is comfortably inside budget. This is not a tune-up.

## 2. What has a non-HTML equivalent

All probed through the live pipeline:

| Replacement | Content-type | Chars | Chunks | Verdict |
|---|---|---|---|---|
| `startupdaily.net/feed/` | `application/rss+xml` | 13,431 | 11 | ✅ **keep** — 57 "startup", 14 "funding", 10 "million" |
| `techcouncil.com.au/feed/` | `application/rss+xml` | 60,000 | 49 | ✅ **keep** — 28 "startup", 24 "investor" |
| `innovationaus.com/feed/` | `application/rss+xml` | 15,863 | 13 | 🔶 thin — 5 "artificial intelligence", 1 "startup" |
| `?title=Australia&action=raw` | `text/x-wiki` | 60,000 | 49 | 🔶 macro only |
| `?title=Economy_of_Australia&action=raw` | `text/x-wiki` | 60,000 | 49 | 🔶 macro only |
| `blackbird.vc/feed/` | — | — | — | ❌ HTTP 404 |
| `cutthroughventure.com/feed` | `text/html` | 7,574 | 6 | ❌ not a feed, returns the HTML page |
| `?title=Artificial_intelligence_in_Australia&action=raw` | — | — | — | ❌ HTTP 404, no such article |

### The one that matters: smallbizai has a feed and it is useless

`smallbizai.au/feed/` exists, returns `application/rss+xml`, and fills the
60,000-char cap — it looks like a perfect substitute. Searching the raw 117 KB feed
for the content that made the source valuable:

| Term | Hits |
|---|---|
| `AI-native` | **0** |
| `Athena` | **0** |
| `Archistar` | **0** |
| `Canva` | **0** |
| `fintech` | **0** |
| `proptech` | **0** |
| `240` | **0** |

The feed carries recent blog posts, not the 240-company industry guide. It fetches
cleanly, yields plenty of text, and contains none of the data the brief relies on —
**bug #16 exactly, caught this time before it reached a run.**

## 3. What the conversion costs

The AU report's substance came overwhelmingly from HTML-only sources:

| Lost source | What it uniquely supplied |
|---|---|
| `smallbizai.au/…-2026/` | 240 companies, the **2016 AI-native/AI-enabled rule**, Canva vs Atlassian, sector→company mapping |
| `startmate.com/portfolio` | Enrola, Firmus, 300+ startups, $4.5B portfolio value |
| `blackbird.vc/portfolio` | 130+ companies |
| `cutthroughventure.com/reports` | the standard AU venture funding dataset |
| `csiro.au/…/ai` | research-to-commercialisation pipeline |

Goals 2 and 5 are answerable **only** from `smallbizai`. Removing it does not
weaken those goals, it makes them unanswerable — and the two Wikipedia country
articles are the same material that produced **91% uncited chunks** in the NZ run
(`AU-NZ-SPLIT.md` §1).

Predicted outcome of `run-payload-au-plaintext.json`: goals 3 and possibly 1 answered
in part from the two good RSS feeds; goals 2, 4 and 5 unanswered. That is the NZ
result again — a run that executes flawlessly and answers nothing.

## 4. Recommendation

**Do not treat this as the fix for bug #15.** The plain-text list is worth having as
a *free-tier* profile — it will run unattended forever without hitting the CPU limit
— but it cannot answer this brief.

`README` §4.2 has said from the start that HTML ingest needs a **Workers Paid
plan**. Today's evidence closes that question: the AU brief requires
`smallbizai`, `smallbizai` is HTML-only at 348 KB, and 348 KB of HTML cannot be
parsed inside a 10 ms budget. Paid raises the CPU limit and the loop's own
`DAILY_NEURON_BUDGET` already caps AI spend at the free allocation, so the
incremental cost is the plan fee, not usage.

Two honest options, not one:

1. **Workers Paid** — keep the 9 validated HTML seeds and the report quality that
   `PROMPT-REWRITE.md` measured. Fixes bug #15 properly.
2. **Free tier, plain text** — use this payload, accept macro-level findings only,
   and drop goals 2 and 5 from the brief rather than leaving them to come back
   Unanswered every run.

Note that option 2 also disables autonomous discovery: non-HTML sources expose no
`<a href>`, so link harvesting yields zero candidates (`AU-NZ-SPLIT.md` §3).

---

## 5. Decision, 2026-08-12: option 2 — free tier, plain text

**Settled by the account owner.** The loop stays on the Workers Free plan and
`run-payload-au-plaintext.json` becomes the production brief rather than an
experiment. The cost comparison that informed it: Workers Paid is **$5.00/month**
(10M requests + 30M CPU-ms included, against a measured need of ~90k CPU-ms/month),
and Workers AI's 10,000 neurons/day free allocation is **identical on both plans** —
so the whole delta was the plan fee, and the whole benefit was HTML.

**What changed in the payload.** Goals 2 and 5 are **deleted, not demoted**. Both
depended solely on `smallbizai`; §3 above shows its feed contains zero hits for every
term that made it valuable. Leaving them in would manufacture an `Unanswered` verdict
every single run, which is noise dressed as rigour. The topic sentence lost its
AI-native/AI-enabled clause with them. Three goals remain.

**Goal 4 (geographic clusters) is kept on probation.** §3 predicts it unanswerable
from the two good RSS feeds, and it is the goal that produced the worst content bug
in the benchmark — run 2 answered about South Australia when asked about four
cities (`PROMPT-REWRITE.md`). It stays in because that is a *prediction*, and this
repo's rule is that briefs are settled by running them, not by reasoning about them.
If the first free-tier run returns it `Unanswered`, delete it the same way.

**Consequences accepted with the decision:**

- `MAX_SOURCE_DEPTH=2` is now effectively 0. Plain text has no `<a href>`, so the
  loop cannot expand its own source list — every source it will ever read is in the
  seed list above. Source curation becomes a manual, human job.
- Bug #15 is resolved by **source policy, not by code**. Nothing prevents a future
  seed being HTML; the guard against it is the probe habit in bug #16 —
  check `content-type` *and* `?action=raw` before adding a seed.
- The free plan cannot exceed 10,000 neurons/day, so Cloudflare itself remains the
  outer spend stop. That is the one advantage this option has over Paid, and it is
  why `DAILY_NEURON_BUDGET` must terminate the run *before* the platform does — see
  the analytics-vs-enforcement gap recorded in `HANDOFF.md`.

---

## §6 — Addendum 2026-08-17: what a seed's *visible window* is, and why it changed the sourcing rule

Written after four unattended daily runs and bugs.md #24. **The sourcing rule in §5 was
incomplete in a way that mattered, and a later claim built on it was simply wrong.**

### The rule that was wrong

Session 4 concluded, from three runs where goal verdicts improved, that *"the seeds that
pay are the ones that change"* — prefer live feeds over static reference pages. Both
halves of that need correcting:

- Goal 1 fell from **Answered** back to **Unanswered** on 2026-08-14 and stayed there for
  three runs, while `startupdaily.net/feed` was **frozen** (nothing published 08-14
  06:50Z → 08-17 ~01:00Z). The feed did not take the facts away.
- The feed still *contained* Farmbot ($22m), CUREator+ ($13.5m) and Alloy Robotics
  ($11.5m) throughout. The loop had stopped reading them.

The loop showed the model only the first 6 chunks — characters 0–7,600 of 13,162 — and
**RSS is newest-first**, so that is an eviction window. Four posts arriving in 24 hours
(two of them off-topic: e-bike laws, Pixel phones) pushed the goal-1 evidence past the
cut. Churn against a fixed window is a **liability**, not an engine.

### The rule that replaces it

**A seed's value is what is in its visible window, not what is in the document.** When
adding a seed, ask three things, in this order:

1. **Does it extract?** (§3's probe — `content-type`, `?action=raw`.)
2. **Is it about what you think?** (bug #16 — a 46-character `#REDIRECT` stub still
   reports as a successful fetch. Re-probed 2026-08-17: `Science_and_technology_in_Australia`
   is still exactly that.)
3. **Does the answer live inside the first `FRESH_CHARS` characters, and will it still be
   there next week?** This is the new one. A 44-chunk feed shows the model ~25% of itself;
   a 15-chunk feed shows ~55%; an 11-chunk feed shows all of it. **Prefer the smallest
   on-topic source over the largest**, which is the opposite of the instinct.

`FRESH_CHARS = 16_000` (from 2026-08-17) is "all of Startup Daily today" and is
**provisional** — it stops being that as the feed grows.

### Probed 2026-08-17, all through the Worker

| candidate | verdict |
|---|---|
| `smartcompany.com.au/feed` | ✅ real RSS, 18,718 ch / 15 chunks — best untested candidate |
| `techboard.com.au/feed` | ⚠️ real RSS, 53,517 ch / 44 chunks. **On-topic but not answer-bearing** — an iteration returns *"Techboard has published … artificial intelligence funding data reviews from FY18 to FY25, but the provided material does not specify the main sectors"*. The data is behind the article links |
| `australianfintech.com.au/feed` | ⚠️ 42,843 ch / 35 chunks — fintech only, poor window ratio |
| `stockhead.com.au/feed` | ❌ 1.27 MB, truncated at 60,000 |
| `startupdaily.net/category/funding/feed` | ❌ returns **`text/html`** — an 80 KB category page that fetches perfectly and reads as success. #15 + #16 in one URL |
| `cutthrough.vc/feed` (530) · `businessnewsaustralia.com/rss.xml`, `itnews.com.au/rss/all.xml`, `cyberdaily.au/feed`, `csiro.au/…?feed=rss`, `Artificial_intelligence_industry_in_Australia` (404) | ❌ |

**Probe through the Worker, never locally.** `techboard.com.au/feed` serves a Cloudflare
challenge page to a local `curl` and clean RSS to the Worker — the exact inverse of
`innovationaus.com/feed` (0/6 in runs, 6/6 in probes). Either direction of disagreement
will mislead you, and a local probe would have wrongly rejected a good source here.

### The standing conclusion for goal 1

**No plain-text AU source found so far carries sector-concentration data.** Goal 2
(notable rounds, active investors) is exactly what a news feed answers, and it has held
at `Partial` for four runs. Goal 1 wants a dataset, and §5's accepted consequence —
`MAX_SOURCE_DEPTH` effectively 0, no `<a href>` in RSS — means the loop cannot follow a
link to reach one. `a[href]` harvesting runs through HTMLRewriter and never executes on
XML, so this is structural, not a config gap.

Three options, none of them a code fix: **(a)** reframe goal 1 to what feeds can answer,
**(b)** hand-seed specific Techboard review URLs when they publish, **(c)** revisit
one-hop link-following for RSS `<link>` elements. Per §5's own rule, this is a brief
decision settled by running it, not by reasoning about it.
