# Session handoff — session 9, 2026-08-20

**The baseline existed only as a plan. `GET /baseline` returned `""`.** Every delta report
to date printed `## Divergence from baseline → None.`, which reads as *checked and clean*
and meant *nothing to check against*. Both halves fixed this session: the report no longer
fakes the measurement, and the baseline now exists.

## The daily cron holds 04:00 NZ across DST — deployed `3602f68b`

`0 16 * * *` was 04:00 NZST and would have become 05:00 NZDT on 2026-09-27. Cron
Triggers are UTC only, so the fix is **two arms, one gate**: `0 15` and `0 16` are both
registered and both fire daily, and `scheduled()` starts a run only on the arm equal to
`dailyCronFor(controller.scheduledTime)` — the expression that is 04:00 in
`Pacific/Auckland` for that instant. The other arm logs and returns.

- `scheduledTime`, not `Date.now()`: the arm is a property of the instant scheduled, so
  an invocation lagging across an hour boundary cannot pick the wrong one.
- The offset comes from `Intl` `longOffset` and **throws** if unreadable — an unparsed
  offset must not silently become UTC and move the run twelve hours (CLAUDE.md §10).
- If no registered arm matches (a zone moved to a non-whole-hour offset), both arms
  alert to Discord. A day with no research must not cost one log line.

**Verified two ways, and neither is the arithmetic on its own.** Simulating both arms
across 365 UTC days from 2026-08-20 gives **365 distinct local days, every start at
04:00**: no skipped day at the September transition, no double run at the April one.
Then the shipped handler on the real runtime (`wrangler dev --remote --test-scheduled`,
fresh port 8799) was fired on the NZDT arm and printed the arm it computed **from
inside the code path** — CLAUDE.md §12:

```
[daily] "0 15 * * *" is the off-DST arm today (want "0 16 * * *"); skipping
```

The matching arm was deliberately **not** fired: today's daily run had not yet been
claimed, so it would have started a real one.

## The baseline was never corrupted — the reader was

Reported here as mojibake in D1, and it was not. `json.load(sys.stdin)` decodes the pipe
as **cp1252** on Windows, so every read turned stored UTF-8 into `â€"`. The proof is that
the *same* read reported 6,501 mojibake chars **after** a re-post the Worker acknowledged
as `chars: 6434`. Read as bytes and decoded UTF-8, live matches the committed file exactly
— `d18d6d14…`, the hash recorded below. The re-post was a no-op; no daily prompt ever saw
garbled figures.

**Verify the baseline with an explicit encoding, never through a locale-decoded pipe:**

```sh
curl -s "$WORKER_URL/baseline" | python -c "
import json,sys,hashlib
live = json.loads(sys.stdin.buffer.read().decode('utf-8'))['baseline']
print(len(live), hashlib.sha256(live.encode('utf-8')).hexdigest())"
# 6434 d18d6d1414e1ceb36a64b04e2ffb31daa7fd8dfed8b1dabc7d3488e451506415
```

CLAUDE.md §12 pointed at the instrument: two witnesses disagreed, and the one with a
locale in its path was the one to distrust.

## bugs.md #30 — "None" and "never measured" were the same word

CLAUDE.md §10 moved out of the spend guard and into the deliverable. `?? 0` made
"unmeasurable" and "free" the same number; an empty baseline made "not measured" and
"clean" the same word. The `findings.length === 0` early return was worse — a run that
produced no findings at all still asserted the measurement.

`synthesise` now owns the section when the baseline is absent:

1. writes `Not measured — no baseline recorded.` in code
2. `NO_BASELINE_RULE` asks the model to omit its own
3. `dropSection()` removes it if the model emits one regardless

