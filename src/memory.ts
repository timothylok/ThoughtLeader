/**
 * Semantic memory over Vectorize.
 *
 * Run isolation uses NAMESPACES, not metadata filters. Vectorize will not
 * backfill a metadata index: vectors inserted before an index exists are
 * permanently invisible to it. Namespaces need no pre-declaration, so they are
 * safe to create at any time. The single metadata index (`type`) is created at
 * setup, before the first insert. See README §2.4.
 */

import type { Env } from './types.ts';

export type MemoryType = 'chunk' | 'finding';

export interface Recalled {
  text: string;
  score: number;
  sourceUrl: string;
  type: MemoryType;
}

interface MemoryMetadata extends Record<string, VectorizeVectorMetadataValue> {
  type: MemoryType;
  text: string;
  sourceUrl: string;
  n: number;
}

/** Vectorize namespaces cap at 64 bytes. */
function namespaceFor(runId: string): string {
  return runId.slice(0, 64);
}

/**
 * Every Workers AI response carries exact `usage.neurons`. Report it rather than
 * estimating: the old `chunks * 0.64` arithmetic, plus two call sites that counted
 * nothing at all, made the spend guard read 21% low and let the free allocation
 * run out while `/usage` showed 79% (bugs.md #17).
 */
export async function embed(
  env: Env,
  texts: string[],
): Promise<{ vectors: number[][]; neurons: number }> {
  if (texts.length === 0) return { vectors: [], neurons: 0 };
  const res = (await env.AI.run(env.EMBED_MODEL, { text: texts })) as {
    data: number[][];
    usage?: { neurons?: number };
  };
  if (!res?.data?.length) throw new Error('embedding model returned no data');
  return { vectors: res.data, neurons: res.usage?.neurons ?? 0 };
}

export interface MemoryItem {
  /**
   * Stable identity, unique within the run. MUST NOT be derived from the
   * iteration number alone: a failed iteration doesn't advance the counter, so
   * the next one reuses `n` and upsert silently overwrites the previous
   * source's vectors. Key chunks by source id, findings by iteration.
   */
  key: string;
  text: string;
  sourceUrl: string;
  type: MemoryType;
  n: number;
}

/**
 * Metadata carries the source text so recall needs no second round-trip to D1.
 * Vectorize allows 10KiB metadata per vector; chunks are ~1.4KB, well inside it.
 */
export async function remember(
  env: Env,
  runId: string,
  items: MemoryItem[],
): Promise<{ stored: number; neurons: number }> {
  if (items.length === 0) return { stored: 0, neurons: 0 };

  const { vectors, neurons } = await embed(
    env,
    items.map((i) => i.text),
  );

  const ns = namespaceFor(runId);
  const payload: VectorizeVector[] = items.map((item, i) => ({
    id: `${runId}:${item.key}`,
    values: vectors[i]!,
    namespace: ns,
    metadata: {
      type: item.type,
      text: item.text.slice(0, 8000),
      sourceUrl: item.sourceUrl,
      n: item.n,
    } satisfies MemoryMetadata,
  }));

  await env.VECTORIZE.upsert(payload);
  return { stored: payload.length, neurons };
}

/** Chunk key: stable per source, so re-ingesting overwrites only itself. */
export const chunkKey = (sourceId: number, i: number) => `chunk:${sourceId}:${i}`;

/** Finding key: one finding per iteration, so `n` is safe here. */
export const findingKey = (n: number) => `finding:${n}`;

/** Nearest memories within this run only. */
export async function recall(
  env: Env,
  runId: string,
  query: string,
  topK: number,
  type?: MemoryType,
): Promise<{ items: Recalled[]; neurons: number }> {
  const { vectors, neurons } = await embed(env, [query]);
  const vector = vectors[0];
  if (!vector) return { items: [], neurons };

  const res = await env.VECTORIZE.query(vector, {
    topK,
    namespace: namespaceFor(runId),
    returnMetadata: 'all',
    ...(type ? { filter: { type } } : {}),
  });

  const items = (res.matches ?? []).map((m) => {
    const meta = (m.metadata ?? {}) as Partial<MemoryMetadata>;
    return {
      text: String(meta.text ?? ''),
      score: m.score,
      sourceUrl: String(meta.sourceUrl ?? ''),
      type: (meta.type as MemoryType) ?? 'chunk',
    };
  });

  return { items, neurons };
}
