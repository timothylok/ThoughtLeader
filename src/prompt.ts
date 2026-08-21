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
  "company | sector | amount | stage | investors | date | country | [S#]"
  Use "-" for any field the material does not state. The marker is required. One line per event.
- COUNTRY is where the company is based, as the material states it: "Australia", "New Zealand", "United States". Read it from the text — a "Kiwi" startup, or one based in Auckland or Wellington, is New Zealand and not Australia; Sydney, Melbourne, Brisbane, Perth and Canberra are Australia. If the material does not say and you cannot tell from it, write "-". An absence is handled; a guess is not, because each country is bucketed and compared separately and the wrong bucket is a false comparison.
- AN EVENT WITHOUT AN AMOUNT IS NOT RECORDABLE. If the material names a company but does not say how much it received, leave it out entirely — a roundup that lists eight companies without their amounts yields no events.
- A FUNDING EVENT IS MONEY A COMPANY HAS RECEIVED: a completed raise, round or grant. These are NOT funding events and must never be recorded:
  a valuation or a change in one; a company SEEKING or TARGETING a raise that has not closed; an IPO plan; revenue, market size or fund size; an acquisition price. If the amount would be negative, it is not a funding event.
- SECTOR is what the company DOES — travel, fintech, agtech, biotech, robotics, space, mining tech. Never write "AI" or "tech" as the sector; every company here is one of those, so it says nothing. A company's NAME is not its sector: "Sophiie AI" is a voice-assistant company, not an "AI" one.
- Events listed under ALREADY RECORDED are known. Leave them out of "events" AND out of the finding — do not mention them at all, not even to say they are already recorded. Naming them again puts them back into memory for later iterations to recall and restate.
- NOTHING NEW IS A VALID RESULT. If the material contains no unrecorded event, return "events": [] and a one-line finding saying so. Do NOT restate recalled material to fill the space — a finding that repeats what is already known is worse than a short one.
- If a BASELINE is given and the material contradicts it, say so in the finding, with the marker — but ONLY about SECTOR, and only where the company's sector maps onto NO row of the baseline's taxonomy. A sector that maps onto a row under a different name is not a divergence.
- THE BASELINE COVERS ONE COUNTRY, and it says which. A company based anywhere else is not measured against it — not its sector, not its round size, not its investors. There is no baseline for that country, which is not the same as that company being unremarkable. Record it; say nothing about how it compares.
- NEVER judge round size against the baseline: code does that from the baseline's own table, and a round with no stage stated cannot be judged at all. NEVER flag an investor: the baseline ranks none, so an unfamiliar investor is evidence of nothing.
- Keep the finding under 200 words.

