import type { Reasoning } from './types.ts';
import type { Recalled } from './memory.ts';
import { normalizeUrl } from './ingest.ts';

const SYSTEM = `You are a research agent working through a topic across many short iterations.

You are given: the research goals, new material from the source just read, excerpts recalled from earlier sources, and your own prior findings.

Rules:
- Ground every claim in the provided material. If it does not support a claim, write "not stated in the sources read so far" rather than guessing.
- CITE AS YOU WRITE: end every sentence that states a fact with the marker for where that fact came from, e.g. "Farmbot raised a $22 million Series B [S2]." Use ONLY the markers listed under SOURCES YOU MAY CITE, and never write a URL yourself — each marker is replaced with the real URL after you answer, and a URL you type that was not offered to you is deleted. A fact you cannot attribute to a listed marker must not be written.
- PRIORITISE GOALS THAT PRIOR FINDINGS HAVE NOT YET ANSWERED. If a goal is already covered, do not restate it — work on an open one.
- BE SPECIFIC: prefer counts, dollar figures, dates, percentages and named entities (companies, investors, places) over general statements. A finding with no proper nouns or numbers is a weak finding.
- Answer the goal that was actually asked. If a goal names particular things (cities, sectors, categories), address those things — do not substitute a different one.
- Do not repeat a prior finding. Advance the research or name what is still missing.
- Keep the finding under 200 words.

Respond with ONLY a JSON object, no prose or code fences:
{
  "finding": "what you learned this iteration, grounded in the material, with specifics and a [S#] marker on every fact",
  "goalsAdvanced": [1],
  "progress": "which goals are now answered, which are still open",
  "newSources": ["URLs that appear in the material you were given, or []"],
  "done": false
}

"newSources" must only contain URLs that literally appear in the material shown to you. Do not construct or recall URLs from memory — invented URLs are discarded.

Set "done": true only when the material genuinely satisfies every goal.`;

/**
 * One source this iteration is allowed to cite, and the marker that stands for
 * it inside the prompt.
 */
export interface Citable {
  /** "S1", "S2"… — what the model writes. */
  marker: string;
  url: string;
  origin: 'read' | 'recalled';
}

/** A URL as it appears loose in prose. Stops at whitespace, `)` and `]`. */
const URL_IN_TEXT = /https?:\/\/[^\s)\]]+/g;

/** Trailing sentence punctuation is not part of the URL. */
const trimUrlPunctuation = (u: string): string => u.replace(/[.,;:]+$/, '');

/** Every URL that literally appears in a piece of text. */
export function urlsIn(text: string): string[] {
  return (text.match(URL_IN_TEXT) ?? []).map(trimUrlPunctuation);
}

/**
 * The sources this iteration may attribute a claim to.
 *
 * The model is given MARKERS and never URLs to copy, so a citation is an index
 * this code resolves rather than a string the model composes — the same trust
 * model as `selectNextSources`, where fabrication is impossible by construction
 * instead of forbidden by instruction (bugs.md #12, #13).
 *
 * This is the fix for #25. The missing piece was never the data: `[mem n]`
 * blocks have rendered `from <sourceUrl>` since the first run, and the model
 * still stamped recalled facts with the URL of whatever it had just read,
 * because the pipeline had exactly ONE attribution slot per finding and the
 * report was told to copy it onto every claim.
 */
export function citableSources(contributedUrl: string | null, recalled: Recalled[]): Citable[] {
  const out: Citable[] = [];
  const seen = new Set<string>();

  const add = (raw: string, origin: Citable['origin']): void => {
    const url = (raw ?? '').trim();
    if (!url) return;
    // Canonical on both sides. A canonical list compared against a verbatim
    // string is not canonicalisation — that is #14, and here it would silently
    // drop a legitimate citation rather than admit a duplicate.
    const key = normalizeUrl(url) ?? url;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ marker: `S${out.length + 1}`, url, origin });
  };

  // The source just read is [S1] whenever it contributed, so the common case is
  // the shortest marker. Null when it contributed nothing — a 403 must not
  // become citable just because the iteration claimed it (bugs.md #22).
  if (contributedUrl) add(contributedUrl, 'read');

  for (const r of recalled) {
    add(r.sourceUrl, 'recalled');
    // A recalled FINDING carries citations this function resolved in an earlier
    // iteration, and those name the documents that actually supplied its facts
    // — which is NOT the same as the source read the iteration it was written.
    // Without carrying them, restating a prior finding re-attributes it to that
    // one source and #25 propagates forward, one iteration at a time.
    if (r.type === 'finding') for (const u of urlsIn(r.text)) add(u, 'recalled');
  }

  return out;
}

