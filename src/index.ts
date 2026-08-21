// @ts-expect-error - bundled as text via the Text rule in wrangler.jsonc
import LIVE_HTML from '../liverun.html';
import { num, type AiUsage, type Env, type StartRequest } from './types.ts';
import { fetchSource, chunk, freshExcerpts, selectNextSources, normalizeUrl } from './ingest.ts';
import { recall, remember, chunkKey, findingKey } from './memory.ts';
import {
  buildPrompt,
  parseReasoning,
  recallQuery,
  citableSources,
  resolveCitations,
  parseEvents,
  leakedCompanies,
  UNKNOWN_COUNTRY,
} from './prompt.ts';
import { alert } from './notify.ts';
import {
  createRun,
  claimSource,
  markSourceResult,
  enqueueSources,
  pendingSourceCount,
  recordFinding,
  recentFindings,
  recordEvents,
  recentEvents,
  getRun,
  listRuns,
  requestStop,
  clearStop,
  failRun,
  finishRun,
  neuronsToday,
  usageHistory,
  usageByModel,
  meterCall,
  utcDay,
  getControl,
  setControl,
  runningRunCount,
} from './db.ts';

export { ResearchLoop } from './workflow.ts';
import { FRESH_CHARS_DEFAULT } from './workflow.ts';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // liverun.html is opened from disk (origin "null"), so it cannot read
      // these responses without CORS. Read-only JSON, no credentials.
      'access-control-allow-origin': '*',
    },
  });

/**
 * Routes that require `CONTROL_TOKEN`. Keyed exactly like the switch below, so
 * there is one list to check a new route against.
 *
 * The invariant is **every route that writes or spends**, not "every POST".
 * `GET /search` mutates nothing and is in here anyway: `recall` embeds the
 * query, and an AI call is a write to the neuron budget. Leaving it out would
 * repeat bugs.md #17, where the recall embedding was the call site the spend
 * guard forgot.
 *
 * Reads stay open: liverun.html polls /state and /usage from file://, and
 * neither costs anything.
 */
const PROTECTED = new Set([
  'POST /start',
  'POST /stop',
  'POST /baseline',
  'POST /step',
  'GET /search',
]);

/**
 * Constant-time compare against the shared secret. `===` on a credential leaks
 * its prefix through timing; `timingSafeEqual` throws on a length mismatch, so
 * the lengths are checked first.
 */
