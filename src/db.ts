import type { Reasoning, TerminationReason } from './types.ts';

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
): Promise<number> {
  const ts = now();
  // Idempotent: the enclosing step can fail after this INSERT and be retried.
  // Without the upsert, iteration 11 of run 19ac529b produced 6 finding rows.
  const row = await db
    .prepare(
      `INSERT INTO findings (run_id, n, source_url, finding, progress, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(run_id, n) DO UPDATE SET
         source_url = ?3, finding = ?4, progress = ?5
       RETURNING id`,
    )
    .bind(runId, n, sourceUrl, r.finding, r.progress, ts)
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

// --- neuron budget ---------------------------------------------------------

export const utcDay = (at = Date.now()): string => new Date(at).toISOString().slice(0, 10);

/** Accumulate spend for today and return the new running total. */
export async function addNeurons(
  db: D1Database,
  neurons: number,
): Promise<number> {
  const day = utcDay();
  const row = await db
    .prepare(
      `INSERT INTO usage (day, neurons, calls) VALUES (?1, ?2, 1)
       ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2, calls = calls + 1
       RETURNING neurons`,
    )
    .bind(day, neurons)
    .first<{ neurons: number }>();
  return row?.neurons ?? 0;
}

export async function neuronsToday(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT neurons FROM usage WHERE day = ?`)
    .bind(utcDay())
    .first<{ neurons: number }>();
  return row?.neurons ?? 0;
}

export async function usageHistory(db: D1Database, days = 14) {
  const { results } = await db
    .prepare(`SELECT day, neurons, calls FROM usage ORDER BY day DESC LIMIT ?`)
    .bind(days)
    .all();
  return results;
}