/**
 * Turn the markers the model wrote into the URLs they stand for, and remove
 * anything it cited that was never offered.
 *
 * Both halves matter. The first is the feature; the second is the invariant —
 * **no URL survives in a finding unless a source in this iteration's citable
 * set supplied it** — and an invariant enforced only on the path the model was
 * told to use is not enforced (CLAUDE.md §9).
 */
export function resolveCitations(
  finding: string,
  citable: Citable[],
): { text: string; dropped: string[] } {
  const byMarker = new Map(citable.map((c) => [c.marker.toUpperCase(), c.url]));
  const dropped: string[] = [];

  // An unknown marker is a citation to a source that was never offered. It goes
  // — resolving it to the nearest thing available is how a plausible-looking
  // false citation gets written (bugs.md #13).
  const resolved = finding.replace(/\[\s*(S\d+)\s*\]/gi, (whole: string, marker: string) => {
    const url = byMarker.get(marker.toUpperCase());
    if (url) return `(${url})`;
    dropped.push(whole);
    return '';
  });

  const swept = stripUngroundedUrls(
    resolved,
    citable.map((c) => c.url),
    dropped,
  );

  return { text: tidy(swept), dropped };
}

/**
 * Remove every URL not present in `allowed`. Used on findings, and again on the
 * report — the deliverable is where #13, #22 and #25 all actually surfaced.
 */
export function stripUngroundedUrls(
  text: string,
  allowed: string[],
  dropped: string[] = [],
): string {
  const ok = new Set(allowed.map((u) => normalizeUrl(u) ?? u));
  const swept = text.replace(URL_IN_TEXT, (raw: string) => {
    const url = trimUrlPunctuation(raw);
    if (ok.has(normalizeUrl(url) ?? url)) return raw;
    dropped.push(url);
    return raw.slice(url.length); // keep the sentence's punctuation
  });
  // Removing `(url)` leaves `()` and a stranded space. Cleaned here rather than
  // by the caller, because this runs on the report too — where the finding-side
  // `tidy` would reflow markdown that is nobody's mess to clean.
  return swept.replace(/\(\s*\)/g, '').replace(/\s+([.,;:])/g, '$1');
}

/** Close up the hole a dropped citation leaves behind, in a finding. */
function tidy(s: string): string {
  return s
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

export function buildPrompt(
  topic: string,
  goals: string[],
  fresh: string[],
  recalled: Recalled[],
  priorFindings: { n: number; finding: string }[],
  currentUrl: string | null,
  citable: Citable[],
): { role: string; content: string }[] {
  const goalList = goals.map((g, i) => `${i + 1}. ${g}`).join('\n');

  const markerFor = new Map(citable.map((c) => [normalizeUrl(c.url) ?? c.url, c.marker]));
  const markerOf = (url: string): string | null =>
    (url && markerFor.get(normalizeUrl(url) ?? url)) || null;

  const readMarker = currentUrl ? markerOf(currentUrl) : null;

  const sourcesText =
    citable.length > 0
      ? citable
          .map((c) => `[${c.marker}] ${c.url} (${c.origin === 'read' ? 'just read' : 'recalled'})`)
          .join('\n')
      : '(none — this finding must not cite any URL)';

  const freshText =
    fresh.length > 0
      ? fresh.map((t, i) => `[new ${i + 1}] ${t}`).join('\n\n')
      : '(nothing new was read this iteration)';

  // Each block is labelled with the MARKER to cite, not with the URL it stands
  // for. The URL was already here on every run to date and changed nothing
  // (bugs.md #25); what was missing is telling the model what to write.
  const recalledText =
    recalled.length > 0
      ? recalled
          .map((r, i) => {
            const m = markerOf(r.sourceUrl);
            return (
              `[mem ${i + 1}] (${r.type}, relevance ${r.score.toFixed(3)}, ` +
              `cite as ${m ? `[${m}]` : 'NOT CITABLE — attribute no URL to this'})\n${r.text}`
            );
          })
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
    `SOURCES YOU MAY CITE:`,
    sourcesText,
    ``,
    `NEW MATERIAL FROM THAT SOURCE${readMarker ? ` [${readMarker}]` : ''}:`,
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
- Cite by copying a URL that already appears inline in the finding you are using, exactly as written. Every finding carries its own citations; a claim with no URL beside it gets no citation, and that is correct rather than a gap to fill. Never construct, complete or guess a URL — not even by adding "www." — and never cite a bare [n] index.
- If the findings do not answer the goal, say so in one line and state what is missing. Do not pad.

End with a short "Gaps" section listing what a follow-up run should target.

No preamble, no restating the task, no concluding pep talk. Under 800 words.`;
