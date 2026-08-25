import type { AiUsage, FundingEvent, Reasoning, TerminationReason } from './types.ts';

const now = () => Date.now();

export async function createRun(
  db: D1Database,
  runId: string,
  topic: string,
  goals: string[],
  maxIterations: number,
  sources: string[],
): Promise<void> {
  const ts = now();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO runs (id, topic, goals, status, max_iterations, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .bind(runId, topic, JSON.stringify(goals), maxIterations, ts, ts),
  ];

  const insertSource = db.prepare(
    `INSERT OR IGNORE INTO sources (run_id, url, depth, created_at) VALUES (?, ?, 0, ?)`,
  );
  for (const url of sources) stmts.push(insertSource.bind(runId, url, ts));

  await db.batch(stmts);
}

/**
 * Claim the next pending source. Marking it 'fetched' up front means a crash
 * mid-ingest skips the URL rather than retrying it forever — a poison source
 * cannot wedge the run.
 */
export async function claimSource(
  db: D1Database,
  runId: string,
): Promise<{ id: number; url: string } | null> {
  const row = await db
    .prepare(
      `UPDATE sources SET status = 'fetched'
       WHERE id = (
         SELECT id FROM sources
         WHERE run_id = ?1 AND status = 'pending'
         ORDER BY depth ASC, id ASC LIMIT 1
       )
       RETURNING id, url`,
    )
    .bind(runId)
    .first<{ id: number; url: string }>();

  return row ?? null;
}

export async function markSourceResult(
  db: D1Database,
  sourceId: number,
  chunks: number,
  error: string | null,
): Promise<void> {
  await db
    .prepare(`UPDATE sources SET chunks = ?, error = ?, status = ? WHERE id = ?`)
    .bind(chunks, error, error ? 'failed' : 'fetched', sourceId)
    .run();
}

export async function enqueueSources(
  db: D1Database,
  runId: string,
  urls: string[],
  depth: number,
): Promise<number> {
  if (urls.length === 0) return 0;
  const ts = now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO sources (run_id, url, depth, created_at) VALUES (?, ?, ?, ?)`,
  );
  const res = await db.batch(urls.map((u) => stmt.bind(runId, u, depth, ts)));
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Model-proposed sources already queued for this run (depth > 0). */
export async function addedSourceCount(db: D1Database, runId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM sources WHERE run_id = ? AND depth > 0`)
    .bind(runId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function pendingSourceCount(db: D1Database, runId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM sources WHERE run_id = ? AND status = 'pending'`)
    .bind(runId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function recordFinding(
  db: D1Database,
  runId: string,
  n: number,
  sourceUrl: string | null,
  r: Reasoning,
  /** Ledger companies this finding named despite being told not to (#37). */
  leaked: string[],
): Promise<number> {
  const ts = now();
  // Idempotent: the enclosing step can fail after this INSERT and be retried.
  // Without the upsert, iteration 11 of run 19ac529b produced 6 finding rows.
  const row = await db
    .prepare(
      `INSERT INTO findings (run_id, n, source_url, finding, progress, leaked, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(run_id, n) DO UPDATE SET
         source_url = ?3, finding = ?4, progress = ?5, leaked = ?6
       RETURNING id`,
    )
    // NULL when clean, so the rate is one query:
    //   SELECT COUNT(*) FILTER (WHERE leaked IS NOT NULL), COUNT(*) FROM findings
    .bind(runId, n, sourceUrl, r.finding, r.progress,
          leaked.length ? JSON.stringify(leaked) : null, ts)
    .first<{ id: number }>();

  await db
    .prepare(`UPDATE runs SET iterations = ?, updated_at = ? WHERE id = ?`)
    .bind(n, ts, runId)
    .run();

  return row?.id ?? 0;
}

/** Most recent findings, oldest-first, for prompt context. */
export async function recentFindings(
  db: D1Database,
  runId: string,
  limit: number,
): Promise<{ n: number; finding: string; source_url: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT n, finding, source_url FROM findings WHERE run_id = ? ORDER BY n DESC LIMIT ?`,
    )
    .bind(runId, limit)
    .all<{ n: number; finding: string; source_url: string | null }>();
  return results.reverse();
}

export async function finishRun(
  db: D1Database,
  runId: string,
  reason: TerminationReason,
  report: string | null,
): Promise<void> {
  const status = reason === 'stopped' ? 'stopped' : 'done';
  await db
    .prepare(`UPDATE runs SET status = ?, reason = ?, report = ?, updated_at = ? WHERE id = ?`)
    .bind(status, reason, report, now(), runId)
    .run();
}

export async function failRun(db: D1Database, runId: string, err: string): Promise<void> {
  await db
    .prepare(`UPDATE runs SET status = 'failed', reason = ?, updated_at = ? WHERE id = ?`)
    .bind(err.slice(0, 500), now(), runId)
    .run();
}

export async function getRun(db: D1Database, runId: string) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).bind(runId).first();
}

