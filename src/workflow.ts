/**
 * The research loop.
 *
 * Two rules govern everything here:
 *
 * 1. State is rebuilt ONLY from step return values. Instances hibernate across
 *    step.sleep and replay run() from the top, so in-memory locals that aren't
 *    derived from a step.do return will silently diverge. (README §2.3)
 *
 * 2. Step names must be unique within an instance, hence the `:${n}` suffixes.
 *    Reusing a name across iterations would serve iteration 1's cached result
 *    to iteration 12.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { num, type AiUsage, type Env, type RunParams, type Reasoning, type TerminationReason, type IngestResult, type FundingEvent } from './types.ts';
import { fetchSource, chunk, freshExcerpts, selectNextSources } from './ingest.ts';
import { recall, remember, chunkKey, findingKey, type Recalled } from './memory.ts';
import {
  buildPrompt,
  parseReasoning,
  recallQuery,
  citableSources,
  resolveCitations,
  parseEvents,
  stripUngroundedUrls,
  urlsIn,
  REPORT_SYSTEM,
  NO_BASELINE_RULE,
  dropSection,
  leakedCompanies,
  parseB3Bands,
  parseBaselineCountry,
  checkRoundSizes,
  renderB3Section,
  renderEventSection,
  UNKNOWN_COUNTRY,
  B3_HEADING,
} from './prompt.ts';
import { alert } from './notify.ts';
import {
  claimSource,
  markSourceResult,
  enqueueSources,
  pendingSourceCount,
  addedSourceCount,
  recordFinding,
  recentFindings,
  recordEvents,
  recentEvents,
  eventsForRun,
  getControl,
  finishRun,
  failRun,
  isStopRequested,
  meterCall,
  neuronsInTrailing24h,
} from './db.ts';

/**
 * Errors that mean "the platform interrupted us", not "this run is broken".
 * Workflows resumes from the last successful step after these, so writing a
 * terminal status to D1 would be wrong. Observed in practice when a `wrangler
 * deploy` lands while an instance is mid-flight.
 */
function isTransient(e: unknown): boolean {
  return /Durable Object reset|code was updated|internal error|network connection lost/i.test(
    String(e),
  );
}

const PRIOR_FINDINGS_IN_PROMPT = 6;

/**
 * Characters of the current source carried into the prompt. See
 * `freshExcerpts()` in ingest.ts for why this is a character budget and not a
 * chunk count, and for the measurement behind the number.
 *
 * 16,000 shows Startup Daily (14,762) whole and bounds a 60,000-char Wikipedia
 * article at ~11 chunks. Configurable so the window can be measured rather than
 * assumed (CLAUDE.md §6).
 */
export const FRESH_CHARS_DEFAULT = 16_000;

/** Ceiling on model-proposed sources per run, on top of the per-iteration cap. */
const MAX_ADDED_SOURCES_PER_RUN = 10;

/**
 * Ledger entries shown to the model as "already recorded".
 *
 * A window, not the whole table — the ledger grows without bound and the prompt
 * does not. 60 entries is roughly a fortnight at the observed ~5 events/day, so
 * a re-reported item is caught while it is still circulating in the feeds. Past
 * that the dedupe still holds: UNIQUE(key) rejects the row even when the model
 * offers it again, so the window governs prompt noise, not correctness.
 */
const KNOWN_EVENTS_IN_PROMPT = 60;

/** `control` row holding the Claude Code baseline the deltas are measured against. */
const BASELINE_KEY = 'baseline';

export class ResearchLoop extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<void> {
    const { runId, topic, goals, maxIterations, startAt, generation } = event.payload;
    const env = this.env;

    const perGen = num(env.ITERATIONS_PER_GEN, 100);
    const topK = num(env.RECALL_TOP_K, 8);
    const maxBytes = num(env.MAX_FETCH_BYTES, 262_144);
    const maxDepth = num(env.MAX_SOURCE_DEPTH, 2);
    const freshChars = num(env.FRESH_CHARS, FRESH_CHARS_DEFAULT);
    const budget = num(env.DAILY_NEURON_BUDGET, 10_000);

    const genEnd = Math.min(maxIterations, startAt + perGen);

    let n = startAt;
    let lastProgress = '';
    let terminal: TerminationReason | null = null;

