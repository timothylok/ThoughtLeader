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
  /** Hard stop on neurons spent per UTC day, across all runs. 0 = unlimited. */
  DAILY_NEURON_BUDGET: string;
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
}

export interface IngestResult {
  url: string | null;
  sourceId: number | null;
  chunks: number;
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
