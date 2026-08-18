# The AU brief: baseline and delta

**Decision, 2026-08-18.** Split the brief across two tiers. Claude Code builds a
periodic **baseline** — the distributions. The Cloudflare loop runs daily and reports
**deltas** against it — the instances. This is CLAUDE.md §8 ("use the fast, expensive
path to design and validate; the slow, cheap path to execute repeatedly") applied to
the brief itself, which is the one place it had never been applied.

---

## 1. The dividing line is not "quality", it is instances vs distributions

Two independent bodies of evidence say the same thing, and neither was collected to
answer this question.

**The 5-goal benchmark** (`BENCHMARK.md`) — every loop failure is a distribution, and
every loop success is an instance:

| the loop produced | the loop could not produce |
|---|---|
| Athena, Brighte, Airtasker, AirTree, Blackbird, Vexev $8.6M, Firmus $2.85B @ $15B | 240 companies / 17 sectors **with per-sector counts** |
| the 2016 AI-native founding-date rule | the 45% / 55% native-vs-enabled **split** |
| ~8 named companies, each with a source URL | A$1.7B across **64 rounds**, two-thirds AI share |
| — | **state-by-state table** with counts and specialisations |

**Eight production runs** say it again. Goal 1 ("identify the main sectors… and which
are growing fastest") has scored Unanswered · Partial · Answered · Unanswered ×3 ·
Partial ×2. It has never held. Goal 2 has been **Partial six runs running** and has
never once reached Answered.

**Goal 2's plateau has a cause, and it is the goal, not the loop.** It bundles three
clauses from two different tiers:

| clause | tier | outcome |
|---|---|---|
| "most active investors in Australian AI" | distribution → baseline | never answered |
| "typical stages" | distribution → baseline | never answered |
| "notable recent rounds" | instance → **loop** | answered every run |

A goal that mixes tiers cannot be scored Answered by either one. Six Partials in a row
is not a research result; it is the brief describing two jobs and grading them as one.

## 2. What this replaces

§6 left three options for goal 1. This decision is **option (a)** — reframe goal 1 to
what feeds can answer — carried out properly rather than by deletion, and it removes
the need for the other two:

- **(b) hand-seed Techboard review URLs when they publish** — the baseline pass does
  this better. Claude Code follows links, reads HTML and PDF, and searches; that is the
  entire reason the data behind those links was out of reach.
- **(c) revisit one-hop link-following for RSS `<link>` elements** — no longer needed.
  This is the option that would have cost the most: links lead to HTML, HTML costs
  15–644 ms CPU against a 10 ms limit, and that is the paid tier. **The free-tier
  decision survives intact.**

## 3. The revised brief

### Baseline — Claude Code, monthly

Quantitative by construction. A vague baseline cannot be diverged from, so each item
must state a number and a comparison period.

- **B1 · Sector distribution.** Per sector: count of AU AI startups and share of
  funding over the last 12 months. Which grew fastest, against a stated prior period.
- **B2 · Investor ranking.** Most active investors in AU AI by deal count over the last
  12 months, with portfolio counts.
- **B3 · Stage distribution.** Typical round size by stage — median and range.
- **B4 · Watchlist.** The named sectors, investors and companies the daily run should
  watch. Without this, "divergence" has nothing to test against.

### Daily — the loop, free tier

Verbs are **record**, **report**, **flag**. No verb in this list requires aggregation.

- **D1 · Record new events.** Every AU AI/tech funding event in today's sources:
  company, sector, amount, stage, investors, date, source URL. Report only events not
  already in the ledger.
- **D2 · Flag divergence from the baseline.** A sector taking rounds that B1 does not
  list among the concentrations; an investor absent from B2; a round size outside B3's
  range for its stage.
- **D3 · Silence is a valid result.** "No new events today" is correct output, not a
  failed run.

**D3 is not a nicety.** The loop currently must produce a finding every iteration, and
when the fresh material carries nothing new it satisfies that demand by restating
recalled material — which is the exact pressure that produced bug #25. Permitting an
empty result removes the incentive that manufactures false attribution.

## 4. What does not exist yet

Changing the goal text alone would hand tomorrow's run goals it has no mechanism to
meet. Three pieces, all small:

1. **The baseline must reach the prompt.** A `control.baseline` row alongside
   `daily_brief`, rendered as its own prompt block. Content needs no deploy; the block
   does.
2. **An event ledger.** A D1 table of recorded events, and an "already known" list in
   the prompt. **Exact match, not semantic** — and this is strictly better than the
   persistent-Vectorize design sketched on 2026-08-18, because change detection wants
   *identity*, not similarity. Recall's top-8 answers "what is related to this"; a
   ledger answers "have I already reported this", which is the actual question. Cheaper
   and more correct.
3. **The report vocabulary.** Answered / Partial / Unanswered does not describe a delta.
   A daily report wants *N new events, M divergences, or nothing changed*.

## 5. Seeds: churn inverts from liability to asset

§6 concluded that "churn against a fixed window is a liability". That holds **only
while the loop re-derives its answer daily**. Once each day's events are captured to a
ledger, a fast-turnover feed is an *advantage* — it is the one that carries new events —
and eviction stops mattering because nothing needs to still be there tomorrow.

Measured: `startupdaily.net/feed` holds 10 items and replaced 9 of them in 43 hours
(2026-08-17 00:44Z → 2026-08-18 19:51Z). Under re-derivation that destroyed a verdict.
Under capture it is simply five events a day arriving on schedule.

Consequences: `smartcompany.com.au/feed` (18,718 ch / 15 chunks, §6's best untested
candidate) is now worth adding, since detection wants coverage more than depth. And a
**missed day loses events permanently** — the watchdog stops being a convenience.

## 6. The cost claim, stated accurately

The loop is already free: ~1,150 neurons/day against a 10,000/day allocation. So this
does **not** save money by replacing Claude Code with the loop — nobody was running
Claude Code daily.

| approach | monthly | answers the goals? |
|---|---|---|
| Claude Code daily | ~$300 | yes |
| **Baseline monthly + loop daily** | **~$10** | **yes** |
| Loop alone (today) | $0 | no — eight runs, no distribution ever answered |

The honest framing: it converts a free job that answers no aggregate question into a
free job that produces daily deltas, for ~$10/month. And it **compounds** — the ledger
becomes the next baseline's input, so Claude Code reads accumulated events instead of
re-crawling for them.

## 7. Sequencing

1. **The 2026-08-19 16:00Z run stays on the current brief.** It is the first live test
   of bug #25's report half. Changing the brief the same day confounds the one
   observation it exists to produce (§11, §12).
2. Claude Code baseline pass → B1–B4.
3. Build §4's three pieces.
4. Switch the brief, and read the first delta run before touching anything else.