Respond with ONLY a JSON object, no prose or code fences:
{
  "finding": "what you learned this iteration, grounded in the material, with specifics and a [S#] marker on every fact",
  "events": ["Company | sector | amount | stage | investors | date | country | [S1]"],
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
export function parseAmount(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, '').match(/([\d.]+)\s*(b|bn|billion|m|mn|million|k|thousand)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const scale = (m[2] ?? '').toLowerCase();
  const mult = scale.startsWith('b') ? 1e9 : scale.startsWith('m') ? 1e6 : scale.startsWith('k') || scale.startsWith('t') ? 1e3 : 1;
  return Math.round(n * mult);
}

/**
 * The dedupe key's half of the same parse. The B3 check and the ledger key MUST
 * read an amount identically — canonicalisation applied to one side of a
 * comparison is not canonicalisation (CLAUDE.md §9, bugs.md #14).
 */
function normAmount(raw: string | null): string {
  const v = parseAmount(raw);
  return v === null ? '' : String(v);
}

/**
 * Remove a `## Heading` section and everything under it, up to the next `##`.
 *
 * Used where the CODE owns a section and the model must not also emit one. The
 * model is told to omit it, but instruction alone has already failed on this
 * exact surface three times (bugs.md #25, #28) — so the guarantee is structural
 * and the instruction is only a hint.
 */
export function dropSection(text: string, heading: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const isHeading = /^\s*##\s+/.test(line);
    if (isHeading) skipping = line.trim().toLowerCase() === `## ${heading}`.toLowerCase();
    if (!skipping) out.push(line);
  }
  return out.join('\n').trim();
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

/** An event whose country the material never stated. NOT a country. */
export const UNKNOWN_COUNTRY = 'unknown';

/**
 * Canonical bucket for an event's country.
 *
 * Both sides of the baseline-scope test run through here — the ledger row's
 * country and the country the baseline declares it covers — because
 * canonicalisation applied to one side of a comparison is not canonicalisation
 * (CLAUDE.md §9, bugs.md #14).
 *
 * An absent or unreadable country becomes UNKNOWN_COUNTRY and never AU. "I
 * could not tell" and "Australian" must not collapse onto one value: that is
 * how a New Zealand round came to be reported as within the Australian Series A
 * range (bugs.md #39), and it is §10 in a column.
 *
 * Anything else is kept verbatim as its own bucket. The ledger records what the
 * source said rather than a shortlist's idea of what counts.
 */
export function normCountry(raw: string | null): string {
  const s = normKey(raw ?? '');
  if (!s) return UNKNOWN_COUNTRY;
  if (['au', 'aus', 'australia', 'australian'].includes(s)) return 'AU';
  if (['nz', 'newzealand', 'aotearoa', 'kiwi'].includes(s)) return 'NZ';
  if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica', 'america'].includes(s)) return 'US';
  return (raw ?? '').trim().slice(0, 40);
}

const COUNTRY_LABEL: Record<string, string> = {
  AU: 'Australia',
  NZ: 'New Zealand',
  US: 'United States',
  [UNKNOWN_COUNTRY]: 'Country not stated',
};

export const countryLabel = (code: string): string => COUNTRY_LABEL[code] ?? code;

/**
 * The country the baseline DECLARES it covers, read out of the document.
 *
 * Parsed, not copied, for the same reason the B3 bounds are (CLAUDE.md §14):
 * the day someone loads a different baseline, a constant in code would go on
 * asserting AU over it. A baseline with no declaration returns null, and the
 * B3 section then checks nothing and says so — a table whose scope is unknown
 * cannot clear a round.
 */
export function parseBaselineCountry(baseline: string | null): string | null {
  if (!baseline) return null;
  const m = baseline.match(/\*\*Country coverage:\s*([A-Za-z ]+?)\s*\.?\*\*/);
  return m ? normCountry(m[1]!) : null;
}

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
      // Appended, not inserted: a line written to the old six-field format still
      // parses, and yields UNKNOWN_COUNTRY rather than shifting every field.
      country: normCountry(field(6)),
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

The "## Round size vs baseline (B3)" section is ALSO generated for you, by code, from the baseline's own flag table. Never state whether a round is inside or outside a baseline range, never name a stage the material did not state, and never write that section. Round size is answered; your divergence section is for SECTORS and nothing else.

## Divergence from baseline
Only what the findings explicitly say contradicts the baseline. If the findings say nothing of the kind, write "None."

The baseline covers ONE country and the "## New events" section groups the day's events by country. A company outside the baseline's country diverges from nothing: there is no baseline for it. Do not flag it, and do not remark that it could not be compared — the code says that where it belongs.

Write NOTHING after the section above — no notes, no summary, no context, no closing line. Every report that has had such a section used it to restate an event the ledger already recorded, once directly contradicting its own "None today." (bugs.md #37). If the section above is empty, a one-line report is the correct report.

Rules:
- Build ONLY from the findings supplied. Add no context, background or interpretation of your own.
- Cite by copying a URL that already appears inline in the finding you are using, exactly as written. Every finding carries its own citations; a claim with no URL beside it gets no citation, and that is correct rather than a gap to fill. Never construct, complete or guess a URL — not even by adding "www." — and never cite a bare [n] index.
- "None today." is a complete and correct report. A quiet day is a result, not a failure, and padding it with recalled background is the failure.
- No preamble, no restating the task, no concluding pep talk. Under 500 words.`;

/**
 * Appended to REPORT_SYSTEM when `control.baseline` is empty.
 *
 * "No divergence found" and "divergence was never measured" printed as the same
 * word — "None." — for every run to date, because the baseline has been empty
 * since the ledger shipped and nothing in the report said so. That is CLAUDE.md
 * §10 on the deliverable rather than in the spend guard: a default that turns
 * "not measured" into "clean" will never raise an alarm.
 */
export const NO_BASELINE_RULE = `

There is no baseline recorded. OMIT the "## Divergence from baseline" section entirely — it is written for you.`;

// ---------------------------------------------------------------------------
// B3 — round size against the baseline's flag table.
//
// Run ab39eff8 got this wrong in both directions in one report (bugs.md #36):
// it called a $20M Seed "within the expected range" when B3 flags Seed above
// $12.0M, and it checked a stageless round as a Seed when B3 says in words that
// an unstaged round cannot be checked. Both are arithmetic against a fixed
// table, and arithmetic delegated to prose is the same category error #28 fixed
// for the New events list. The model is handed the answer.
// ---------------------------------------------------------------------------

export interface B3Band {
  stage: string;
  below: number;
  above: number;
  /** The baseline's own text, so the report never reformats a bound. */
  belowRaw: string;
  aboveRaw: string;
}

/**
 * Read the "flag below / flag above" table out of the baseline document.
 *
 * Parsed, not copied. The bounds are CONSTRUCTED — the baseline states them as
 * ⅓× to 3× the Q2 median — so they are recomputed whenever the baseline is
 * refreshed, and a second copy in code would drift silently against the
 * document every reader is told is authoritative.
 *
 * Anchored on the header cells, because B3 has a SECOND table directly above
 * this one (the medians themselves) with the same column count.
 */
export function parseB3Bands(baseline: string | null): B3Band[] {
  if (!baseline) return [];
  const lines = baseline.split('\n');
  const start = lines.findIndex(
    (l) => /^\s*\|/.test(l) && /flag\s+below/i.test(l) && /flag\s+above/i.test(l),
  );
  if (start < 0) return [];

  const out: B3Band[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s*\|/.test(line)) break; // the table ended
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^[-: ]+$/.test(cells[0]!)) continue; // |---|---|---|
    const below = parseAmount(cells[1]!);
    const above = parseAmount(cells[2]!);
    if (below === null || above === null) continue;
    out.push({ stage: cells[0]!, below, above, belowRaw: cells[1]!, aboveRaw: cells[2]! });
  }
  return out;
}

/** `Angel / Pre-Seed` -> ['angel', 'preseed']; `Series B+` -> ['seriesb']. */
const stageAlts = (label: string): string[] =>
  label.split('/').map((p) => normKey(p.replace(/\+/g, ''))).filter(Boolean);

/**
 * Map a free-text stage onto a band, or null if it maps onto none.
 *
 * Longest alternative wins: `preseed` contains `seed`, so a Pre-Seed round
 * would otherwise be checked against the Seed bounds.
 */
function bandFor(stage: string, bands: B3Band[]): B3Band | null {
  const s = normKey(stage);
  if (!s) return null;

  let best: { band: B3Band; len: number } | null = null;
  for (const band of bands) {
    for (const alt of stageAlts(band.stage)) {
      if (s.includes(alt) && (!best || alt.length > best.len)) best = { band, len: alt.length };
    }
  }
  if (best) return best.band;

  // "Series B+" means B and every letter after it — the only band whose label
  // stands for more stages than it names.
  const letter = s.match(/^series([a-z])$/);
  if (letter) {
    for (const band of bands) {
      const b = band.stage.trim().match(/^series\s*([a-z])\s*\+$/i);
      if (b && letter[1]! >= b[1]!.toLowerCase()) return band;
    }
  }
  return null;
}

export type B3Status =
  | 'above'
  | 'below'
  | 'within'
  | 'no-amount'
  | 'no-stage'
  | 'unmapped-stage'
  | 'other-country';

export interface B3Verdict {
  company: string;
  amount: string | null;
  stage: string | null;
  country: string;
  status: B3Status;
  band: B3Band | null;
}

/** One verdict per event. Nothing is skipped — "not checkable" is a result. */
export function checkRoundSizes(
  events: { company: string; amount: string | null; stage: string | null; country: string }[],
  bands: B3Band[],
  baselineCountry: string | null,
): B3Verdict[] {
  return events.map((e) => {
    const base = { company: e.company, amount: e.amount, stage: e.stage, country: e.country };
    // The OUTERMOST gate, before amount or stage. B3's bounds are one country's
    // medians, so a round raised outside it is not checkable against them at
    // all — and "not checkable" must never render as "within range", which is
    // how a New Zealand Series A was cleared against the Australian band
    // (bugs.md #39). #36 closed this same hole along the stage dimension; a fix
    // verified against the path that failed misses the path that has not
    // (CLAUDE.md §9).
    //
    // UNKNOWN_COUNTRY lands here too, and that is the safe direction: an
    // unclassified row is not silently treated as domestic.
    if (baselineCountry === null || e.country !== baselineCountry) {
      return { ...base, status: 'other-country' as const, band: null };
    }
    const value = parseAmount(e.amount);
    if (value === null) return { ...base, status: 'no-amount' as const, band: null };
    // B3, verbatim: "A round with no stage stated cannot be checked against
    // this table. Say the stage was absent rather than assuming one."
    if (!e.stage) return { ...base, status: 'no-stage' as const, band: null };
    const band = bandFor(e.stage, bands);
    if (!band) return { ...base, status: 'unmapped-stage' as const, band: null };
    const status: B3Status = value > band.above ? 'above' : value < band.below ? 'below' : 'within';
    return { ...base, status, band };
  });
}

export const B3_HEADING = 'Round size vs baseline (B3)';

export const EVENTS_HEADING = 'New events';

/**
 * The ledger's own section, bucketed by country.
 *
 * Built from the LEDGER and not from the findings' prose, for the reason #28
 * gives: only the UNIQUE(key) insert knows what was actually novel. The buckets
 * are here rather than in the workflow so they are testable without spending
 * neurons — and because the bucket a row prints under and the bucket B3 checks
 * it in must be decided by the same value (CLAUDE.md §9).
 *
 * The label prints even when there is only one bucket. Country was invisible in
 * this report for its whole life, which is how a New Zealand round sat in an
 * Australian ledger being compared against Australian bands (bugs.md #39); a
 * heading that appears only when something is unusual is a heading nobody reads
 * when it does.
 */
export function renderEventSection(
  events: {
    company: string;
    sector: string | null;
    amount: string | null;
    stage: string | null;
    investors: string | null;
    event_date: string | null;
    source_url: string | null;
    country: string | null;
  }[],
  baselineCountry: string | null,
): string {
  const head = `## ${EVENTS_HEADING}`;
  if (events.length === 0) return `${head}\nNone today.`;

  const buckets = new Map<string, typeof events>();
  for (const e of events) {
    const c = e.country || UNKNOWN_COUNTRY;
    const rows = buckets.get(c);
    if (rows) rows.push(e);
    else buckets.set(c, [e]);
  }

  // The baseline's own country first — it is the one with something to compare
  // against — then the rest by name, with the unclassified last.
  const rank = (c: string): number =>
    c === baselineCountry ? 0 : c === UNKNOWN_COUNTRY ? 2 : 1;
  const order = [...buckets.keys()].sort(
    (a, b) => rank(a) - rank(b) || countryLabel(a).localeCompare(countryLabel(b)),
  );

  const line = (e: (typeof events)[number]): string =>
    `* ${e.company} — ` +
    [e.sector, e.amount, e.stage, e.investors, e.event_date].filter(Boolean).join(', ') +
    (e.source_url ? ` ${e.source_url}` : '');

  const body = order
    .map((c) => `**${countryLabel(c)}**\n${buckets.get(c)!.map(line).join('\n')}`)
    .join('\n\n');
  return `${head}\n${body}`;
}

/**
 * Companies the finding names that the prompt had already listed as recorded.
 *
 * Not a filter — a MEASUREMENT. The prompt says of the ALREADY RECORDED list:
 * "do not mention them at all, not even to say they are already recorded",
 * because restating one puts it back into this run's memory for later
 * iterations to recall and re-report. Whether that rule holds has never been a
 * number, and the fix for a rule that does not hold cannot be designed from
 * three anecdotes (CLAUDE.md §12). So the violation is counted, not corrected:
 * the finding is the run's work product and an offending sentence can carry a
 * genuinely new event alongside the leaked one, as iteration 1 of ab39eff8 did.
 *
 * Matched on a word boundary in the ORIGINAL text, never on a squashed key:
 * `normKey` would find "nybro" inside "a\ny bro''chure".
 */
export function leakedCompanies(finding: string, known: string[]): string[] {
  if (!finding) return [];
  const out: string[] = [];
  for (const company of known) {
    const tokens = company.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    // Two characters is a word, not a name; "AI" would match every finding.
    if (company.replace(/[^A-Za-z0-9]/g, '').length < 3) continue;
    const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    if (new RegExp('\\b' + pattern, 'i').test(finding) && !out.includes(company)) {
      out.push(company);
    }
  }
  return out;
}

/**
 * Render the section the CODE owns.
 *
 * An unreadable table prints NOT CHECKED, never an empty list: "nothing
 * breached" and "nothing was compared" are different results and printing them
 * the same is exactly bug #30 (CLAUDE.md §10).
 */
export function renderB3Section(
  verdicts: B3Verdict[],
  bands: B3Band[],
  hasBaseline: boolean,
  baselineCountry: string | null,
): string {
  const head = `## ${B3_HEADING}`;
  if (!hasBaseline) return `${head}\nNot measured — no baseline recorded.`;
  if (bands.length === 0) {
    return `${head}\nNOT CHECKED — the baseline has no readable "flag below / flag above" table.`;
  }
  if (!baselineCountry) {
    return `${head}\nNOT CHECKED — the baseline does not declare which country it covers.`;
  }
  if (verdicts.length === 0) return `${head}\nNo new events to check.`;

  const line = (v: B3Verdict): string => {
    const who = `* ${v.company} — ${v.amount ?? 'amount not stated'}`;
    switch (v.status) {
      case 'above':
        return `${who} (${v.stage}): **ABOVE** the ${v.band!.aboveRaw} flag for ${v.band!.stage}.`;
      case 'below':
        return `${who} (${v.stage}): **BELOW** the ${v.band!.belowRaw} flag for ${v.band!.stage}.`;
      case 'within':
        return `${who} (${v.stage}): within ${v.band!.belowRaw}–${v.band!.aboveRaw} for ${v.band!.stage}.`;
      case 'no-stage':
        return `${who}: stage not stated, so not checked.`;
      case 'unmapped-stage':
        return `${who}: stage "${v.stage}" is not a B3 row, so not checked.`;
      case 'no-amount':
        return `${who}: not checked.`;
      case 'other-country':
        return (
          `${who} (${countryLabel(v.country)}): NOT MEASURED — ` +
          `the baseline covers ${countryLabel(baselineCountry)} only.`
        );
    }
  };
  return `${head}\n${verdicts.map(line).join('\n')}`;
}
