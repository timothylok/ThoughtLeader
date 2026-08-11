import type { Reasoning } from './types.ts';
import type { Recalled } from './memory.ts';

const SYSTEM = `You are a research agent working through a topic across many short iterations.

You are given: the research goals, new material from the source just read, excerpts recalled from earlier sources, and your own prior findings.

Rules:
- Ground every claim in the provided material. If it does not support a claim, write "not stated in the sources read so far" rather than guessing.
- PRIORITISE GOALS THAT PRIOR FINDINGS HAVE NOT YET ANSWERED. If a goal is already covered, do not restate it — work on an open one.
- BE SPECIFIC: prefer counts, dollar figures, dates, percentages and named entities (companies, investors, places) over general statements. A finding with no proper nouns or numbers is a weak finding.
- Answer the goal that was actually asked. If a goal names particular things (cities, sectors, categories), address those things — do not substitute a different one.
- Do not repeat a prior finding. Advance the research or name what is still missing.
- Keep the finding under 200 words.

Respond with ONLY a JSON object, no prose or code fences:
{
  "finding": "what you learned this iteration, grounded in the material, with specifics",
  "goalsAdvanced": [1],
  "progress": "which goals are now answered, which are still open",
  "newSources": ["URLs that appear in the material you were given, or []"],
  "done": false
}

"newSources" must only contain URLs that literally appear in the material shown to you. Do not construct or recall URLs from memory — invented URLs are discarded.

Set "done": true only when the material genuinely satisfies every goal.`;

export function buildPrompt(
  topic: string,
  goals: string[],
  fresh: string[],
  recalled: Recalled[],
  priorFindings: { n: number; finding: string }[],
  currentUrl: string | null,
): { role: string; content: string }[] {
  const goalList = goals.map((g, i) => `${i + 1}. ${g}`).join('\n');

  const freshText =
    fresh.length > 0
      ? fresh.map((t, i) => `[new ${i + 1}] ${t}`).join('\n\n')
      : '(nothing new was read this iteration)';

  const recalledText =
    recalled.length > 0
      ? recalled
          .map(
            (r, i) =>
              `[mem ${i + 1}] (${r.type}, relevance ${r.score.toFixed(3)}, from ${r.sourceUrl || 'prior reasoning'})\n${r.text}`,
          )
          .join('\n\n')
      : '(no earlier material recalled)';

  const prior =
    priorFindings.length > 0
      ? priorFindings.map((f) => `- [iteration ${f.n}] ${f.finding}`).join('\n')
      : '(this is the first iteration)';

  const user = [
    `TOPIC: ${topic}`,
    ``,
    `GOALS:`,
    goalList,
    ``,
    currentUrl ? `JUST READ: ${currentUrl}` : `JUST READ: (nothing new this iteration)`,
    ``,
    `NEW MATERIAL FROM THAT SOURCE:`,
    freshText,
    ``,
    `RECALLED FROM EARLIER SOURCES:`,
    recalledText,
    ``,
    `YOUR PRIOR FINDINGS:`,
    prior,
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

/**
 * Workers AI returns `response` as a STRING for prose but as an already-parsed
 * OBJECT when the model emits valid JSON — and this prompt asks for JSON, so
 * both shapes occur in normal operation. Handle either.
 *
 * Small models also wrap JSON in prose or code fences despite instructions.
 * Recover what we can; a malformed response must not kill a long-running run.
 */
export function parseReasoning(raw: unknown): Reasoning {
  if (raw && typeof raw === 'object') {
    return fromObject(raw as Record<string, unknown>, JSON.stringify(raw));
  }

  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const json = extractJson(text);
  if (!json) return unparsed(text);

  try {
    return fromObject(JSON.parse(json) as Record<string, unknown>, text);
  } catch {
    return unparsed(text);
  }
}

function fromObject(o: Record<string, unknown>, original: string): Reasoning {
  const finding = typeof o.finding === 'string' ? o.finding.trim() : '';
  if (!finding) return unparsed(original);

  return {
    finding,
    progress: typeof o.progress === 'string' ? o.progress.trim() : '',
    // Raw strings only. These are filtered downstream in selectNextSources()
    // against links actually observed on fetched pages — syntax validation here
    // would wrongly imply these URLs exist (bugs.md #12).
    newSources: Array.isArray(o.newSources)
      ? o.newSources.filter((u): u is string => typeof u === 'string')
      : [],
    done: o.done === true,
  };
}

function unparsed(text: string): Reasoning {
  return {
    finding: text.trim().slice(0, 2000),
    progress: 'unparsed model response',
    newSources: [],
    done: false,
  };
}

/** First balanced {...} span, ignoring braces inside strings. */
function extractJson(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

/** Query text used to pull relevant memory for this iteration. */
export function recallQuery(topic: string, goals: string[], lastProgress: string): string {
  return [topic, ...goals, lastProgress].filter(Boolean).join('\n');
}

export const REPORT_SYSTEM = `You are writing the final report for a research run.

Structure: one section per goal, in order, headed with the goal text.

For each goal:
- Open with a one-word verdict in bold: **Answered**, **Partial**, or **Unanswered**.
- Then give the direct answer, built ONLY from the findings supplied.
- Lead with specifics: counts, dollar figures, dates, percentages, named companies, named investors, named places. Vague summary is a failure.
- Cite the source URL for each substantive claim, copied exactly from the SOURCE line of the finding it came from. Never construct, complete or guess a URL — not even by adding "www." — and never cite a bare [n] index.
- If the findings do not answer the goal, say so in one line and state what is missing. Do not pad.

End with a short "Gaps" section listing what a follow-up run should target.

No preamble, no restating the task, no concluding pep talk. Under 800 words.`;
