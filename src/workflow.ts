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
import { num, type Env, type RunParams, type Reasoning, type TerminationReason, type IngestResult } from './types.ts';
import { fetchSource, chunk, selectNextSources } from './ingest.ts';
import { recall, remember, chunkKey, findingKey, type Recalled } from './memory.ts';
import { buildPrompt, parseReasoning, recallQuery, REPORT_SYSTEM } from './prompt.ts';
import {
  claimSource,
  markSourceResult,
  enqueueSources,
  pendingSourceCount,
  addedSourceCount,
  recordFinding,
  recentFindings,
  finishRun,
  failRun,
  isStopRequested,
  addNeurons,
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

/** Chunks from the current source carried into the prompt. ~6 × 1.4KB. */
const FRESH_EXCERPTS = 6;

/** Ceiling on model-proposed sources per run, on top of the per-iteration cap. */
const MAX_ADDED_SOURCES_PER_RUN = 10;

export class ResearchLoop extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<void> {
    const { runId, topic, goals, maxIterations, startAt, generation } = event.payload;
    const env = this.env;

    const perGen = num(env.ITERATIONS_PER_GEN, 100);
    const topK = num(env.RECALL_TOP_K, 8);
    const maxBytes = num(env.MAX_FETCH_BYTES, 262_144);
    const maxDepth = num(env.MAX_SOURCE_DEPTH, 2);
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
              excerpts: pieces.slice(0, FRESH_EXCERPTS),
              links: doc.links,
            };
          },
        );

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
          async (): Promise<Reasoning & { neurons: number }> => {
            const prior = await recentFindings(env.DB, runId, PRIOR_FINDINGS_IN_PROMPT);
            const messages = buildPrompt(
              topic,
              goals,
              ingested.excerpts,
              recalled.items,
              prior,
              ingested.error ? null : ingested.url,
            );
            const res = (await env.AI.run(env.REASON_MODEL, {
              messages,
              max_tokens: 700,
              temperature: 0.4,
            })) as { response?: unknown; usage?: { neurons?: number } };
            return { ...parseReasoning(res.response), neurons: res.usage?.neurons ?? 0 };
          },
        );

        // 5. Commit: finding to D1, finding to vector memory, new sources queued.
        const recorded = await step.do(`record:${n}`, async () => {
          const findingId = await recordFinding(env.DB, runId, n, ingested.url, reasoning);

          const remembered = await remember(env, runId, [
            {
              key: findingKey(n),
              text: reasoning.finding,
              sourceUrl: ingested.url ?? '',
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

          // EVERY AI call this iteration made, each from its own exact
          // `usage.neurons`. Estimating the embeddings and omitting the recall
          // query made the guard read 21% low (bugs.md #17), which let actual
          // usage pass the free allocation while `/usage` still showed headroom.
          const spent = await addNeurons(
            env.DB,
            reasoning.neurons + ingested.neurons + recalled.neurons + remembered.neurons,
          );

          return { findingId, enqueued, spentToday: spent };
        });

        lastProgress = reasoning.progress;

        // 6. Assess AFTER the commit, so termination sees committed state.
        const verdict = await step.do(`assess:${n}`, async (): Promise<TerminationReason | null> => {
          if (await isStopRequested(env.DB, runId)) return 'stopped';
          // Spend guard first among the automatic exits: on a Paid plan this is
          // the only hard stop that exists. Budget alerts do not cap usage.
          if (budget > 0 && recorded.spentToday >= budget) return 'budget-exhausted';
          if (reasoning.done) return 'goals-met';
          if (n >= maxIterations) return 'max-iterations';
          if ((await pendingSourceCount(env.DB, runId)) === 0) return 'sources-exhausted';
          return null;
        });

        if (verdict) {
          terminal = verdict;
          break;
        }

        console.log(
          `[${runId}] n=${n} chunks=${ingested.chunks} recalled=${recalled.items.length} ` +
            `enqueued=${recorded.enqueued} neurons=${reasoning.neurons.toFixed(1)} ` +
            `spentToday=${recorded.spentToday.toFixed(0)}/${budget || '∞'}` +
            `${ingested.error ? ` err=${ingested.error}` : ''}`,
        );

        // Free — does not count toward the step limit. This is the pacing lever.
        await step.sleep(`wait:${n}`, env.ITERATION_INTERVAL);
      }

      if (terminal) {
        await step.do(`report:${generation}`, async () => {
          // max_tokens 1200 — the largest single generation in a run, and it was
          // counted nowhere at all before bugs.md #17.
          const { report, neurons } = await this.synthesise(runId, topic, goals);
          await finishRun(env.DB, runId, terminal!, report);
          const spentToday = await addNeurons(env.DB, neurons);
          return { terminal, reportChars: report.length, neurons, spentToday };
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
      if (!isTransient(e)) await failRun(env.DB, runId, String(e));
      throw e;
    }
  }

  /** Final synthesis. Pulls the run's findings straight from D1, in order. */
  private async synthesise(
    runId: string,
    topic: string,
    goals: string[],
  ): Promise<{ report: string; neurons: number }> {
    const findings = await recentFindings(this.env.DB, runId, 60);
    if (findings.length === 0) return { report: 'No findings were recorded.', neurons: 0 };

    // The URL must travel with the finding. Without it the report prompt still
    // demands a citation and the model supplies one anyway — either the bare
    // `[n]` index or a URL reconstructed from an entity name (bugs.md #13).
    const body = findings
      .map((f) => `[${f.n}] SOURCE: ${f.source_url || '(no source recorded)'}\n${f.finding}`)
      .join('\n\n');
    const res = (await this.env.AI.run(this.env.REASON_MODEL, {
      messages: [
        { role: 'system', content: REPORT_SYSTEM },
        {
          role: 'user',
          content: `TOPIC: ${topic}\n\nGOALS:\n${goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}\n\nFINDINGS:\n${body}`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.3,
    })) as { response?: string; usage?: { neurons?: number } };

    return {
      report: (res.response ?? '').trim() || body,
      neurons: res.usage?.neurons ?? 0,
    };
  }
}