function authorised(request: Request, env: Env): boolean {
  // An unset secret denies. "Not configured" must not mean "not required" —
  // the fail-open default is the one that never raises an alarm (CLAUDE.md §10).
  if (!env.CONTROL_TOKEN) return false;
  const enc = new TextEncoder();
  const got = enc.encode((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
  const want = enc.encode(env.CONTROL_TOKEN);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const runId = url.searchParams.get('run') ?? '';
    const route = `${request.method} ${url.pathname}`;

    if (PROTECTED.has(route) && !authorised(request, env)) {
      return json({ error: 'unauthorised' }, 401);
    }

    try {
      switch (route) {
        case 'POST /start':
          return await start(request, env);
        case 'POST /stop':
          return await stop(env, runId);
        case 'GET /state':
          return await state(env, runId);
        case 'GET /usage':
          return json({
            utcDay: new Date().toISOString().slice(0, 10),
            neuronsToday: await neuronsToday(env.DB),
            dailyBudget: num(env.DAILY_NEURON_BUDGET, 10_000),
            freeAllocation: 10_000,
            // Per model, so this endpoint can be compared directly against
            // Cloudflare's aiInferenceAdaptiveGroups (README §5.2, bugs.md #23).
            // An aggregate-only figure hid #21's 100% embedding miss inside a
            // 1.57% total.
            byModel: await usageByModel(env.DB, url.searchParams.get('day') ?? undefined),
            history: await usageHistory(env.DB),
          });
        case 'GET /events':
          return json({
            events: await recentEvents(env.DB, clamp(Number(url.searchParams.get('limit') ?? 50), 1, 500)),
          });
        case 'GET /baseline':
          return json({ baseline: await getControl(env.DB, 'baseline') });
        case 'POST /baseline': {
          const body = (await request.json().catch(() => ({}))) as { text?: string };
          if (typeof body.text !== 'string') return json({ error: 'body must be {"text": "..."}' }, 400);
          await setControl(env.DB, 'baseline', body.text);
          return json({ ok: true, chars: body.text.length });
        }
        case 'GET /search':
          return await search(env, runId, url.searchParams.get('q') ?? '');
        case 'POST /step':
          return await debugStep(request, env, runId);
        case 'GET /live':
          return new Response(LIVE_HTML as unknown as string, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        case 'GET /':
          return json({
            service: 'cf-research-loop',
            routes: [
              'POST /start   {topic, goals[], sources[], maxIterations?}',
              'POST /stop?run=<id>',
              'GET  /state[?run=<id>]',
              'GET  /search?run=<id>&q=<query>',
              'GET  /usage    (neuron spend today + history)',
              'GET  /events[?limit=50]   (the funding-event ledger, newest first)',
              'GET  /baseline            (the baseline deltas are measured against)',
              'POST /baseline {text}     (set it — Claude Code writes this monthly)',
              'GET  /live?run=<id>   (live dashboard)',
              'POST /step?run=<id>   (one iteration, no continuation)',
              'POST /step   {"probe":"<url>"}   (ingest only, CPU probe)',
            ],
          });
        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },

  /**
   * Cron Triggers land here. Cloudflare schedules them in **UTC only** — there
   * is no local-time or DST handling, so a single expression drifts by an hour
   * against NZ local time between NZST (UTC+12) and NZDT (UTC+13).
   *
   * Both daily arms are registered and both fire every day. Exactly one of them
   * is `DAILY_LOCAL_HOUR` in `DAILY_TZ` for the instant being scheduled; the
   * other returns without starting anything.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (!DAILY_CRONS.includes(controller.cron)) return await watchdog(env);

    // scheduledTime, not Date.now(): the arm is a property of the instant the
    // cron was scheduled for, and invocation can lag across an hour boundary.
    const want = dailyCronFor(controller.scheduledTime);

    if (!DAILY_CRONS.includes(want)) {
      // No registered arm lands on the target local hour, so no arm will ever
      // start a run. Silence here is a day with no research and one log line.
      console.error(`[daily] no registered cron is ${DAILY_LOCAL_HOUR}:00 in ${DAILY_TZ}; wanted "${want}"`);
      await alert(
        env,
        'daily run did NOT start',
        `No cron arm matches "${want}" — the ${DAILY_TZ} UTC offset moved off the hour. ` +
          `Registered: ${DAILY_CRONS.join(', ')}.`,
      );
      return;
    }
    if (controller.cron !== want) {
      console.log(`[daily] "${controller.cron}" is the off-DST arm today (want "${want}"); skipping`);
      return;
    }
    return await startDailyRun(env);
  },
} satisfies ExportedHandler<Env>;

// --- scheduled work --------------------------------------------------------

/** Must match `triggers.crons` in wrangler.jsonc exactly, or they never fire. */
const DAILY_CRONS = ['0 15 * * *', '0 16 * * *'];
const DAILY_TZ = 'Pacific/Auckland';
const DAILY_LOCAL_HOUR = 4;

/**
 * UTC offset of `tz` at `at`, in minutes. Throws rather than guessing: an
 * unreadable offset must not silently become UTC and move the run 12 hours.
 */
function utcOffsetMinutes(tz: string, at: number): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!m) throw new Error(`cannot read UTC offset for ${tz}: "${name}"`);
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * The cron expression that is `DAILY_LOCAL_HOUR` in `DAILY_TZ` at `at`. A zone
 * on a non-whole-hour offset yields an expression matching no arm — handled by
 * the caller, loudly, rather than rounded into the wrong hour.
 */
export function dailyCronFor(at: number): string {
  const utcHour = (24 + DAILY_LOCAL_HOUR - utcOffsetMinutes(DAILY_TZ, at) / 60) % 24;
  return `0 ${utcHour} * * *`;
}

const DAILY_BRIEF_KEY = 'daily_brief';
const DAILY_LAST_RUN_KEY = 'daily_last_run';

/**
 * Start the day's research run from the brief stored in `control.daily_brief`.
 * Keeping the brief in D1 means changing topic, goals or seeds needs no deploy.
 */
async function startDailyRun(env: Env): Promise<void> {
  const today = utcDay();

  if ((await getControl(env.DB, DAILY_LAST_RUN_KEY)) === today) {
    console.log(`[daily] already ran for ${today}; skipping`);
    return;
  }
  const running = await runningRunCount(env.DB);
  if (running > 0) {
    console.log(`[daily] ${running} run(s) still in flight; skipping`);
    return;
  }
  const budget = num(env.DAILY_NEURON_BUDGET, 10_000);
  const spent = await neuronsToday(env.DB);
  if (budget > 0 && spent >= budget) {
    console.log(`[daily] budget reached (${spent.toFixed(0)}/${budget}); skipping`);
    return;
  }

  const raw = await getControl(env.DB, DAILY_BRIEF_KEY);
  if (!raw) {
    console.error(`[daily] no brief stored at control['${DAILY_BRIEF_KEY}'] — nothing to run`);
    await alert(env, 'daily run did NOT start', `No brief stored at control['${DAILY_BRIEF_KEY}'].`);
    return;
  }
  let spec: RunSpec;
  try {
    spec = JSON.parse(raw) as RunSpec;
  } catch (e) {
    console.error(`[daily] control['${DAILY_BRIEF_KEY}'] is not valid JSON: ${String(e)}`);
    await alert(env, 'daily run did NOT start', `Brief is not valid JSON: ${String(e)}`);
    return;
  }

  // Claim the day BEFORE launching. A cron that fires twice, or a launch that
  // fails halfway, must not be able to produce two runs spending against one
  // budget. The cost is that a failed launch is not retried until tomorrow —
  // the safe direction for an unattended loop, and it is logged as an error.
  await setControl(env.DB, DAILY_LAST_RUN_KEY, today);

  try {
    const { runId, seedSources, maxIterations } = await launchRun(env, spec);
    console.log(
      `[daily] started ${runId} for ${today}: ${seedSources} seeds, max ${maxIterations} iterations`,
    );
  } catch (e) {
    console.error(`[daily] launch failed for ${today}, no run today: ${String(e)}`);
    await alert(env, `daily run did NOT start for ${today}`, String(e).slice(0, 800));
  }
}

/**
 * Watchdog. Workflows retry internally, but an instance that exhausts its
 * retries leaves the run stalled with work still queued; this restarts it.
 */
async function watchdog(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, topic, goals, iterations, max_iterations
     FROM runs WHERE status = 'running' AND updated_at < ?`,
  )
    .bind(Date.now() - 2 * 60 * 60 * 1000)
    .all<{
      id: string;
      topic: string;
      goals: string;
      iterations: number;
      max_iterations: number;
    }>();

  // The watchdog restarts stalled runs, which would otherwise be a way to
  // spend past the daily budget without any /start call.
  const budget = num(env.DAILY_NEURON_BUDGET, 10_000);
  if (budget > 0 && (await neuronsToday(env.DB)) >= budget) {
    console.log('[watchdog] daily neuron budget reached; not restarting anything');
    return;
  }

  for (const run of results) {
    if (run.iterations >= run.max_iterations) continue;
    if ((await pendingSourceCount(env.DB, run.id)) === 0) continue;

    const generation = Math.floor(Date.now() / 1000);
    console.log(`[watchdog] restarting ${run.id} at n=${run.iterations}`);
    await env.LOOP.create({
      id: `run-${run.id}-gen-${generation}`,
      params: {
        runId: run.id,
        topic: run.topic,
        goals: JSON.parse(run.goals) as string[],
        maxIterations: run.max_iterations,
        startAt: run.iterations,
        generation,
      },
    });
  }
}

// --- routes ----------------------------------------------------------------

async function start(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<StartRequest>;

  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  const goals = Array.isArray(body.goals) ? body.goals.filter((g) => typeof g === 'string') : [];
  const sources = Array.isArray(body.sources)
    ? body.sources.filter((s): s is string => typeof s === 'string')
    : [];

  if (!topic) return json({ error: 'topic is required' }, 400);
  if (goals.length === 0) return json({ error: 'at least one goal is required' }, 400);
  if (sources.length === 0) return json({ error: 'at least one seed source is required' }, 400);

  let launched: Awaited<ReturnType<typeof launchRun>>;
  try {
    launched = await launchRun(
      env,
      { topic, goals, sources, maxIterations: body.maxIterations ?? 20 },
      body.dryRun === true,
    );
  } catch (e) {
    return json({ error: 'failed to start workflow', detail: String(e) }, 502);
  }

  return json({
    ...launched,
    dryRun: body.dryRun === true,
    topic,
    goals,
    estimatedNeurons: launched.maxIterations * 126,
    watch: `/state?run=${launched.runId}`,
  });
}

interface RunSpec {
  topic: string;
  goals: string[];
  sources: string[];
  maxIterations: number;
}

/**
 * The ONE place a run is created. `POST /start` and the daily cron both go
 * through it, so seed normalisation (bugs.md #14) and the close-on-failed-create
 * (bugs.md #8, #18) cannot drift apart between two callers — which is exactly
 * the defect shape CLAUDE.md §9 is about.
 */
async function launchRun(
  env: Env,
  spec: RunSpec,
  dryRun = false,
): Promise<{ runId: string; instanceId: string | null; seedSources: number; maxIterations: number }> {
  // Seeds go through the SAME normaliser as model-proposed URLs. Without this,
  // seeds are stored verbatim while proposals are canonicalised, so
  // UNIQUE(run_id, url) compares two different forms and never collides —
  // `www.startmate.com/portfolio` and `startmate.com/portfolio` both get fetched
  // (bugs.md #14). Dedupe within the seed list too.
  const sources = [
    ...new Set(
      spec.sources
        .filter((s): s is string => typeof s === 'string')
        .map((s) => normalizeUrl(s))
        .filter((s): s is string => s !== null),
    ),
  ];
  if (!spec.topic) throw new Error('topic is required');
  if (spec.goals.length === 0) throw new Error('at least one goal is required');
  if (sources.length === 0) throw new Error('no usable seed source after normalisation');

  const maxIterations = clamp(spec.maxIterations, 1, 500);
  const runId = crypto.randomUUID().slice(0, 8);

  await createRun(env.DB, runId, spec.topic, spec.goals, maxIterations, sources);
  await clearStop(env.DB, runId);

  // The run row must exist before the workflow starts, or its first step finds
  // no sources. But if instance creation then fails, that row is a zombie:
  // status='running' with work queued, which the watchdog would resurrect
  // hours later into a run nobody started. Fail it closed instead.
  if (dryRun) {
    // A dry run seeds sources and starts nothing — which leaves precisely the
    // zombie described above. The watchdog resurrects exactly that shape after
    // 2h, so a throwaway dry run would launch itself later and spend neurons
    // (bugs.md #18). Close it.
    await finishRun(env.DB, runId, 'stopped', null);
    return { runId, instanceId: null, seedSources: sources.length, maxIterations };
  }

  try {
    const instance = await env.LOOP.create({
      id: `run-${runId}-gen-0`,
      params: {
        runId,
        topic: spec.topic,
        goals: spec.goals,
        maxIterations,
        startAt: 0,
        generation: 0,
      },
    });
    return { runId, instanceId: instance.id, seedSources: sources.length, maxIterations };
  } catch (e) {
    await failRun(env.DB, runId, `workflow create failed: ${String(e)}`);
    throw new Error(`workflow create failed for ${runId}: ${String(e)}`);
  }
}

async function stop(env: Env, runId: string): Promise<Response> {
  if (!runId) return json({ error: 'run parameter required' }, 400);
  await requestStop(env.DB, runId);
  return json({ runId, stopRequested: true, note: 'exits at the next assess step' });
}

async function state(env: Env, runId: string): Promise<Response> {
  if (!runId) return json({ runs: await listRuns(env.DB) });

  const run = await getRun(env.DB, runId);
  if (!run) return json({ error: 'run not found' }, 404);

  const [findings, sources] = await Promise.all([
    env.DB.prepare(
      `SELECT n, source_url, finding, progress FROM findings WHERE run_id = ? ORDER BY n`,
    )
      .bind(runId)
      .all(),
    env.DB.prepare(
      `SELECT url, status, chunks, depth, error FROM sources WHERE run_id = ? ORDER BY id`,
    )
      .bind(runId)
      .all(),
  ]);

  return json({ run, findings: findings.results, sources: sources.results });
}

async function search(env: Env, runId: string, q: string): Promise<Response> {
  if (!runId || !q) return json({ error: 'run and q parameters required' }, 400);
  // Embedding the query is an AI call, so it is metered like any other
  // (bugs.md #10, #17). Cheap, but a guard with exceptions is not a guard.
  // `recall` -> `embed` records it on return; adding it again here would
  // double-count (bugs.md #19).
  const { items, neurons } = await recall(env, runId, q, 10);
  return json({ runId, query: q, matches: items, neurons, spentToday: await neuronsToday(env.DB) });
}

/**
 * One iteration inline, no sleep and no continuation — the only safe way to
 * exercise the pipeline without starting something that keeps running.
 *
 * With {"probe": url} it runs ingest alone, which is what the 10ms CPU
 * measurement needs (README §4.2).
 */
async function debugStep(request: Request, env: Env, runId: string): Promise<Response> {
  const body = await request
    .json()
    .catch(() => ({}) as Record<string, unknown>);
  const probe = (body as { probe?: string }).probe;

  const aiProbe = (body as { ai?: string }).ai;
  if (aiProbe) {
    const raw = (await env.AI.run(env.REASON_MODEL, {
      messages: [{ role: 'user', content: aiProbe }],
      max_tokens: 200,
    })) as { usage?: AiUsage };
    // This debug path spends real neurons. Unmetered, it is a hole in the guard
    // exactly like /step was before bug #10 — close every path to the resource.
    await meterCall(env.DB, env.REASON_MODEL, raw.usage);
    const spentToday = await neuronsToday(env.DB);
    return json({
      model: env.REASON_MODEL,
      rawShape: Object.keys(raw as object),
      raw,
      spentToday,
    });
  }

  if (probe) {
    const t0 = Date.now();
    const doc = await fetchSource(probe, num(env.MAX_FETCH_BYTES, 262_144));
    const fetched = Date.now();
    const pieces = chunk(doc.text);
    return json({
      probe,
      contentType: doc.contentType,
      bytes: doc.bytes,
      truncated: doc.truncated,
      textChars: doc.text.length,
      chunks: pieces.length,
      fetchAndParseMs: fetched - t0,
      chunkMs: Date.now() - fetched,
      note: 'wall-clock, not CPU. Read CPU time from `wrangler tail`.',
      firstChunk: pieces[0]?.slice(0, 400) ?? null,
    });
  }

  if (!runId) return json({ error: 'run parameter required (or pass {"probe": url})' }, 400);

  const run = await getRun(env.DB, runId);
  if (!run) return json({ error: 'run not found' }, 404);

  const topic = String((run as { topic: string }).topic);
  const goals = JSON.parse(String((run as { goals: string }).goals)) as string[];
  const n = Number((run as { iterations: number }).iterations) + 1;

  const budget = num(env.DAILY_NEURON_BUDGET, 10_000);
  const already = await neuronsToday(env.DB);
  if (budget > 0 && already >= budget) {
    return json({ error: 'daily neuron budget exhausted', spentToday: already, budget }, 429);
  }

  const source = await claimSource(env.DB, runId);
  if (!source) return json({ error: 'no pending sources', runId }, 409);

  let chunks = 0;
  let fresh: string[] = [];
  let observedLinks: string[] = [];
  let ingestError: string | null = null;
  try {
    const doc = await fetchSource(source.url, num(env.MAX_FETCH_BYTES, 262_144));
    const pieces = chunk(doc.text);
    // Same window as the workflow, from the same setting and the same function.
    // This was a bare `pieces.slice(0, 6)` duplicating workflow.ts's constant, so
    // /step — the tool used to debug the loop — would have kept reading 6 chunks
    // after the loop moved off it, and the divergence would be invisible
    // (CLAUDE.md §9).
    fresh = freshExcerpts(pieces, num(env.FRESH_CHARS, FRESH_CHARS_DEFAULT));
    observedLinks = doc.links;
    const stored = await remember(
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
    chunks = stored.stored;
    await markSourceResult(env.DB, source.id, chunks, null);
  } catch (e) {
    ingestError = String(e).slice(0, 300);
    await markSourceResult(env.DB, source.id, 0, ingestError);
  }

  // Same rule as the workflow: attribute the finding only to a source that
  // actually contributed material, keyed on chunks rather than on the error flag
  // (bugs.md #22). Without this, /step is a second writer that violates the
  // invariant the workflow now upholds — which is exactly how #12 became #14.
  const contributedUrl = chunks > 0 ? source.url : null;

  const recalled = await recall(
    env,
    runId,
    recallQuery(topic, goals, ''),
    num(env.RECALL_TOP_K, 8),
  );
  const prior = await recentFindings(env.DB, runId, 6);
  const known = await recentEvents(env.DB, 60);
  const baseline = await getControl(env.DB, 'baseline');

  // Same table, same function, same resolver as the workflow — /step is the
  // tool used to debug attribution, so a second derivation here would let the
  // two diverge invisibly (bugs.md #24, CLAUDE.md §9).
  const citable = citableSources(contributedUrl, recalled.items);

  const res = (await env.AI.run(env.REASON_MODEL, {
    messages: buildPrompt(
      topic,
      goals,
      fresh,
      recalled.items,
      prior,
      contributedUrl,
      citable,
      {
        baseline,
        // Country included on this path too. /step is the prompt-debugging
        // tool, so a prompt it builds differently is a prompt not being
        // debugged (bugs.md #24, #37).
        knownEvents: known.map(
          (e) => `${e.company} (${e.stage ?? '—'}, ${e.amount ?? '—'}, ${e.country ?? UNKNOWN_COUNTRY})`,
        ),
      },
    ),
    // 900 to fit the event lines alongside the finding — matches workflow.ts.
    max_tokens: 900,
    temperature: 0.4,
  })) as { response?: unknown; usage?: AiUsage };
  // Metered on return, before the D1 writes below (bugs.md #19). Every embed on
  // this path already recorded itself inside `embed()`.
  await meterCall(env.DB, env.REASON_MODEL, res.usage);

  const parsed = parseReasoning(res.response);
  const cited = resolveCitations(parsed.finding, citable);
  const reasoning = { ...parsed, finding: cited.text };
  const parsedEvents = parseEvents(parsed.events, citable);
  // Same measurement as the workflow, from the same list and the same text.
  // /step is the tool used to debug the prompt, so a rule counted on one path
  // and not the other is a rule that is not counted (bugs.md #24, #37).
  const leaked = leakedCompanies(cited.text, known.map((e) => e.company));
  await recordFinding(env.DB, runId, n, contributedUrl, reasoning, leaked);
  // Same writer as the workflow. /step is a second writer to the ledger, so it
  // has to uphold the same dedupe — this is how #12 became #14.
  const newEvents = await recordEvents(env.DB, runId, n, parsedEvents);
  await remember(env, runId, [
    { key: findingKey(n), text: reasoning.finding, sourceUrl: contributedUrl ?? '', type: 'finding', n },
  ]);
  // /step spends real neurons, so it counts against the same daily budget —
  // otherwise testing is a blind spot in the spend guard. Each call recorded
  // itself as it returned; this only reads the resulting total.
  const spentToday = await neuronsToday(env.DB);
  // Same grounding as the workflow: only URLs actually seen on a fetched page.
  // Without this, /step would silently bypass the bug #12 fix.
  const { accepted, rejected } = selectNextSources(reasoning.newSources, observedLinks);
  const enqueued = await enqueueSources(env.DB, runId, accepted, 1);

  return json({
    runId,
    n,
    source: source.url,
    ingestError,
    chunksStored: chunks,
    // Report the window that was actually applied, not the one requested. A
    // config knob verified only by the value you passed in is a guard checked
    // against itself (CLAUDE.md §10).
    freshCharBudget: num(env.FRESH_CHARS, FRESH_CHARS_DEFAULT),
    freshChunksUsed: fresh.length,
    freshCharsUsed: fresh.reduce((a, t) => a + t.length, 0),
    recalled: recalled.items.length,
    // The attribution table that was actually applied, and what it rejected.
    // Reported from inside the handler for the same reason as the window above:
    // an experiment that cannot show its own treatment was applied produces a
    // clean table either way (bugs.md #26, CLAUDE.md §12).
    citable,
    citationsDropped: cited.dropped,
    eventsParsed: parsedEvents,
    leakedRecordedEvents: leaked,
    eventsInserted: newEvents,
    knownEventsShown: known.length,
    baselinePresent: Boolean(baseline && baseline.trim()),
    reasoning,
    enqueued,
    linksObserved: observedLinks.length,
    proposed: reasoning.newSources,
    accepted,
    rejectedUngrounded: rejected,
    reasonNeurons: res.usage?.neurons ?? null,
    spentToday,
    dailyBudget: num(env.DAILY_NEURON_BUDGET, 10_000),
    pendingSources: await pendingSourceCount(env.DB, runId),
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(v) || lo));
}