    try {
      while (n < genEnd) {
        n++;

        // 1. Claim a source. No source left means the run is finished — bail
        //    before spending neurons on another reasoning pass.
        const source = await step.do(`next-source:${n}`, async () => {
          return await claimSource(env.DB, runId);
        });

        if (!source) {
          terminal = 'sources-exhausted';
          break;
        }

        // 2. Fetch + extract + chunk + embed into memory. Isolated in its own
        //    step so the CPU-heavy parse gets its own execution context.
        const ingested = await step.do(
          `ingest:${n}`,
          { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
          async (): Promise<IngestResult> => {
            // Only the fetch is caught. A dead link is a fact about the source
            // and must not wedge the run — retrying it would waste every
            // remaining attempt on a 404.
            let doc: Awaited<ReturnType<typeof fetchSource>>;
            try {
              doc = await fetchSource(source.url, maxBytes);
            } catch (e) {
              const msg = String(e).slice(0, 300);
              await markSourceResult(env.DB, source.id, 0, msg);
              return {
                url: source.url,
                sourceId: source.id,
                chunks: 0,
                bytes: 0,
                truncated: false,
                error: msg,
                excerpts: [],
                links: [],
                neurons: 0,
              };
            }

            // Embedding and storage failures are transient infrastructure
            // errors, so they propagate and let the step's retry policy work.
            const pieces = chunk(doc.text);
            const { stored, neurons } = await remember(
              env,
              runId,
              pieces.map((text, i) => ({
                key: chunkKey(source.id, i),
                text,
                sourceUrl: source.url,
                type: 'chunk' as const,
                n,
              })),
            );
            await markSourceResult(env.DB, source.id, stored, null);

            return {
              url: source.url,
              sourceId: source.id,
              chunks: stored,
              neurons,
              bytes: doc.bytes,
              truncated: doc.truncated,
              error: null,
              excerpts: freshExcerpts(pieces, freshChars),
              links: doc.links,
            };
          },
        );

        // The URL to attribute this iteration's finding to — null unless the
        // source actually contributed material. A fetch that 403s still claims a
        // source from the queue, and reasoning still runs (usefully) on recalled
        // memory; stamping the finding with that URL asserts it was the origin of
        // content it never supplied, and the citation reaches the report
        // (bugs.md #22).
        //
        // Keyed on `chunks`, NOT on `error`: a fetch can succeed and yield zero
        // chunks (empty body, nothing after boilerplate stripping), which is the
        // same violation one branch away (CLAUDE.md §9).
        const contributedUrl = ingested.chunks > 0 ? ingested.url : null;

        // 3. Recall the most relevant memory for the goals. The query embedding
        //    is a real AI call and used to go entirely uncounted (bugs.md #17).
        const recalled = await step.do(
          `recall:${n}`,
          async (): Promise<{ items: Recalled[]; neurons: number }> => {
            return await recall(env, runId, recallQuery(topic, goals, lastProgress), topK);
          },
        );

        // 4. Reason.
        const reasoning = await step.do(
          `reason:${n}`,
          { retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
          async (): Promise<
            Reasoning & { neurons: number; parsedEvents: FundingEvent[]; leaked: string[] }
          > => {
            const prior = await recentFindings(env.DB, runId, PRIOR_FINDINGS_IN_PROMPT);
            // The ledger spans runs, so this is the only cross-day state the loop
            // has. Exact identity, not similarity — see schema.sql `events`.
            const known = await recentEvents(env.DB, KNOWN_EVENTS_IN_PROMPT);
            const baseline = await getControl(env.DB, BASELINE_KEY);
            // Built ONCE and used twice — to render the prompt and to resolve
            // what comes back. Deriving it separately at each end is how /step
            // and the workflow drifted apart over the excerpt window (#24).
            const citable = citableSources(contributedUrl, recalled.items);
            // The effective attribution table, logged from inside the code path
            // that uses it rather than from the value passed in (CLAUDE.md §12).
            console.log(
              `[${runId}] n=${n} citable: ` +
                (citable.map((c) => `${c.marker}=${c.url}`).join(' ') || '(none)'),
            );
            const messages = buildPrompt(
              topic,
              goals,
              ingested.excerpts,
              recalled.items,
              prior,
              contributedUrl,
              citable,
              {
                baseline,
                knownEvents: known.map(
                  (e) =>
                    `${e.company} (${e.stage ?? '—'}, ${e.amount ?? '—'}, ${e.country ?? UNKNOWN_COUNTRY})`,
                ),
              },
            );
            const res = (await env.AI.run(env.REASON_MODEL, {
              messages,
              // 900, not 700: the response now carries the event lines as well as
              // the finding, and a truncated response parses as `unparsed` — which
              // yields NO events at all. Output tokens are billed as generated, so a
              // higher ceiling costs nothing unless it is used.
              max_tokens: 900,
              temperature: 0.4,
            })) as { response?: unknown; usage?: AiUsage };
            // Metered before parsing, not at the end of the iteration. This step
            // retries twice, and Cloudflare bills each attempt (bugs.md #19).
            const neurons = await meterCall(env.DB, env.REASON_MODEL, res.usage);

            const parsed = parseReasoning(res.response);
            // Markers become real URLs here, and anything cited that was never
            // offered is removed. The finding is stored already attributed, so
            // every downstream reader — the report, and recall in later
            // iterations — sees per-claim origins instead of one URL asserted
            // over the whole blob (bugs.md #25).
            const cited = resolveCitations(parsed.finding, citable);
            if (cited.dropped.length) {
              console.log(
                `[${runId}] n=${n} dropped ungrounded citations: ${cited.dropped.join(', ')}`,
              );
            }
            // Events are parsed HERE, where `citable` exists — their source URL
            // is resolved from the same table as the finding's citations, so a
            // ledger row cannot carry a URL the iteration was never offered.
            const parsedEvents = parseEvents(parsed.events, citable);
            // Measured against the list this prompt actually carried, and on the
            // text that is actually stored and embedded (bugs.md #37).
            const leaked = leakedCompanies(cited.text, known.map((e) => e.company));
            if (leaked.length) {
              console.warn(`[${runId}] n=${n} finding names recorded events: ${leaked.join(', ')}`);
            }
            return { ...parsed, finding: cited.text, parsedEvents, leaked, neurons };
          },
        );

        // 5. Commit: finding to D1, finding to vector memory, new sources queued.
        const recorded = await step.do(`record:${n}`, async () => {
          const findingId = await recordFinding(
            env.DB, runId, n, contributedUrl, reasoning, reasoning.leaked,
          );

          // Idempotent by UNIQUE(key) + DO NOTHING, because this step retries and
          // Workflows re-runs everything in it (bugs.md #7). The count returned is
          // rows INSERTED, not events offered — a re-report adds nothing.
          const newEvents = await recordEvents(env.DB, runId, n, reasoning.parsedEvents);

          const remembered = await remember(env, runId, [
            {
              key: findingKey(n),
              text: reasoning.finding,
              // Also `contributedUrl`: recalled excerpts carry their sourceUrl
              // into later prompts, so a false attribution here propagates
              // forward instead of staying in one row (bugs.md #22).
              sourceUrl: contributedUrl ?? '',
              type: 'finding',
              n,
            },
          ]);

          // Only enqueue URLs that were actually present on a page we read.
          // Syntax-valid but invented domains burned ~40% of run 19ac529b's
          // fetch budget (bugs.md #12).
          const { accepted, rejected } = selectNextSources(reasoning.newSources, ingested.links);
          const addedSoFar = await addedSourceCount(env.DB, runId);
          const room = Math.max(0, MAX_ADDED_SOURCES_PER_RUN - addedSoFar);
          const enqueued =
            maxDepth > 0 && room > 0
              ? await enqueueSources(env.DB, runId, accepted.slice(0, room), 1)
              : 0;
          if (rejected.length) {
            console.log(`[${runId}] n=${n} rejected ungrounded URLs: ${rejected.join(', ')}`);
          }

          // No metering here. Every AI call above already recorded itself the
          // moment it returned (bugs.md #17 covered which calls, #19 covered
          // when). Aggregating at step end is what lost the retried attempts.
          return { findingId, enqueued, newEvents };
        });

        lastProgress = reasoning.progress;

        // 6. Assess AFTER the commit, so termination sees committed state.
        const assessed = await step.do(
          `assess:${n}`,
          async (): Promise<{ verdict: TerminationReason | null; spentToday: number }> => {
            // Read the ledger rather than carrying a total through the iteration:
            // each AI call now writes its own spend as it happens, so the
            // committed table is the only place the true running total exists.
            const spentToday = await neuronsInTrailing24h(env.DB);
            if (await isStopRequested(env.DB, runId)) return { verdict: 'stopped', spentToday };
            // Spend guard first among the automatic exits: on a Paid plan this is
            // the only hard stop that exists. Budget alerts do not cap usage.
            if (budget > 0 && spentToday >= budget)
              return { verdict: 'budget-exhausted', spentToday };
            if (reasoning.done) return { verdict: 'goals-met', spentToday };
            if (n >= maxIterations) return { verdict: 'max-iterations', spentToday };
            if ((await pendingSourceCount(env.DB, runId)) === 0)
              return { verdict: 'sources-exhausted', spentToday };
            return { verdict: null, spentToday };
          },
        );

        if (assessed.verdict) {
          terminal = assessed.verdict;
          break;
        }

        console.log(
          `[${runId}] n=${n} chunks=${ingested.chunks} recalled=${recalled.items.length} ` +
            `events=${recorded.newEvents}/${reasoning.parsedEvents.length} ` +
            `enqueued=${recorded.enqueued} neurons=${reasoning.neurons.toFixed(1)} ` +
            `spentToday=${assessed.spentToday.toFixed(0)}/${budget || '∞'}` +
            `${ingested.error ? ` err=${ingested.error}` : ''}`,
        );

        // Free — does not count toward the step limit. This is the pacing lever.
        await step.sleep(`wait:${n}`, env.ITERATION_INTERVAL);
      }

      if (terminal) {
        await step.do(`report:${generation}`, async () => {
          // max_tokens 1200 — the largest single generation in a run. It was
          // counted nowhere at all before bugs.md #17, then counted only if
          // `finishRun` succeeded, which lost the whole call whenever this step
          // retried (bugs.md #19). `synthesise` now meters itself on return.
          const { report, neurons } = await this.synthesise(runId, topic, goals);
          await finishRun(env.DB, runId, terminal!, report);

          // Push the result rather than waiting to be asked. An unattended loop
          // whose output has to be fetched gets read on the days someone
          // remembers to fetch it; the point of a daily delta is a daily look.
          // `alert` never throws and no-ops when the webhook is unset.
          const added = await eventsForRun(env.DB, runId);
          await alert(
            env,
            `run ${runId} done — ${added.length} new event(s), ${terminal}`,
            added.length > 0
              ? added
                  .map(
                    (e) =>
                      `• ${e.company} — ${e.sector ?? '—'}, ${e.amount ?? '—'}, ` +
                      `${e.stage ?? '—'}${e.source_url ? ` ${e.source_url}` : ''}`,
                  )
                  .join('\n')
              : 'No new events today.',
          );
          // Inside the step so it is cached with it, rather than re-firing on
          // every replay of the terminal branch.
          if (terminal === 'budget-exhausted') {
            await alert(
              env,
              `run ${runId} stopped early: daily neuron budget exhausted at n=${n}`,
              `A report was still written. Either the brief is too large for the ` +
                `budget or DAILY_NEURON_BUDGET is set too low.`,
            );
          }
          return { terminal, reportChars: report.length, neurons };
        });
        return;
      }

      // Generation budget spent but the run isn't done — hand off to the next
      // instance. Deterministic ID makes a retry after a successful create a
      // no-op rather than a fork. (README §2.1)
      await step.do(`continue:${generation}`, async () => {
        const next = generation + 1;
        try {
          await env.LOOP.create({
            id: `run-${runId}-gen-${next}`,
            params: { runId, topic, goals, maxIterations, startAt: n, generation: next },
          });
        } catch (e) {
          if (!/already exists/i.test(String(e))) throw e;
        }
        return { handedOffAt: n, nextGeneration: next };
      });
    } catch (e) {
      // Platform-level interruptions are NOT run failures. A deploy resets the
      // Durable Object backing the instance, and Workflows resumes from the last
      // successful step afterwards — but marking the run 'failed' here made D1
      // permanently disagree with a workflow that was still running.
      // Rethrow and let Workflows recover; only genuine errors mark the run.
      if (!isTransient(e)) {
        await failRun(env.DB, runId, String(e));
        // A run that dies unattended must say so. Transient interruptions are
        // deliberately silent — Workflows recovers from those on its own.
        await alert(env, `run ${runId} FAILED at n=${n}`, String(e).slice(0, 800));
      }
      throw e;
    }
  }

  /** Final synthesis. Pulls the run's findings straight from D1, in order. */
  private async synthesise(
    runId: string,
    topic: string,
    goals: string[],
  ): Promise<{ report: string; neurons: number }> {
    const [findings, added, baseline] = await Promise.all([
      recentFindings(this.env.DB, runId, 60),
      eventsForRun(this.env.DB, runId),
      getControl(this.env.DB, BASELINE_KEY),
    ]);
    const hasBaseline = Boolean(baseline && baseline.trim());

    // The "new events" list is built from the LEDGER, not from the findings'
    // prose, because only the UNIQUE(key) insert knows what was actually novel.
    // On run 35e0c08b the model re-offered Nybro despite it being listed as
    // already recorded; the constraint rejected the row, but the finding still
    // described it — so a report written from prose would have announced an
    // event we already had as new. The model formats nothing here and decides
    // nothing; it is handed the answer.
    //
    // Bucketed by country, against the country the baseline itself declares it
    // covers — read from the document, never assumed (bugs.md #39).
    const baselineCountry = parseBaselineCountry(baseline);
    if (hasBaseline && !baselineCountry) {
      // Loud, never silent: with no declared scope nothing can be checked.
      console.error('[report] baseline declares no country coverage - round size NOT checked');
    }
    const eventSection = `${renderEventSection(added, baselineCountry)}\n\n`;

    // Round size is arithmetic against a fixed table, so the CODE does it and
    // the model is handed the answer — the same call #28 made for New events.
    // Run ab39eff8 called a $20M Seed "within the expected range" when B3 flags
    // Seed above $12.0M, and checked a stageless round as a Seed when B3 says
    // in words that it cannot be checked. Both were cited to B3 (bugs.md #36).
    const bands = parseB3Bands(baseline);
    if (hasBaseline && bands.length === 0) {
      // Loud, never silent: the section prints NOT CHECKED and this says why.
      console.error('[report] baseline has no readable B3 flag table - round size NOT checked');
    }
    const b3Section = renderB3Section(
      checkRoundSizes(
        added.map((e) => ({ ...e, country: e.country ?? UNKNOWN_COUNTRY })),
        bands,
        baselineCountry,
      ),
      bands,
      hasBaseline,
      baselineCountry,
    );

    // Written HERE, not by the model, whenever there is no baseline: "None."
    // and "never measured" are different results and printed the same (§10).
    const noBaselineSection = '## Divergence from baseline\nNot measured — no baseline recorded.';

    if (findings.length === 0) {
      const divergence = hasBaseline ? '## Divergence from baseline\nNone.' : noBaselineSection;
      // B3 belongs on THIS branch too: a guarantee enforced on one path is
      // not enforced (CLAUDE.md §9), and a run with no findings still has
      // events in the ledger to check.
      return { report: `${eventSection}${b3Section}\n\n${divergence}`, neurons: 0 };
    }

    // No SOURCE line. Findings now carry their citations inline, per claim, so
    // the single URL that used to head each one has nothing left to say — and
    // saying it anyway is the bug: one source asserted over a blob that mixes
    // several, which the report then dutifully copied onto every claim in it
    // (bugs.md #25). A finding that cites nothing yields no citation, which is
    // the right answer rather than a gap for the model to fill (#22).
    //
    // `findings.source_url` still records what the iteration read. It is kept
    // for /state and the sources table; it is no longer evidence of origin.
    const body = findings.map((f) => `[${f.n}] ${f.finding}`).join('\n\n');
    const res = (await this.env.AI.run(this.env.REASON_MODEL, {
      messages: [
        { role: 'system', content: hasBaseline ? REPORT_SYSTEM : REPORT_SYSTEM + NO_BASELINE_RULE },
        {
          role: 'user',
          content: `TOPIC: ${topic}\n\nGOALS:\n${goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}\n\nFINDINGS:\n${body}`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.3,
    })) as { response?: string; usage?: AiUsage };

    // Metered on return, before the caller's `finishRun` can throw (bugs.md #19).
    const neurons = await meterCall(this.env.DB, this.env.REASON_MODEL, res.usage);

    // Last gate on the deliverable: a URL may appear in the report only if a
    // finding actually carried it. #13, #22 and #25 all reached the user here,
    // and an invariant enforced one step upstream is not enforced (§9).
    const raw = (res.response ?? '').trim();
    // The ledger section is ours and is already grounded; only the model's half
    // is swept. Its URLs must have come from a finding (bugs.md #13, #22, #25).
    const swept = raw ? stripUngroundedUrls(raw, urlsIn(body)) : body;
    // The model is ASKED to omit the section; that it actually did is not
    // assumed. Instruction has lost to this model on the report surface before
    // (#25, #28), so the code removes it and writes its own.
    // The model is TOLD to omit both code-owned sections; that it did is not
    // assumed. Instruction has lost on this surface before (#25, #28, #36).
    // Every section the code owns is removed from the model's half, whatever
    // it emitted. `Notes` is on the list not because the code writes one but
    // because nothing should: 3 of 3 delta reports used it to restate a
    // recorded event, one contradicting its own "None today." (bugs.md #37).
    let prose = hasBaseline ? swept : dropSection(swept, 'Divergence from baseline');
    for (const owned of [B3_HEADING, 'Notes']) prose = dropSection(prose, owned);
    const report = hasBaseline
      ? `${eventSection}${b3Section}\n\n${prose}`
      : `${eventSection}${b3Section}\n\n${noBaselineSection}${prose ? `\n\n${prose}` : ''}`;
    return { report, neurons };
  }
}