export async function listRuns(db: D1Database, limit = 20) {
  const { results } = await db
    .prepare(
      `SELECT id, topic, status, reason, iterations, max_iterations, created_at
       FROM runs ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results;
}

// --- kill switch -----------------------------------------------------------

const stopKey = (runId: string) => `stop:${runId}`;

export async function requestStop(db: D1Database, runId: string): Promise<void> {
  await db
    .prepare(`INSERT OR REPLACE INTO control (key, value) VALUES (?, '1')`)
    .bind(stopKey(runId))
    .run();
}

export async function isStopRequested(db: D1Database, runId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM control WHERE key = ?`)
    .bind(stopKey(runId))
    .first<{ value: string }>();
  return row?.value === '1';
}

export async function clearStop(db: D1Database, runId: string): Promise<void> {
  await db.prepare(`DELETE FROM control WHERE key = ?`).bind(stopKey(runId)).run();
}

// --- generic control values ------------------------------------------------

/**
 * Append this iteration's events to the ledger, skipping ones already recorded.
 *
 * `ON CONFLICT DO NOTHING` is what makes the enclosing step safe to retry:
 * Workflows re-runs a step that failed after its writes, and a plain INSERT
 * would duplicate the ledger the way iteration 11 of run 19ac529b duplicated
 * findings (bugs.md #7).
 *
 * Returns the number ACTUALLY inserted — not the number offered — so a caller
 * reporting "3 new events" is reporting inserts rather than mentions.
 */
export async function recordEvents(
  db: D1Database,
  runId: string,
  n: number,
  events: FundingEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO events
       (key, company, sector, amount, stage, investors, event_date, country, source_url, raw, run_id, n, first_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(key) DO NOTHING`,
  );
  const results = await db.batch(
    events.map((e) =>
      stmt.bind(
        e.key,
        e.company,
        e.sector,
        e.amount,
        e.stage,
        e.investors,
        e.eventDate,
        e.country,
        e.sourceUrl,
        e.raw,
        runId,
        n,
        ts,
      ),
    ),
  );
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

/** Ledger entries, newest first. The prompt's "already recorded" list. */
export async function recentEvents(
  db: D1Database,
  limit: number,
): Promise<FundingEventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT company, sector, amount, stage, investors, event_date, country, source_url, run_id, first_seen
         FROM events ORDER BY first_seen DESC LIMIT ?`,
    )
    .bind(limit)
    .all<FundingEventRow>();
  return results;
}

/** Everything one run added to the ledger — the daily digest's content. */
export async function eventsForRun(db: D1Database, runId: string): Promise<FundingEventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT company, sector, amount, stage, investors, event_date, country, source_url, run_id, first_seen
         FROM events WHERE run_id = ? ORDER BY first_seen`,
    )
    .bind(runId)
    .all<FundingEventRow>();
  return results;
}

export interface FundingEventRow {
  company: string;
  sector: string | null;
  amount: string | null;
  stage: string | null;
  investors: string | null;
  event_date: string | null;
  /** Canonical bucket. NULL only on rows written before the column existed —
   *  and there are none: the seven that predate it were backfilled, so NULL
   *  never has to mean both "unclassified" and "AU" (CLAUDE.md §14). */
  country: string | null;
  source_url: string | null;
  run_id: string;
  first_seen: number;
}

export async function getControl(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM control WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setControl(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT OR REPLACE INTO control (key, value) VALUES (?, ?)`)
    .bind(key, value)
    .run();
}

/** Runs currently in `status='running'`, whatever started them. */
export async function runningRunCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- neuron budget ---------------------------------------------------------

export const utcDay = (at = Date.now()): string => new Date(at).toISOString().slice(0, 10);

