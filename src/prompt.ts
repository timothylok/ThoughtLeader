import type { FundingEvent, Reasoning } from './types.ts';
import type { Recalled } from './memory.ts';
import { normalizeUrl } from './ingest.ts';

const SYSTEM = `You are a research agent working through a topic across many short iterations.

You are given: the research goals, new material from the source just read, excerpts recalled from earlier sources, and your own prior findings.

Rules:
- Ground every claim in the provided material. If it does not support a claim, write "not stated in the sources read so far" rather than guessing.
- CITE AS YOU WRITE: end every sentence that states a fact with the marker for where that fact came from, e.g. "Farmbot raised a $22 million Series B [S2]." Use ONLY the markers listed under SOURCES YOU MAY CITE, and never write a URL yourself — each marker is replaced with the real URL after you answer, and a URL you type that was not offered to you is deleted. A fact you cannot attribute to a listed marker must not be written.
- PRIORITISE GOALS THAT PRIOR FINDINGS HAVE NOT YET ANSWERED. If a goal is already covered, do not restate it — work on an open one.
- BE SPECIFIC: prefer counts, dollar figures, dates, percentages and named entities (companies, investors, places) over general statements. WHEN YOU HAVE SOMETHING TO REPORT, a finding with no proper nouns or numbers is a weak finding — but see the rule on nothing new below, which outranks this one.
- Answer the goal that was actually asked. If a goal names particular things (cities, sectors, categories), address those things — do not substitute a different one.
- Do not repeat a prior finding. Advance the research or name what is still missing.
- RECORD EVERY FUNDING EVENT in the new material as one line in "events":
  "company | sector | amount | stage | investors | date | [S#]"
  Use "-" for any field the material does not state. The marker is required. One line per event.
- AN EVENT WITHOUT AN AMOUNT IS NOT RECORDABLE. If the material names a company but does not say how much it received, leave it out entirely — a roundup that lists eight companies without their amounts yields no events.
- A FUNDING EVENT IS MONEY A COMPANY HAS RECEIVED: a completed raise, round or grant. These are NOT funding events and must never be recorded:
  a valuation or a change in one; a company SEEKING or TARGETING a raise that has not closed; an IPO plan; revenue, market size or fund size; an acquisition price. If the amount would be negative, it is not a funding event.
- SECTOR is what the company DOES — travel, fintech, agtech, biotech, robotics, space, mining tech. Never write "AI" or "tech" as the sector; every company here is one of those, so it says nothing. A company's NAME is not its sector: "Sophiie AI" is a voice-assistant company, not an "AI" one.
- Events listed under ALREADY RECORDED are known. Leave them out of "events" AND out of the finding — do not mention them at all, not even to say they are already recorded. Naming them again puts them back into memory for later iterations to recall and restate.
- NOTHING NEW IS A VALID RESULT. If the material contains no unrecorded event, return "events": [] and a one-line finding saying so. Do NOT restate recalled material to fill the space — a finding that repeats what is already known is worse than a short one.
- If a BASELINE is given and the material contradicts it — a sector it does not list, an investor it does not rank, a round outside its stated range — say so in the finding, with the marker.
- Keep the finding under 200 words.

Respond with ONLY a JSON object, no prose or code fences:
{
  "finding": "what you learned this iteration, grounded in the material, with specifics and a [S#] marker on every fact",
  "events": ["Company | sector | amount | stage | investors | date | [S1]"],
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

/** Dedupe identity. Punctuation and case must not create a second row. */
const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * "$20 million" / "$20m" / "A$1.75m" -> "20000000" / "1750000".
 *
 * Scale words and currency prefixes are noise for identity; the number is not.
 */
function normAmount(raw: string | null): string {
  if (!raw) return '';
  const m = raw.replace(/,/g, '').match(/([\d.]+)\s*(b|bn|billion|m|mn|million|k|thousand)?/i);
  if (!m) return '';
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return '';
  const scale = (m[2] ?? '').toLowerCase();
  const mult = scale.startsWith('b') ? 1e9 : scale.startsWith('m') ? 1e6 : scale.startsWith('k') || scale.startsWith('t') ? 1e3 : 1;
  return String(Math.round(n * mult));
}

/**
 * `Sophiie AI` + `$5 million` -> `sophiieai|5000000`.
 *
 * Keyed on AMOUNT, not stage. Stage was the first choice and the first delta run
 * disproved it: stage was null on 2 of 4 ledger rows while amount was present on
 * 4 of 4 — it is the headline number, so it is nearly always stated. Keying on a
 * field that is usually absent collapses every stageless event of one company
 * into a single row, and lets the same round reappear under a new key the moment
 * one source happens to mention "Seed".
 */
export const eventKey = (company: string, amount: string | null): string =>
  `${normKey(company)}|${normAmount(amount)}`;

/**
 * Turn the model's event lines into ledger rows.
 *
 * Lenient by design: a line missing trailing fields still yields an event, and a
 * line yielding no company is dropped rather than stored blank. The source is
 * resolved from the line's [S#] marker against the same citable table as the
 * finding, so a ledger row can no more carry an invented URL than a citation
 * can (bugs.md #25).
 */
export function parseEvents(lines: string[], citable: Citable[]): FundingEvent[] {
  const byMarker = new Map(citable.map((c) => [c.marker.toUpperCase(), c.url]));
  const out: FundingEvent[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;

    const marker = raw.match(/\[\s*(S\d+)\s*\]/i);
    const sourceUrl = marker ? (byMarker.get(marker[1]!.toUpperCase()) ?? null) : null;

    const parts = raw
      .replace(/\[\s*S\d+\s*\]/gi, '')
      .split('|')
      .map((f) => f.trim());

    // "-", "?" and "n/a" are how the model says "not stated". Storing those
    // verbatim would make an unknown look like a value (CLAUDE.md §10).
    const field = (i: number): string | null => {
      const v = parts[i] ?? '';
      return v && !/^([-?]|n\/?a|unknown|not stated)$/i.test(v) ? v.slice(0, 200) : null;
    };

    const company = field(0);
    if (!company) continue;

    const amount = field(2);
    const key = eventKey(company, amount);
    if (seen.has(key)) continue; // the model repeated itself within one response
    seen.add(key);

    out.push({
      key,
      company,
      sector: field(1),
      amount,
      stage: field(3),
      investors: field(4),
      eventDate: field(5),
      sourceUrl,
      raw: raw.slice(0, 500),
    });
  }
  return out;
}

export function buildPrompt(
  topic: string,
  goals: string[],
  fresh: string[],
  recalled: Recalled[],
  priorFindings: { n: number; finding: string }[],
  currentUrl: string | null,
  citable: Citable[],
  context: { baseline: string | null; knownEvents: string[] },
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

  // The baseline is what divergence is measured against. Absent, the model is
  // told so plainly rather than left to invent a reference point.
  const baselineText =
    context.baseline && context.baseline.trim()
      ? context.baseline.trim()
      : '(no baseline recorded yet — record events, and skip divergence flagging)';

  const knownText =
    context.knownEvents.length > 0
      ? context.knownEvents.map((e) => `- ${e}`).join('\n')
      : '(the ledger is empty — everything you find is new)';

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
    ``,
    `BASELINE:`,
    baselineText,
    ``,
    `ALREADY RECORDED — do not report these again:`,
    knownText,
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
    // Raw lines. Parsed by `parseEvents` once the citable table is known — the
    // marker cannot be resolved here.
    events: Array.isArray(o.events)
      ? o.events.filter((e): e is string => typeof e === 'string')
      : [],
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
    // An unparsed response yields no events rather than guessed ones. A ledger
    // is only useful if every row came from a line the model actually emitted.
    events: [],
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

export const REPORT_SYSTEM = `You are writing the daily delta report for a loop that tracks change against a baseline.

The report's "## New events" section is generated for you from the event ledger and is NOT your job — do not write one, do not repeat it, and do not list any funding event. Write only the sections below.

## Divergence from baseline
Only what the findings explicitly say contradicts the baseline. If the findings say nothing of the kind, write "None."

## Notes
At most three lines for anything else a human should see. Funding events are NOT "anything else" — they are handled above, so never mention one here, however notable. Omit the section entirely if there is nothing.

Rules:
- Build ONLY from the findings supplied. Add no context, background or interpretation of your own.
- Cite by copying a URL that already appears inline in the finding you are using, exactly as written. Every finding carries its own citations; a claim with no URL beside it gets no citation, and that is correct rather than a gap to fill. Never construct, complete or guess a URL — not even by adding "www." — and never cite a bare [n] index.
- "None today." is a complete and correct report. A quiet day is a result, not a failure, and padding it with recalled background is the failure.
- No preamble, no restating the task, no concluding pep talk. Under 500 words.`;