**Step 3 is not redundant.** Instruction has lost to this model on this exact surface
twice (#25, #28); on #28 it re-offered an event it had just been shown under
`ALREADY RECORDED`. An invariant enforced by asking is not enforced.

## The baseline — `baseline/AU-AI-FUNDING-2026H1.md`

6,434 chars, posted to `control.baseline`, verified **byte-identical by sha256**
(`d18d6d14…`). Content needs no deploy; the prompt block already shipped.

Source is Cut Through Venture, whose sector taxonomy is stable quarter to quarter.

- **B1** sector capital *and share* for H1 2026, plus Q1→Q2 growth. Share is the unit that
  survives quarter-size variation: AI models & data infrastructure is $100M → $730M in
  dollars but **5.6% → 42.6% of the quarter**, and the second pair is what a daily event
  can contradict.
- **B3** median round size by stage across CY2025 / Q1 2026 / Q2 2026. Series A has nearly
  doubled in eighteen months ($11.0M → $12.5M → $18.6M).
- **B4** the taxonomy as a watchlist, plus a second divergence test derived from shares — a
  run of rounds in any sector whose H1 share was under 5%.
- **B2 is NOT MEASURED**, deliberately. See below.

### Three labelling rules the document follows, and why

- **Constructed numbers are labelled constructed.** Cut Through publishes medians, not
  ranges, so the ⅓×–3× round-size bounds are a stated choice. Q4 2025 is CY2025 minus
  three published quarters and carries ±$400M, because **three different CY2025 totals
  circulate** — $5.4B (Cut Through), $5.48B, $5.1B. Marked "use for shape, never as a
  number". Unlabelled, a subtraction reads as a measurement within a month.
- **Coverage limits are inline.** Q1 2026's sector list is a **top ten** summing to $1.63B
  of a stated $1.8B, so "not listed" means *below $76M*, not zero — and the CY2025 taxonomy
  differs ("Artificial Intelligence", "Biotech/Medtech"), so only fintech survives the
  boundary and growth must not be computed across it. Without these two paragraphs the
  baseline manufactures a divergence every week and each one looks real.
- **Grants are excluded.** QIC Ventures and state programmes are not venture rounds and are
  not in these figures.

## B2 has no source, and it cancelled a workstream

**No one ranks Australian investors by deal count.** Not Cut Through, across its entire
published insights catalogue (checked directly). The ranked lists that surface in search
are aggregator pages whose counts cite nothing.

Session 7 deferred the baseline pass reasoning that the *ledger's* investor coverage — 2 of
4 rows — made B2 "weakly comparable", and queued extraction work. **Wrong side.** At 4 of 4
there would still have been nothing on the other side of the comparison. Do not restart
that workstream on B2's account.

Now CLAUDE.md §5: *the brief is a source, and it is the one never probed. Before building
the thing that produces one side of a comparison, fetch the other side.*

## What could NOT be built, so the next pass does not retry it

**A trailing twelve months of sector data does not exist.** `cut-through-quarterly-3q-2025`
publishes no sector dollars and no stage medians — only qualitative leaders. Q2 2025 gives
one sector figure (Airwallex $232M) and no medians; Q1 2025 gives three sectors and no
medians. That is why the sector table stops at H1 2026. Recorded in the document's
provenance section.

Quarterly volume *is* complete: Q1 2025 $993M/100 · Q2 2025 $812M/76 · Q3 2025 ~$1.0B/116 ·
Q4 2025 **derived** ~$2.6B/~98 · Q1 2026 $1.8B/107 · Q2 2026 $1.7B/69.

## State, 2026-08-20 ~12:30Z

- Deployed **`4aefad14`**. Code identical to `a03a0ffa`; only the baseline data changed
  after it. Pre-deploy gate ran on both deploys and exits non-zero on anything in flight.
- 0 runs `running`, 0 workflow instances. Spend 1,174 / 10,000.
- Ledger: 4 rows. Sources: startupdaily, techcouncil, startupsmart.
- `npm test` → **40 passed**, `npm run typecheck` clean.
- Commits `2f508d2` (fix + baseline) and `9c819f2` (shares + derived label), both pushed.

## The next observation, and the failure mode to read for

Today's 16:00Z run is **the first with something to diverge from**. Predicting is cheap;
this is the falsifiable part:

**The risk is over-flagging, not under-flagging.** The loop's sectors are free text off
RSS — "travel", "biotech", "space", "AI" — and if they do not map onto the Cut Through
taxonomy, nearly every event becomes a spurious sector divergence. Checking the four
ledger rows by hand: Nybro's $20M Seed genuinely breaches the $12.0M seed ceiling;
Sophiie AI's $5M Seed genuinely does not; **Visaible.ai's "travel" is the ambiguous case**
and is the one to look at first.

If the divergence section is long and mostly about sector labels, the fix is a mapping
step in code, not a stricter prompt — the same conclusion #25 and #28 reached.

Cost added: ~1,600 input tokens on each of ~3 reasoning calls.

## Unchanged, still open

- **#20** the window shape.
- **#19** the retry path — 7+ clean reconciliations, still never exercised by a real retry.
- **The NZ brief** — still undecided.
- **`qwen3-embedding-0.6b`** — explicitly deprioritised by the user, not started.
- **Standing rules:** commit only when asked, push only when asked, secret scan gates the
  push, never deploy inside the 16:00Z window. `TaskStop` does not reliably kill
  `wrangler dev` — kill parents and verify the port (#26).
- **`POST /start` is blocked by the permission classifier** in this environment, so live
  `/step` verification needs the user to run it or to grant the rule. Local pure-function
  tests covered the prompt path instead.

---

# Session handoff — session 8, 2026-08-19

**First delta run worked.** `35e0c08b`, 16:01→16:38Z, 3/5, sources-exhausted. One new
event (Nybro, biotech, $20m Seed, QIC Ventures), correctly cited, and dedupe held —
iteration 2 named Sophiie AI and Visaible.ai as already recorded and they stayed out of
the report. **Zero false positives and zero false negatives against the feed**: Canva's
$11bn write-down and WiseTech's share drop were both correctly ignored in production.

**Three defects found and fixed** — bugs.md #27, #28, #29. Deployed `4b67748a`.

- **#27** the ledger keyed on `company+stage`; the run measured stage present on 2 of 4
  rows and amount on 4 of 4. Re-keyed on `company + normAmount(amount)`. The four
  existing rows were **migrated** using the Worker's own `eventKey`, not a reimplementation.
- **#28** the report's "New events" came from the model's prose, so an event the ledger
  had rejected could still be announced as new. Now rendered from `eventsForRun()` in
  code — the model is handed the answer. Prompting had already failed three times on
  this exact behaviour.
- **#29** `smartcompany.com.au/feed` carries **no funding events at all**; it was added on
  a shape probe. §5 verbatim. Swapped for `startupsmart/feed`.

**`npm test` now exists** — 31 assertions, in the repo, so it survives the session.

## The sourcing result worth remembering

**There is no second daily Australian funding-event feed among the candidates tested.**
Startup Daily is the engine. techboard publishes *reviews* → that is Claude Code baseline
material, not delta material. Google News RSS returns 1 Australian item in 13 (`gl=AU`
sets the edition, not the subject). StartupSmart's roundups name companies but the
amounts are behind the link — which is why an event with no amount is no longer
recordable.

## State, 2026-08-19 22:05Z

- Deployed `4b67748a`; 0 runs running, 0 instances; `daily_last_run` = 2026-08-19, so
  tomorrow fires. Spend today 1,174 / 10,000.
- Ledger: 4 rows, keys migrated. Brief: startupdaily, techcouncil, startupsmart.
- **No baseline yet.** Still the right call — see below.

## The baseline: now unblocked, and here is what it must quantify

Session 7 deferred it until the ledger showed which fields survive. It has:

| field | present |
|---|---|
| company, amount | 4 of 4 |
| sector | 4 of 4 (but one is "AI", which is not a sector) |
| stage | 2 of 4 |
| investors | 2 of 4 |

So **B3 "typical round size by stage" is not comparable** against a ledger whose stage is
half empty, and **B2 "most active investors" is weakly comparable**. Build B1 (sector
distribution) and a round-size distribution *without* stage first; treat stage and
investor coverage as something to improve in extraction before B2/B3 are worth writing.

---

# Session handoff — session 7, 2026-08-18

**Session 7 in one line:** bug #25 fixed and verified in production, and the AU brief
was split across two tiers — Claude Code baselines the *distributions*, the loop tracks
*instances* daily against a ledger. Deployed `a2796766`. **Tomorrow's 16:00Z run is the
first delta run.**

## What to read first tomorrow

1. **The Discord digest** — the run now pushes its result on completion. `N new
   event(s)` plus one line per event. If nothing arrives, the run did not finish.
2. `GET /events` — the ledger, newest first.
3. `GET /state?run=<id>` — the delta report itself.

**What would tell us to pivot**, in order of likelihood:

| symptom | means | fix |
|---|---|---|
| `events=0/0` every iteration | the model is not emitting event lines at all | prompt, not plumbing |
| events extracted but `eventsInserted` 0 | dedupe key too loose — everything looks known | `eventKey` in prompt.ts |
| the same round reappears daily under a new key | dedupe key too tight (name written differently) | `eventKey`, or normalise harder |
| valuations / "seeking" rounds recorded | extraction criteria | already tightened once, see below |
| report says "None today." on a day with new items | findings carry events but the report drops them | REPORT_SYSTEM |

## State as of 2026-08-18 21:30Z

- **Deployed `a2796766`.** Budget restored to **10000** (was 8000 — see the comment in
  `wrangler.jsonc`, which keeps the measurement that argued for the lower number).
- **New brief installed in D1** (`control.daily_brief`): topic is delta tracking, two
  goals (record events / flag divergence), **3 sources** — startupdaily, techcouncil,
  smartcompany. **Both Wikipedia seeds and innovationaus were dropped**: static pages
  carry no events and were the vehicle for #25; innovationaus is 0/6 in real runs.
- **Ledger holds 3 real events** from the 21:23Z test (Visaible.ai, Sophiie AI, Space
  Angel). Left in deliberately, so tomorrow's run exercises the dedupe path rather than
  starting empty.
- **No baseline yet** — `control.baseline` is empty, so divergence flagging is inactive
  by design and the prompt says so. See "the baseline" below.
- Spend on UTC 08-18: ~2,600 neurons of 10,000 (1,091.79 daily run + ~763 #25
  verification + ~750 delta verification). **08-18's reconciliation is polluted.**

## Bug #25 — fixed, both halves verified

Finding level (run `9c936389`) and **report level** (run `f2539796`, 21:21Z): iteration 2
read the `Australia` wikitext and the report cited **techcouncil** for the $248.5bn
figure, with the Wikipedia URL appearing nowhere. Every run before this cited Wikipedia.

The entry's own recommended fix was a no-op — `prompt.ts` had rendered `from <sourceUrl>`
on recalled excerpts since the first run. Root cause was a data model: one attribution
slot per finding, and the report *instructed* to copy it onto every claim.

## The baseline is deliberately not built yet

`benchmark/AU-BRIEF-DECISION.md` §4 calls for a Claude Code baseline (B1 sector
distribution, B2 investor ranking, B3 stage distribution, B4 watchlist). It is **not
done**, and the reason is technical rather than scheduling:

**A baseline written before we have seen what the ledger actually captures will be the
wrong shape.** Its only job is to be diverged *from*. Today's first extraction shows the
model reliably gets company, sector and amount, but **stage was null on 2 of 3 events and
investors on 2 of 3**. A baseline quantifying "typical round size by stage" cannot be
compared against a ledger whose stage field is usually empty. Two or three days of real
events tells us which fields to build B1–B3 around.

**Do this after ~3 days of ledger data**, not before.

## Known rough edges, day zero

- The model still writes `AI` as a sector sometimes (Sophiie AI), despite an explicit
  rule against it. Cosmetic; watch whether it spreads.
- `eventKey` is company+stage. A round reported with a stage one day and without it the
  next produces **two rows**. Unmeasured — this is the most likely early defect.
- The 60-entry "already recorded" prompt window is a guess at ~2 weeks of events.

---

# Session handoff — session 6 reading, 2026-08-17

State of play for the next session. Everything below is on disk; nothing is held
only in conversation.

**Session 5 in one line:** session 4's central claim — *the live feed is the engine* —
was **wrong**, and the real mechanism is a six-chunk prefix that silently destroyed a
verdict. Fixed, measured and shipped (bugs.md #24). Two new bugs logged: #25 (false
attribution through recall, **open**) and #26 (an eight-sample experiment that tested
nothing).

✅ **Shipped 2026-08-17 04:07Z** — deployed (`15f2e432`), committed (`ebeb1f4`,
`8d1cd07`) and pushed. Repo, deployment and GitHub are in sync. **Today's 16:00Z run is
the first to read a 16,000-character window**, so it is the observation that matters.

---

## ✅ Daily runs `b099c83d` · `dc0a0b39` · `8772de4e` — 08-14, 08-15, 08-16, all 16:00Z

All three fired on schedule, ran 5 of 6, ended `sources-exhausted` at ~73 min. The
autonomy question stays settled. **The research question got a real answer, and it is
not the one session 4 recorded.**

### 1. Goal 1 regressed, and the feed was not the cause

| Goal | `4306b012` | `9174a7bc` | `5a8c9aeb` | `b099c83d` | `dc0a0b39` | `8772de4e` |
|---|---|---|---|---|---|---|
| 1 · sectors | Unanswered | Partial | **Answered** | **Unanswered** | Unanswered | Unanswered |
| 2 · funding | Unanswered | Unanswered | Partial | Partial | Partial | Partial |

`startupdaily.net/feed` published nothing between 2026-08-14 06:50Z and at least
08-17 00:50Z, so all three losing runs read **byte-identical material** — and that
material still contained Farmbot, CUREator+ and Alloy Robotics. The loop stopped
reporting facts that were still in front of it.

Cause: `pieces.slice(0, FRESH_EXCERPTS)` with `FRESH_EXCERPTS = 6` is a **newest-N
window** on a newest-first feed. Four posts arriving in 24 h pushed the agtech/biotech
evidence past character 7,600 of 13,162. Full offset map and measurement in bugs.md #24.

**Measured, 11 `/step` samples against the frozen feed:** CUREator+ **0/8 → 3/3**,
Alloy Robotics **0/8 → 2/3**, Farmbot 3/8 → 3/3 once the whole feed is shown. One
sample reconstructed the agtech/biotech *sector* framing unprompted.

**Fixed** with a character budget (`freshExcerpts()` in `ingest.ts`,
`FRESH_CHARS_DEFAULT = 16_000`) used by both the workflow and `/step` — show the source
whole when it fits, bound the prompt when it does not. Cost +36% per iteration,
~1,054 → ~1,325 neurons per run. **Deployed `15f2e432` at 04:07Z on 08-17.**

### 2. The reconciliation is clean, and the expected excess was not there

UTC 2026-08-14, two identical GraphQL reads 3 min apart, byte-identical:

| model | ours | Cloudflare | diff | calls |
|---|---|---|---|---|
| `llama-3.3-70b-instruct-fp8-fast` | 905.735481262207 | 905.735481262207 | **0.000000000** | 6/6 |
| `bge-small-en-v1.5` | 148.581587 | 148.568135806 | +0.013451 (+0.00905%) | 14/14 |

**The three out-of-band probes are on UTC 08-13, not 08-14** — they were made on the
morning of the 14th NZST. Nothing to subtract; the only gap is the published-rate
rounding, and we over-record. That bias reproduced on 08-14, 08-15 and 08-16 with three
different token totals — genuine replication, unlike session 4's "four scales."

`bge-m3` returns **no usage object and Cloudflare still bills it** (0.007522115 in
analytics). Unmeterable by us is not unbilled; its disqualification is stronger, not
weaker. 6 reasoning + 14 embedding calls every day, exact — so **#19's retry accounting
is now untested across four consecutive clean reconciliations.**

### 3. The prediction, scored

Recorded: *"goal 1 holds at Answered or slips to Partial, goal 2 holds at Partial, and
the specifics change while the verdicts do not."* Goal 2 held ✅. Goal 1 fell to
**Unanswered**, past its predicted floor ❌. Specifics changed ✅ **and** the verdict
moved with them ❌. Neither offered branch was right: the third case — specifics and
verdict both moved while the *source material did not* — is the one that identified the
bug. The mechanism was not backwards, it was one level too coarse.

---

## ✅ Daily run `5a8c9aeb` — 2026-08-13 16:00→17:13Z — both fixes confirmed unattended

Fired on schedule, ran 5 of 6 iterations, ended `sources-exhausted`. First run
carrying **both** the #22 and #23 fixes, and it exercised each of them against the
real thing rather than a manufactured test case.

### 1. #22 closed on the exact claim that exposed it

`innovationaus.com/feed` 403'd again — **0 of 3 in real runs now** — and iteration 3
recorded `source_url = null`. **The report cites it nowhere.** The $248.5bn / 8.9%-of-GDP
figure, falsely attributed to that dead fetch on both previous runs, is now cited to the
two Wikipedia sources that actually supplied it. Nobody was watching; the fix simply held.

### 2. Both goals moved, for the first time

| Goal | `4306b012` | `9174a7bc` | **`5a8c9aeb`** |
|---|---|---|---|
| 1 · sectors | Unanswered | Partial | **Answered** |
| 2 · funding | Unanswered | Unanswered | **Partial** |

With specifics that had been missing all week: agtech (Farmbot, **$22m Series B**),
biotech (**$13.5m** across 6 startups via CUREator+), Alloy Robotics **$11.5m Seed**,
software engineering roles +7% YoY. No `Unanswered` verdict anywhere in the run.

⚠️ **THIS SECTION'S CONCLUSION WAS WRONG — withdrawn 2026-08-17, see the session 5
block above and bugs.md #24.** It read: *"the daily cadence against live feeds is what
produces movement … the seeds that pay are the ones that change."* Three runs agreed, but
the feed refreshed in all three, so nothing varied and the honest n was 1. When the feed
froze for the next three runs the verdict moved anyway. The operative event is
**eviction**, not arrival: a six-chunk prefix on a newest-first feed drops older items as
new ones land, so churn against a fixed window is a liability rather than an engine.
Retained unedited as the record of what was believed.

### 3. The reconciliation is now a query, not an argument (#23)

| model | Cloudflare | ours | diff | calls |
|---|---|---|---|---|
| `llama-3.3-70b-instruct-fp8-fast` | 994.9426 | 994.9426 | **0.0000** | 7/7 |
| `bge-small-en-v1.5` | 160.8152 | 160.8298 | +0.0146 | 17/17 |

Exact on reasoning; +0.0091% on embeddings — the published-rate rounding, now the same
signature at four scales. 7 reasoning calls = 5 iterations + 1 report + 1 out-of-band
`/step`, so the count reconciles to a nameable set of calls. Day total 2,213 neurons
against the 8,000 budget.

**#19's retry accounting is still untested.** This run had no retries either. Every
reconciliation so far has been of a run in which nothing failed after an AI call
returned — worth saying out loud precisely because the PASS above looks conclusive.

### 4. Correction: the monitor is fine

Session 4 recorded that the monitor "caught the outcome; it is not a liveness signal,"
on the strength of run `9174a7bc` emitting one event 65 minutes late. **This run emitted
all six on time** — start 16:01Z, iterations 16:19 / 16:37 / 16:56 / 17:14, terminal at
17:14Z. One good, one bad, cause unknown. The earlier note generalised a design verdict
from a single sample, which is the error this bug log keeps recording under other names
(#22's "bot-blocked", #22's five-probe burst). Discord remains the alarm of record.

---

## 📋 Opening prompt for session 6

Paste this to start. Same habit that found #24: read the run before touching anything.

> Read first, build nothing yet. Report on the 16:00Z run of 2026-08-17 before proposing
> any work. It is the **first unattended run carrying the #24 window fix**
> (`FRESH_CHARS_DEFAULT = 16_000`, deployed `15f2e432` at 04:07Z), so `8772de4e` is the
> last 6-chunk run and this is the first at 16,000 characters.
>
> **Four questions, in this order:**
>
> 1. **Did it fire, and did it finish?** `sources-exhausted` at 5/6 is the expected shape.
>    Anything else is the story — and note the day already carried ~3,500 neurons of
>    session-5 experiments before the run started, so check the budget guard did not trip.
> 2. **Did goal 1 come back?** Answered on `5a8c9aeb`, then Unanswered on the three runs
>    after. #24 recovered the *evidence* at the finding level (CUREator+ 0/8 → 3/3, Alloy
>    0/8 → 2/3). **The finding → verdict step has never been observed.** That is the only
>    claim in the #24 write-up I did not measure, and this run is its test.
> 3. **Two variables changed, not one — do not credit the window alone.** The feed thawed
>    (Sophiie AI, $5m Seed) between the measurement and the deploy, so a recovery is
>    confounded exactly the way session 4's was. **The distinguishing evidence: are the
>    cited specifics the previously-evicted ones (Farmbot $22m, CUREator+ $13.5m, Alloy
>    $11.5m) or the new arrivals?** Evicted ones returning ⇒ the window. Only new items ⇒
>    ordinary feed churn and #24's verdict-level effect is still unproven. Say which, and
>    say what would distinguish them.
> 4. **Reconcile per model** — `/usage?day=2026-08-17` against `aiInferenceAdaptiveGroups`,
>    stable across **two identical reads**, not until something moves. Expect ~1,325
>    neurons for the run (+36% from the wider window, *estimated from one source, not
>    measured on a run*) on top of ~3,500 already spent, so ~4,800 for the day against the
>    8,000 budget. `bge-small` should read ~+0.009% **high on our side**; reasoning should
>    match exactly. A retry would finally exercise #19 — check for it, because five clean
>    reconciliations in a row have been structurally incapable of testing it.
>
> **My prediction, recorded so it can be wrong:** goal 1 returns to Answered or Partial and
> cites at least one of Farmbot / CUREator+ / Alloy; goal 2 holds at Partial; the run costs
> 1,250–1,450 neurons. If goal 1 stays Unanswered with the whole feed visible, the window
> was not the binding constraint and the problem is the report step or the source itself —
> in which case #24 is a real fix for a real bug that was not the one blocking goal 1.
>
> **Then, in order:**
> 1. **Bug #25** — false attribution through recall, the open correctness bug. A source
>    that fetches perfectly gets credited with another source's facts, including the
>    `$248.5bn / 8.9% of GDP` figure cited to Wikipedia by every report to date. The fix is
>    identified and cheap: `Recalled.sourceUrl` is already carried into the prompt.
> 2. **The AU source list** — a *brief* decision, not a code task. No plain-text source
>    found answers goal 1; the three options are in `benchmark/AU-SEEDS-PLAINTEXT.md` §6.
> 3. **The standing three:** #20's window shape, #19's retry path, the NZ brief.
>
> **Do not** start the `qwen3-embedding-0.6b` experiment unless the above is clear — it is
> a new Vectorize index and a full re-embed, not a config change.
>
> Standing rules: commit only when I ask, push only when I ask, secret scan gates the push,
> and never deploy inside the 16:00Z window. `TaskStop` does not reliably kill
> `wrangler dev` — kill parents and verify the port (bugs.md #26).

---

## 👉 Start here next session

0. **Read today's 16:00Z run first — it is the #24 fix's first unattended test.**
   Deployed 04:07Z, so `8772de4e` is the last 6-chunk run and today's is the first at
   16,000 characters. The question is narrow: **does goal 1 return to Answered, and on
   what specifics?** A finding-level recovery is already measured (0/8 → 3/3); the
   finding → *verdict* step is not, and that is exactly what this run tests.
   Two cautions. **`FRESH_CHARS_DEFAULT = 16_000` is feed-specific** — it is "all of
   Startup Daily today" and stops being that as the feed grows, so the number is
   provisional even though the unit is right. And **the feed thawed** (Sophiie AI, $5m
   Seed), so this run differs from the measured ones in two ways, not one: bigger window
   *and* new content. If goal 1 recovers, resist crediting the window alone — that is
   the same single-variable error session 4 made, and §11 applies to good news too.
1. **The AU source list — narrower beats more.** #24 changes this brief. Adding a sixth
   seed adds another source competing for recall's top-8 and another iteration's window;
   the lever that actually moved the outcome was showing one source *properly*. Probed
   2026-08-17, all through the Worker:

   | source | verdict |
   |---|---|
   | `smartcompany.com.au/feed` | ✅ real RSS, 18,718 ch / 15 chunks — the best untested candidate |
   | `techboard.com.au/feed` | ⚠️ real RSS, 53,517 ch / 44 chunks. **On-topic but not answer-bearing**: an iteration returns *"Techboard has published … artificial intelligence funding data reviews from FY18 to FY25, but the provided material does not specify the main sectors"*. The data is behind the article links, and RSS link-harvesting does not exist (`a[href]` via HTMLRewriter never runs on XML) |
   | `australianfintech.com.au/feed` | ⚠️ 42,843 ch / 35 chunks — fintech only, poor window ratio |
   | `stockhead.com.au/feed` | ❌ **1.27 MB, truncated at 60,000** — the §5 shape |
   | `startupdaily.net/category/funding/feed` | ❌ returns **`text/html`**, an 80 KB category page. Fetches perfectly, 12,049 ch, 10 chunks, reads as success — #15 + #16 in one URL |
   | `Science_and_technology_in_Australia` (wikitext) | ❌ **46 characters**: `#REDIRECT [[Australia#Science and technology]]`. #16's original case, still live |
   | `cutthrough.vc/feed` 530 · `businessnewsaustralia.com/rss.xml`, `itnews.com.au/rss/all.xml`, `cyberdaily.au/feed`, `csiro.au/…?feed=rss`, `Artificial_intelligence_industry_in_Australia` 404 | ❌ |

   **The honest conclusion: no plain-text AU source found so far carries sector-concentration
   data directly.** Goal 2 (notable rounds, investors) is exactly what a news feed answers,
   and it has held at Partial for four runs. Goal 1 wants a dataset, and under decision 1
   the loop cannot follow a link to reach one. The options are (a) reframe goal 1 to what
   feeds can answer, (b) hand-seed specific Techboard review URLs when they publish, or
   (c) revisit link-following for one hop. **This is a brief decision, not a code task.**

   ⚠️ **Probe through the Worker, never locally.** `techboard.com.au/feed` returns a
   Cloudflare challenge page to a local `curl` and clean RSS to the Worker — the exact
   inverse of `innovationaus.com/feed`. A local probe would have wrongly rejected it.
2. **Consider `@cf/qwen/qwen3-embedding-0.6b` for embeddings** — measured 2026-08-14,
   one probe per candidate through the REST API:

   | model | neurons/M in | dims | `usage` returned |
   |---|---|---|---|
   | `@cf/baai/bge-small-en-v1.5` (current) | 1,841 | 384 | tokens, **no `neurons`** |
   | `@cf/baai/bge-m3` | 1,075 | 1024 | **`null` — nothing at all** |
   | `@cf/qwen/qwen3-embedding-0.6b` | 1,075 | 1024 | tokens **and `neurons`** |

   **`bge-m3` is disqualified, and not on price.** It returns **no usage object**, so it
   cannot be metered from `neurons` *or* from tokens — it would route straight to
   `priceCall`'s loud-error path and record 0 forever. That is #21 by construction
   (CLAUDE.md §10). It is the cheaper, stronger model on paper and it is unusable here.

   **`qwen3-embedding-0.6b` is the interesting one**: same 42%-cheaper rate, and it
   **returns `usage.neurons`** — the field bge-small lacks. Adopting it would delete the
   entire rate-table branch of `priceCall` for embeddings and make #21's failure mode
   impossible rather than merely fixed. Its 7-token probe returned `0.0075221` against
   `7 × 1075/1e6 = 0.0075250` — the published rate fractionally high, the same signature
   as everything else here.

   **Cost is not the reason** (embeddings are ~7% of a run's spend); *metering
   robustness* and recall quality are. **The blocker is 1024-dim against a 384-dim
   index** — Vectorize fixes dimension at creation, so this is a new index plus
   re-embedding everything, not a config change. Scope it as an experiment.

   ⚠️ Those three probes are **out-of-band spend on UTC 2026-08-14** (~0.02 neurons,
   3 calls) and will show as a small unexplained gap in tomorrow's reconciliation.
   This is the same pollution that made the 2026-08-12 delta ambiguous (#23).
3. **`innovationaus.com/feed` — 0/3 in runs, 5/5 in probe bursts.** Still unexplained,
   and no longer urgent: #22's fix means a zero-chunk fetch can no longer contaminate the
   report. It is now a source-quality decision (keep, replace, or investigate the
   run-vs-probe difference), not a correctness bug.
4. **Then the standing three:** #20's window shape (needs per-hour rows in `usage` — the
   table is now shaped to take them), #19's retry path (untestable without deliberately
   failing a step *after* its AI call), and the NZ brief.

---

## ✅ The first unattended run — READ 2026-08-13, run `4306b012`

**The cron fired**, at `2026-08-12T16:00:44Z`, unattended, exactly on `0 16 * * *`.
The autonomy question is settled. The research question is not.

The run took **5 of 6 iterations** and ended `sources-exhausted`, not
`max-iterations` — one of the five seeds is bot-blocked, so it ran out of queue
before it ran out of budget.

### The three questions, answered

**1. Did it fire?** Yes. No alert, no skip, no watchdog involvement.

**2. Is goal 4 answerable? No — and neither are goals 1 and 2.**

| Goal | Verdict |
|---|---|
| 1 · sectors where AI startups concentrate | **Unanswered** |
| 2 · funding landscape | **Unanswered** |
| 4 · geographic clusters | **Unanswered** |

Goal 4 returned exactly the predicted shape: Sydney is the largest metropolitan
area, Melbourne the largest urban area — city sizes from the Australia wikitext,
nothing about AI. **Deleted from the brief 2026-08-13** the way goals 2 and 5 went.

**The result that matters is that goals 1 and 2 — the survivors of the last cut —
also came back empty.** This is the NZ outcome landing on the AU brief: executes
flawlessly, answers little. Per decision 1's own terms that makes it a
**source-curation job**, not a loop defect. Do not fix this in code.

**3. Specificity: two real facts, both macro rather than AI-startup.** The tech
sector at $248.5bn / 8.9% of GDP, and the Tech Council's position on the Innovative
Business CGT Concession. Four of five findings are variations on *"not stated in
the sources read so far."* **Every citation is a real URL — #13 still holds.**

### Two things the run exposed

- **`https://www.innovationaus.com/feed/` returned `HTTP 403` with 0 chunks — but it
  is NOT bot-blocked.** The first reading of this run called it blocked and
  recommended deleting it; probing it through the Worker five times returned 200 /
  15,660 bytes / 13 chunks **every time**, in 8–14 ms. All five seeds fetch. Nothing
  was removed. The 403 was transient — treat it as a normal intermittent condition,
  not a property of the source.
- **Bug #22** — that failed fetch still got a finding attributed to it, carrying a
  figure recalled from elsewhere. #13 made citations point at real URLs; it never
  established that the URL **contributed anything**. Intermittency makes this
  recurring rather than one-off, which raises its priority.
- **Both Wikipedia seeds are truncated at 60,000 chars** — `Australia` is 245,605
  bytes and `Economy_of_Australia` 141,680, so the loop reads roughly the first
  quarter of each. Relevant to #16: the ingest limit, not just the URL, decides what
  the run can possibly answer.

### The reconciliation — UTC 2026-08-12

Wrangler's OAuth token had expired; `npx wrangler whoami` refreshes it in place,
then the §5.2 query works. (`expiration_time` is in the same `default.toml`.)

| | Neurons | Calls |
|---|---|---|
| `/usage` (ours) | 1079.800795738281 | 32 |
| Cloudflare — llama-3.3-70b | 929.4913461208344 | 11 |
| Cloudflare — bge-small-en-v1.5 | 152.91250247231102 | 26 |
| **Cloudflare total** | **1082.4038485931454** | **37** |
| **Delta** | **−2.6031 (0.24% low)** | **−5** |

**Call-site coverage looks right** under 5 iterations of load — the 5-call gap is
the benign `4006`-refused shape from run `04fc1149`, which costs and records
nothing. The **2.6031 neurons are not explained by refusals**, and cannot be
attributed without a per-model split of our own ledger — **bug #23**. Both
candidate causes (account-wide REST probes from the #21 work vs. our embedding rate
being ~1.7% low) are consistent with a 0.24% aggregate. The error is still in the
direction that matters: low.

**#19's retry accounting remains untested.** This run had no retries.

---

## ✅ Manual run `9174a7bc` — 2026-08-13 04:47→06:00Z, trimmed brief

Started by hand (not the cron) to exercise the trimmed brief early; quota allowed it
— trailing-24h was 932 of 10,000. Ended `sources-exhausted` at 5/6, same as
`4306b012`.

**Goal 1 moved Unanswered → Partial**, on real specifics: 6 startups / $13.5m from
CUREator+, tech workforce ~977,000 by Nov 2025, software engineering +7% YoY,
regional technical jobs +12% over 5 years. Goal 2 (funding) still Unanswered.

**Do not credit the topic trim for that.** Three things differed from `4306b012`:
the trimmed topic, a **refreshed live RSS feed** (`startupdaily.net/feed` went 11→12
chunks, and CUREator+ is exactly the kind of item that lands overnight), and
reasoning at `temperature: 0.4`. One observation, three variables — the fresher feed
is the more likely cause. I predicted no verdict would change and one did; the
prediction was wrong, the reasoning behind it is not yet disproven.

**#22 reproduced and escalated to 🔴.** Same 403, same position, and this time the
false attribution reached the report as a citation. 0 of 2 in real runs.

**The meter reconciled exactly** — 20 calls vs 20, +0.0135 neurons (+0.0014%, high),
which is precisely the published-rate rounding #21 measured. Settles the −2.6031 of
2026-08-12 as out-of-band REST probes, not a low embedding rate. See #23.

**The monitor underperformed.** It emitted one event instead of six — no per-iteration
lines — and the terminal notice arrived 65 min after `updated_at`. **⚠️ The verdict
drawn from this ("it is not a liveness signal") was withdrawn** — `5a8c9aeb` emitted
all six on time. One sample, one design conclusion; see the correction above.

---

## Where things stand

**Live:** `$WORKER_URL` (see local `.env`) · deployed version **`15f2e432`**
(2026-08-17 04:07Z — the #24 window fix) · `tsc --noEmit` clean · **repo, deployment and
GitHub in sync** · **nothing in flight** (verified `status='running'` = 0).

Shipped in session 5, `ebeb1f4` + `8d1cd07`:

| file | change |
|---|---|
| `ingest.ts` | new `freshExcerpts(pieces, budget)` — the #24 fix |
| `workflow.ts` | `FRESH_EXCERPTS = 6` → `FRESH_CHARS_DEFAULT = 16_000`, read via `num(env.FRESH_CHARS, …)` |
| `index.ts` | `/step` uses the same function (was a duplicated bare `slice(0, 6)`), and reports `freshCharBudget` / `freshChunksUsed` / `freshCharsUsed` |
| `types.ts` | `FRESH_CHARS` on `Env` |
| `bugs.md`, `CLAUDE.md`, `lessonlearnt.md` | #24, #25, #26; CLAUDE.md §12 |

`FRESH_CHARS` is **not** in `wrangler.jsonc` — the code falls back to
`FRESH_CHARS_DEFAULT`, so there is one place to change it and no config/default drift.
Set the var only to override.

**Verified against the deployed Worker**, not assumed: a production `/step` returned
`budget=16000 chunksUsed=11 charsUsed=14838` — the whole feed — and named *"AI, fintech,
agtech, and biotech"* as sectors.

⚠️ **The feed thawed during the session.** A new item (Sophiie AI, $5m Seed) appeared
between the last experiment and the production check, so the frozen-feed natural
experiment is over. Any further before/after comparison on this source now has a moving
input again.

**Scratch:** `.runs/` is now **gitignored**. It holds the run JSON, the frozen feed, and
`arm.sh` — the #24 test harness, which is the reusable part: `dryRun` a single-seed run,
drive one `/step`, print the **applied** window beside the finding. `BASE=<url>` points it
at production or at a dev server.

**Dev servers: all killed and verified 2026-08-17 05:17Z.** No listeners on 8787/8788, no
`workerd`, no `wrangler dev` parents. ⚠️ **`TaskStop` does not reliably stop
`wrangler dev`** — it failed on 6 of 8 this session, and killing the `workerd` children is
futile because the surviving parents respawn them within seconds. Kill the **parents**
(`wmic` → `ParentProcessId` → `taskkill /F /T`), then verify the port is unreachable.
Cheapest reliable restart is a **fresh port**. See bugs.md #26.

**Brief verified by dry run 2026-08-13** (`d6c13ad8`, `dryRun: true`): 2 goals,
5 seeds, `maxIterations: 6`, `instanceId: null`. The row closed as `stopped` — #18's
invariant holds, nothing for the watchdog to resurrect — and seeds normalised on the
way in (`www.` and trailing slashes stripped), so #14 holds on the seed side.
A dry run does not consume the day's slot. `control.daily_last_run` is now
`2026-08-13`; **the next scheduled run is 16:00Z on 2026-08-14.**

**Topic trimmed 2026-08-13** to match the surviving goals, as it was when goals 2
and 5 were cut:

> The Australian AI startup ecosystem in 2026: which sectors the companies cluster
> in and how they are funded.

The reason is **recall, not the report**. `REPORT_SYSTEM` writes one section per
goal and the report prompt enumerates the goals, so a stale topic clause cannot
manufacture a phantom verdict. But `recallQuery` (`prompt.ts`) joins the topic with
the goals into a **single embedded query** against a fixed `RECALL_TOP_K = 8`, so a
clause about geography spends recall slots on a deleted question — demonstrably: it
is what surfaced "Sydney is the largest metropolitan area" out of a 245 KB country
article. Retrieval worked; it retrieved for a goal that no longer exists.

**The prediction attached to this — "expect it to change no verdict" — did not
survive.** Both goals moved over the two runs that followed. But the trim is still not
the credited cause: the live feeds refreshed on every one of those runs, and one
observation cannot separate three variables. The claim that stands is the narrow one:
recall was demonstrably spending slots on a deleted goal, and it no longer is. **The
sourcing decision remains the thing that moves the outcome.**

**Crons:** `*/30 * * * *` watchdog · `0 16 * * *` daily run. **UTC only, no DST** —
04:00 NZST becomes 05:00 NZDT.

**Secret:** `ALERT_WEBHOOK` → Discord. Verified end-to-end from inside the Worker.

**Neurons:** 2,213 on UTC 2026-08-13 against an 8,000 budget, of which the daily run
itself is ~1,156 (994.9 reasoning + 160.8 embedding) — **isolable now that #23 split
the ledger by model**; the remaining 1,057 sits under `(pre-#23: model not recorded)`,
which is the migration's honest unknown, not a real model. Ample headroom. The
allocation is **not** a UTC calendar day — see #20 before assuming headroom.

**GitHub:** https://github.com/timothylok/ThoughtLeader — public, head `5b0ba1c`
(committed, **not yet pushed** — push when you want it public).
`README.md`, `HANDOFF.md`, `AI_Research.md`, `benchmark/BENCHMARK.md` and
`liverun.html` are **gitignored** (they carry the worker URL or account ID) as are
`.env` and `.claude/settings.local.json`. Verified before each push: no worker URL,
account ID or webhook anywhere in the pushed tree.

---

## What session 5 did

- **Read four unattended runs before touching anything** — which is what found #24, and
  what showed session 4's central claim to be wrong. The handoff habit is now 2 for 2 on
  finding the session's real bug.
- **Corrected "the live feed is the engine."** Three runs of agreement were one
  observation: the feed refreshed in all three, so nothing varied. The frozen feed
  supplied the missing control cell for free, and it inverted the mechanism — churn
  **evicts** evidence rather than adding it.
- **#24 found, measured, fixed, deployed** (`15f2e432`). Character budget replaces a chunk
  count; `/step` and the workflow now share one function and one setting.
- **#25 logged and left open** — the false-attribution bug that #22's fix does not cover.
- **#26 logged, then corrected twice** — an eight-sample experiment in which the treatment
  was never applied, and a cleanup that reported success three times while six dev servers
  kept running.
- **Reconciled 08-14 per model**: exact on reasoning, +0.00905% on embeddings, and the
  predicted out-of-band excess **was not there** — the probes had landed on the previous
  UTC day. The rounding bias then replicated across three days with three different token
  totals, which is the first genuine replication of that claim.
- **Probed nine candidate AU sources**; recorded the negative result plainly, including
  that the one promising dataset source is unreachable by design.

## What session 4 did

- **Read the first unattended run** rather than building on top of it — which is what
  found #22. Goal 4 deleted from `control.daily_brief` after returning the exact
  Unanswered shape predicted for it, the way goals 2 and 5 went.
- **Topic trimmed** to match the surviving goals (recall, not the report — see above).
- **#22 fixed** — six sites across two paths, keyed on `chunks` rather than `error`.
- **#23 fixed** — `usage` migrated to one row per `(day, model)`; totals preserved to
  the last digit. The dangerous part was `neuronsToday`, not the column.
- **Both confirmed in production** by the unattended `5a8c9aeb`, against the original
  incident in #22's case.
- **Three corrections logged against my own claims**: "bot-blocked" from one failure,
  "transient" from one probe burst, and "the monitor is not a liveness signal" from one
  late run. All three are the same error and it is now rule 9 below.

## What session 3 did

- **Decision 1 settled:** free tier + plain text. Goals 2 and 5 deleted from the AU
  brief.
- **Bugs #19, #20, #21 found; #19 and #21 fixed and measured.** #17 **failed** its
  verification — #21 is why.
- **#13 verified** (citations are real URLs from the `SOURCE:` line).
- **The daily schedule built, tested against remote bindings, and deployed.**
- **The provider-side neuron figure turned out to be one command**, not a dashboard
  read — which is what caught #21. README §5.2.

Session 2's results (prompt rewrite, grounding at scale, the AU/NZ split, bugs
#13–#18) are in `benchmark/` and `bugs.md`.

---

## ✅ Decision 1 — SETTLED 2026-08-12: free tier, plain text

The loop **stays on Workers Free**. `benchmark/run-payload-au-plaintext.json` is now
the production brief, with goals 2 and 5 **deleted** rather than left to return
`Unanswered` every run. Full record and consequences in
`benchmark/AU-SEEDS-PLAINTEXT.md` §5.

The comparison that informed it (verified against Cloudflare's docs, not the README):

| | Free + plain text | Workers Paid |
|---|---|---|
| Cost | $0 | **$5.00/mo** (10M req + 30M CPU-ms incl.; measured need ~90k CPU-ms/mo) |
| Workers AI | 10,000 neurons/day — **identical on both plans**, then $0.011/1k on Paid only | same |
| CPU per invocation | 10 ms | 30 s default, 5 min max |
| Subrequests per invocation | 50 → forces `ITERATIONS_PER_GEN=8` | 10,000 |
| Usable AU seeds / goals | 4 of 9 · 3 goals | 9 of 9 · 12/12 measured on `76fb1813` |
| Autonomous discovery | **disabled** — no `<a href>` in RSS/wikitext | works |

Two consequences to keep in mind: `MAX_SOURCE_DEPTH=2` is now effectively 0, so
source curation is a manual job; and bug #15 is resolved by **source policy, not
code** — nothing stops a future HTML seed being added.

### 2. Still open: what to do about the NZ brief

Not executable as written. 91% of its chunks came from two Wikipedia country
articles and were never cited. The sources that would answer goals 1, 2 and 5
(NZTech, AI Forum NZ, Icehouse Ventures) are all JS-rendered. Either put Browser
Rendering on them (10 min/day free) or drop those goals.

---

## ✅ VERIFIED 2026-08-12 — run `d2cd8b42`

| Bug | Result |
|---|---|
| **#13** citations | ✅ **PASS.** Report cited `https://nzgcp.co.nz/` straight from the `SOURCE:` line — no bare `[n]`, and no `www.` re-added despite the seed being submitted with one. Verdict + Gaps contract intact |
| **#17** spend guard | ❌ **FAILED.** Reasoning matched to 14 dp (75.39326477050781 both sides); embeddings recorded **0** against Cloudflare's 1.2039. Root cause is [#21](bugs.md) |
| **#19** meter timing | ✅ **Call accounting correct.** 6 metered calls vs Cloudflare's 9 — the gap is exactly three `4006`-refused embeds that cost and recorded nothing. Retry path still untested, as designed |
| **#21** embedding price | ✅ **Fixed & measured** (`a39be94e`). One embed now moves the meter 0.014728 where it moved 0 before |

**What a clean run cannot prove.** #19's retry accounting is invisible on a run with
no retries — testing it means forcing a step to fail *after* its AI call.

### The Cloudflare-side figure is a command, not a dashboard read

Wrangler's own OAuth token authenticates the GraphQL analytics API — no separate API
token needed. Dataset `aiInferenceAdaptiveGroups`; `dimensions{date modelId}` splits
reasoning from embedding spend and `count` gives the true per-model call count:

```sh
TOK=$(sed -n 's/^oauth_token = "\(.*\)"$/\1/p' "$APPDATA/xdg.config/.wrangler/config/default.toml")
curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $TOK" \
  -H 'content-type: application/json' --data "{\"query\":\"query{viewer{accounts(filter:{accountTag:\\\"$CF_ACCOUNT_ID\\\"}){aiInferenceAdaptiveGroups(limit:50,filter:{date_geq:\\\"$(date -u +%F)\\\"}){dimensions{date modelId}sum{totalNeurons}count}}}}\"}"
```

(`grep -P` fails in this Git Bash locale — use `sed -n 's/…/\1/p'`.)

### ⚠️ The free allocation is not a UTC calendar day (bugs.md #20)

An earlier draft of this file said the two counters "genuinely disagree." **That was
wrong** — it is a *window* mismatch. Calendar-day analytics for UTC 2026-08-11 read
8,670.74 while Cloudflare refused calls at ~04:15Z that day; the hourly data shows
the only sum reaching 10,000 spans the Aug-10 midnight boundary. Confirmed at the
rollover: a run at 00:05:53Z on a fresh UTC day, with our meter at 0, was **refused**;
a probe at 00:11Z **succeeded**.

**Implication:** `neuronsToday()` keys on `utcDay()` and resets at midnight while the
platform may still hold most of a 24-hour window against the account, so the guard
can authorise spending the platform refuses.

**Applied:** `DAILY_NEURON_BUDGET` 10000 → **8000**, so the loop stops itself — with
a report — before Cloudflare stops it. This is mitigation; the window shape is still
wrong, and the real fix (trailing-24h metering) needs per-hour rows.

**Operational rule that came out of it: probe the condition, don't trust the clock.**
This file previously asserted the reset time as fact; the verification run was armed
against that assertion and was refused.

---

## Open bugs

| # | Bug | Severity | Note |
|---|---|---|---|
| **20** | The allocation is not a UTC calendar day | 🟠 Guard shape | **Mitigated, not fixed.** Budget is 8,000 of 10,000. Real fix = meter a trailing 24 h, which needs per-hour rows in `usage` instead of one row per day |
| **15** | Large HTML ingest is over the CPU limit | 🔴 Fatal (intermittent) | **Resolved by source policy** (decision 1), not by code. Nothing stops a future HTML seed being added — the guard is the probe habit in #16 |
| **16** | Source validation confirmed extractability, not topic | 🟠 Research quality | Both Wikipedia "Science and technology in X" URLs are redirects to country articles — re-probed 2026-08-17, still a 46-char `#REDIRECT` stub. Fix is a probe habit: check `?action=raw` first |
| **25** | A finding is attributed to a source that supplied none of its content | 🔴 False attribution | **Open, new.** #22's invariant one branch away — recall injects another source's chunks and the finding is stamped with *this* iteration's URL. Confirmed on `dc0a0b39`/`8772de4e`, and on the flagship $248.5bn figure cited to Wikipedia by every report |
| ~~**24**~~ | The fresh-excerpt window is a newest-N cut | 🔴 Silent research regression | ✅ **Fixed, measured and deployed** (`15f2e432`). Verified on production: `budget=16000 chunksUsed=11 charsUsed=14838`. **Verdict-level effect still unobserved** — awaiting the 16:00Z run |

**Untested, not open:** #19's retry accounting. A run with no retries cannot exercise
it — testing it means deliberately failing a step *after* its AI call. Three clean
reconciliations in a row have now been structurally incapable of testing it.

**Not a bug, an open decision:** `innovationaus.com/feed` fails in runs (0/3) and
succeeds in probe bursts (5/5). #22's fix removed the consequence, not the cause.

Fixed and verified: **#22**, **#23** (session 4, both confirmed in production on
`5a8c9aeb`); **#13**, **#21** (session 3); **#14**, **#18** (session 2).

---

## ✅ The daily schedule — BUILT and verified 2026-08-12

**Fires `0 16 * * *` = 04:00 NZST.** A 6-iteration run at `ITERATION_INTERVAL=18min`
takes ~1.8h, so the report is written by ~05:50 NZST. Cron Triggers are **UTC only**
— no DST — so this becomes 05:00 NZDT in summer.

- `DAILY_CRON` in `src/index.ts` **must match** the `wrangler.jsonc` string exactly.
  A mismatch does not error; the cron silently routes to the watchdog instead.
- The brief is JSON in `control.daily_brief` — change topic, goals or seeds with a
  D1 write, no deploy:
  ```sh
  npx wrangler d1 execute research-log --remote \
    --command "SELECT value FROM control WHERE key='daily_brief'"
  ```
- Guards, in order: already ran today (`control.daily_last_run`), any run still in
  flight, then the neuron budget. **The day is claimed before launching**, so a
  double-fired cron cannot produce two runs against one budget — at the cost of no
  retry until tomorrow, which alerts.
- Run creation is one `launchRun()` shared by `POST /start` and the cron, so seed
  normalisation (#14) and the close-on-failed-create (#8, #18) cannot drift apart.

**Verified** against remote bindings with `wrangler dev --remote --test-scheduled`:
the no-brief guard fired and routed to the daily handler rather than the watchdog,
and a 1-iteration brief launched run `b8cc2adb` through to `done/max-iterations`.

### Alerts

`src/notify.ts` posts to `ALERT_WEBHOOK` (a **secret** — `wrangler secret put`, never
in the repo or `wrangler.jsonc`) on three events: a run that fails, a daily run that
could not start, and budget exhaustion. It no-ops when unset and never throws.
Transient interruptions stay silent on purpose — Workflows recovers from those, and
alerting on them would train you to ignore the channel.

Discord accepts both `{text}` and `{content}`; the notifier sends both so one body
works for Slack and Discord. Verified 204 directly against the webhook.

**End-to-end confirmed.** The Worker's own alert landed in Discord during the
no-brief test — *"[research-loop] daily run did NOT start / No brief stored at
control['daily_brief']"* — so the full `scheduled()` → `alert()` → Discord path
works, not just the URL. Incidentally this proves **`wrangler dev --remote` does
bind secrets**, which makes it the right tool for testing anything secret-dependent
without deploying.

Note when testing by hand: a `curl -d` payload containing an em dash returns
**HTTP 400** from Discord as a shell encoding artifact. `alert()` builds its JSON in
JS and is unaffected — don't chase that as a code bug.

---

## Live config

| Var | Value | Note |
|---|---|---|
| `ITERATION_INTERVAL` | `18 minutes` | Sets the daily run's wall-clock length: 6 iterations ≈ 1.8 h |
| `ITERATIONS_PER_GEN` | `8` | Bounded by **subrequests**, not steps (bugs.md #1) |
| `DAILY_NEURON_BUDGET` | `8000` | Applied 2026-08-12. NOT 10000: the allocation is not a UTC calendar day (bugs.md #20), so the guard must stop the run before the platform does |
| `MAX_SOURCE_DEPTH` | `2` | Grounded. **Effectively 0 under decision 1** — plain text has no links to harvest |
| `REASON_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | |
| `EMBED_MODEL` | `@cf/baai/bge-small-en-v1.5` | 384 dims, must match the index |

**Resources:** Vectorize `research-memory` (384/cosine, metadata index on `type`),
D1 `research-log`, Workflow `research-loop`. IDs in `wrangler.jsonc` and `.env`.

---

## Rules that cost time to learn

1. **Never deploy while a run is in flight** — and **make the check a gate that exits,
   not a printed line** (CLAUDE.md §7.1). New in session 3: the gate only sees work
   *running*, not work **armed to start seconds from now**. A config deploy at
   00:05:16Z and a cron firing at 00:05:53Z missed each other by 37 seconds, by luck.
   With a daily cron live, check the clock against `0 16 * * *` before deploying.
2. **Unknown is not zero** (CLAUDE.md §10). `usage.neurons ?? 0` metered every
   embedding as free. A default that fails quiet cannot raise an alarm.
3. **Reconcile against the provider, never against yourself.** Three fixes to the
   spend guard each passed their own test and each shipped a fresh undercount. One
   command comparing `/usage` to Cloudflare's analytics found what code review did
   not — README §5.2. Compare **per model**, not in aggregate: an exact match on
   reasoning plus a 100% miss on embeddings sums to something that looks like noise.
4. **Probe the condition, don't trust the clock.** This file once asserted the
   allocation "resets at UTC midnight." It does not (#20), and a verification run was
   scheduled against that assertion and refused.
5. **Ask what a passing test cannot prove.** The verification run confirmed
   call-site coverage and was structurally incapable of testing retry accounting.
6. **Intermittent success is not headroom.** HTML ingest "worked" for 40+ iterations
   while being 2–24× over the CPU limit.
7. **Fix the invariant, not the incident** (CLAUDE.md §9). Now five instances:
   #8→#18, #12→#14, #17→#19→#21.
8. **Extractability ≠ relevance.** A source can fetch perfectly and be about
   something else.
9. **Repetition is not replication.** New in session 4, three times on two subjects: a
   seed was called "bot-blocked" from one in-run failure, then "transient" from five
   probes fired seconds apart down one connection, and the monitor was called unfit
   from one late run. Correlated observations are not independent evidence. **Before
   quoting an n, state what varied across the trials** — a different connection, a
   different hour, a different code path. Failures are the easier case to over-read,
   because they arrive with an explanation already attached.

Full reasoning in `CLAUDE.md` §5–10, `bugs.md`, `lessonlearnt.md` §9, `benchmark/`,
and the memory directory.