/**
 * Neurons per million INPUT tokens, by model id, from
 * developers.cloudflare.com/workers-ai/platform/pricing.
 *
 * Only embedding models belong here. Text-generation models return an exact
 * `usage.neurons` and are priced from input *and* output tokens at different
 * rates, so a single input-token constant would be wrong for them — if one ever
 * stops returning `neurons`, `priceCall` must shout rather than guess.
 */
const EMBEDDING_NEURONS_PER_M_INPUT_TOKENS: Record<string, number> = {
  '@cf/baai/bge-small-en-v1.5': 1841,
};

/**
 * What one AI call cost, in neurons.
 *
 * Order matters: the provider's own figure wins when it exists; otherwise an
 * embedding model is priced from its exact `total_tokens` times its published
 * rate. Anything else is UNKNOWN, and unknown must never be silently free —
 * `?? 0` on a missing `usage.neurons` is what let embeddings meter as zero
 * forever (bugs.md #21).
 */
export function priceCall(model: string, usage: AiUsage | undefined): number {
  if (typeof usage?.neurons === 'number') return usage.neurons;

  const rate = EMBEDDING_NEURONS_PER_M_INPUT_TOKENS[model];
  const tokens = usage?.total_tokens ?? usage?.prompt_tokens;
  if (rate !== undefined && typeof tokens === 'number') {
    return (tokens * rate) / 1_000_000;
  }

  console.error(
    `[spend] UNPRICED AI CALL model=${model} usage=${JSON.stringify(usage ?? null)} — ` +
      `no usage.neurons and no entry in EMBEDDING_NEURONS_PER_M_INPUT_TOKENS. ` +
      `SPEND IS BEING UNDERCOUNTED; add this model's rate from Cloudflare pricing.`,
  );
  return 0;
}

/**
 * Price one AI call and record it. The ONLY way spend enters the ledger — call
 * it immediately after `AI.run` returns, before anything else in the step can
 * throw, because Cloudflare bills every retried attempt (bugs.md #19).
 */
export async function meterCall(
  db: D1Database,
  model: string,
  usage: AiUsage | undefined,
): Promise<number> {
  const neurons = priceCall(model, usage);
  await addNeurons(db, model, neurons);
  return neurons;
}

/** Record one AI call's spend as its own row — never aggregated into an
 * existing one, so the guard can sum a real trailing window (bugs.md #20). */
async function addNeurons(db: D1Database, model: string, neurons: number): Promise<void> {
  const at = Date.now();
  await db
    .prepare(`INSERT INTO usage (at, day, model, neurons, calls) VALUES (?1, ?2, ?3, ?4, 1)`)
    .bind(at, utcDay(at), model, neurons)
    .run();
}

/**
 * The guard's number: spend across ALL models in the trailing 24 hours from
 * `at` (default now).
 *
 * A UTC-calendar-day sum is the WRONG window: bugs.md #20 measured that
 * Cloudflare enforces something closer to a rolling ~24h window, so a guard
 * keyed on `day` can read 0 right after UTC midnight while the platform is
 * still refusing calls against yesterday's usage — authorising spend the
 * provider then rejects mid-run. `usage` is one row per call, so this is a
 * real sum over the window that matters, not an approximation of one.
 */
export async function neuronsInTrailing24h(db: D1Database, at = Date.now()): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(neurons), 0) AS neurons FROM usage WHERE at > ?`)
    .bind(at - 24 * 60 * 60 * 1000)
    .first<{ neurons: number }>();
  return row?.neurons ?? 0;
}

export async function usageHistory(db: D1Database, days = 14) {
  const { results } = await db
    .prepare(
      `SELECT day, SUM(neurons) AS neurons, SUM(calls) AS calls
       FROM usage GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .bind(days)
    .all();
  return results;
}

/**
 * Per-model spend for one UTC day — the shape Cloudflare's `aiInferenceAdaptiveGroups`
 * reports, so `/usage` can be compared against the provider model by model instead
 * of as one aggregate (bugs.md #23). Defaults to today.
 *
 * Must GROUP BY, not SELECT — one row per call now, not per (day, model), so
 * a day with several calls to the same model has several rows to fold together.
 */
export async function usageByModel(db: D1Database, day = utcDay()) {
  const { results } = await db
    .prepare(
      `SELECT model, SUM(neurons) AS neurons, SUM(calls) AS calls
       FROM usage WHERE day = ? GROUP BY model ORDER BY neurons DESC`,
    )
    .bind(day)
    .all();
  return results;
}
