export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  LOOP: Workflow<RunParams>;
  DB: D1Database;

  /** e.g. "18 minutes" — template-literal type enforced by Workflows. */
  ITERATION_INTERVAL: WorkflowSleepDuration;
  REASON_MODEL: string;
  EMBED_MODEL: string;
  ITERATIONS_PER_GEN: string;
  MAX_FETCH_BYTES: string;
  RECALL_TOP_K: string;
  MAX_SOURCE_DEPTH: string;
  /** Characters of the current source carried into the prompt. */
  FRESH_CHARS: string;
  /** Hard stop on neurons spent per UTC day, across all runs. 0 = unlimited. */
  DAILY_NEURON_BUDGET: string;

  /**
   * Slack/Discord webhook for failure alerts. Set with
   * `wrangler secret put ALERT_WEBHOOK` — never in wrangler.jsonc, it is a
   * credential. Unset means alerting is silently disabled.
   */
  ALERT_WEBHOOK?: string;

  /**
   * Shared secret for the routes that write or spend. Set with
   * `wrangler secret put CONTROL_TOKEN` — never in wrangler.jsonc, it is a
   * credential. **Unset denies those routes**; it must never read as "no auth
   * configured, let it through" (CLAUDE.md §10).
   */
  CONTROL_TOKEN?: string;
}

/**
 * The `usage` block on a Workers AI response. `neurons` is present on text
 * generation and **absent on embeddings**, which return token counts only
 * (bugs.md #21) — so every field here is optional and none may be assumed.
 */
export interface AiUsage {
  neurons?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Workflow instance params. Carried across generations. */
export interface RunParams {
  runId: string;
  topic: string;
  goals: string[];
  maxIterations: number;
  /** Iterations already completed by previous generations. */
  startAt: number;
  generation: number;
}

export interface StartRequest {
  topic: string;
  goals: string[];
  sources: string[];
  maxIterations?: number;
  /** Seed the run without launching the workflow — for testing via /step. */
  dryRun?: boolean;
}

/** Parsed output of the reasoning step. */
export interface Reasoning {
  finding: string;
  progress: string;
  newSources: string[];
  done: boolean;
  /**
   * Funding events, as the model wrote them — one pipe-delimited line each.
   *
   * Flat strings rather than nested objects on purpose. `parseReasoning` already
   * exists because this model wraps JSON in prose and code fences; asking it for
   * an array of objects raises the failure rate of the step that produces all the
   * value. A malformed line is dropped and its neighbours survive, which nested
   * JSON cannot offer.
   */
  events: string[];
}

/** One funding event, after parsing and marker resolution. */
export interface FundingEvent {
  /** Dedupe identity: normalised company + stage. */
  key: string;
  company: string;
  sector: string | null;
  amount: string | null;
  stage: string | null;
  investors: string | null;
  eventDate: string | null;
  /** Canonical bucket from `normCountry` — 'AU', 'NZ', a verbatim other, or
   *  'unknown'. Never null: "not stated" is a value here, not an absence, so it
   *  cannot be mistaken for the baseline's country (bugs.md #39). */
  country: string;
  /** Resolved from a [S#] marker against the iteration's citable set — never
   *  a string the model composed (bugs.md #25). */
  sourceUrl: string | null;
  raw: string;
}

export interface IngestResult {
  url: string | null;
  sourceId: number | null;
  chunks: number;
  /**
   * Exact `usage.neurons` from embedding those chunks — never an estimate
   * (bugs.md #17). DIAGNOSTIC ONLY: `embed()` already wrote this to the ledger
   * when the call returned. Adding it to a total again double-counts (bugs.md #19).
   */
  neurons: number;
  bytes: number;
  truncated: boolean;
  error: string | null;
  /**
   * Text from THIS iteration's source, carried directly into the prompt.
   * Vectorize inserts are asynchronous (~15-30s to index), so a recall issued
   * in the same iteration cannot see what was just written. Recall supplies
   * history; these excerpts supply the present.
   */
  excerpts: string[];
  /** Links actually present on this page — the only URLs allowed to be queued. */
  links: string[];
}

/**
 * Parse a numeric config var, preserving a legitimate 0.
 *
 * `Number(v) || fallback` looks equivalent but silently discards 0 — which is
 * how MAX_SOURCE_DEPTH="0" ("disable model-proposed sources") became 2 and let
 * a run keep crawling. Config values of 0 are meaningful here.
 */
export function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export type TerminationReason =
  | 'goals-met'
  | 'sources-exhausted'
  | 'max-iterations'
  | 'stopped'
  | 'budget-exhausted';
