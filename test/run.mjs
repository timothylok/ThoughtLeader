/**
 * Pure-function tests for the citation and event-ledger machinery.
 *
 *   npm test
 *
 * No framework and no build: `node --experimental-strip-types` imports the
 * TypeScript directly. These cover the parts of bugs.md #25 and the event
 * ledger that can be checked without spending neurons — the model-facing
 * behaviour still needs a live /step, and always will.
 */
import {
  citableSources,
  resolveCitations,
  stripUngroundedUrls,
  urlsIn,
  parseEvents,
  eventKey,
  dropSection,
  buildPrompt,
  parseAmount,
  parseB3Bands,
  checkRoundSizes,
  renderB3Section,
  B3_HEADING,
  leakedCompanies,
  REPORT_SYSTEM,
} from '../src/prompt.ts';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) console.log(`       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`);
};

const SD = 'https://startupdaily.net/feed';
const TC = 'https://techcouncil.com.au/feed';
const WIKI = 'https://en.wikipedia.org/w/index.php?title=Australia&action=raw';

// ---------------------------------------------------------------- citations
const recalled = [
  { text: 'The tech sector contributes $248.5 billion.', score: 0.9, sourceUrl: TC, type: 'chunk' },
  { text: 'Farmbot raised $22m.', score: 0.8, sourceUrl: SD, type: 'chunk' },
  { text: 'dupe of the same feed', score: 0.7, sourceUrl: TC, type: 'chunk' },
];

eq('table: read source is S1, recalled follow, duplicates collapse',
  citableSources(WIKI, recalled).map((c) => `${c.marker}=${c.url}`),
  [`S1=${WIKI}`, `S2=${TC}`, `S3=${SD}`]);
eq('table: a fetch that contributed nothing is not citable',
  citableSources(null, recalled).map((c) => `${c.marker}=${c.url}`), [`S1=${TC}`, `S2=${SD}`]);
eq('table: empty sourceUrl (synthesised finding) is skipped',
  citableSources(null, [{ text: 'x', score: 0.5, sourceUrl: '', type: 'finding' }]), []);
eq('table: canonical dedupe — www/trailing slash is the same document',
  citableSources('https://www.techcouncil.com.au/feed/', [
    { text: 'x', score: 0.5, sourceUrl: TC, type: 'chunk' }]).length, 1);
eq('table: a recalled finding contributes the URLs it already cites',
  citableSources(WIKI, [{ text: `Tech is $248.5bn (${TC}) and Farmbot raised $22m (${SD}).`,
    score: 0.9, sourceUrl: WIKI, type: 'finding' }]).map((c) => c.url), [WIKI, TC, SD]);

const citable = citableSources(WIKI, recalled);
const r1 = resolveCitations(
  'Not stated in the source just read [S1]. The tech sector contributes $248.5 billion, 8.9% of GDP [S2].', citable);
eq('resolve: bug #25 — the $248.5bn claim lands on the Tech Council, not Wikipedia', r1.text,
  `Not stated in the source just read (${WIKI}). The tech sector contributes $248.5 billion, 8.9% of GDP (${TC}).`);
eq('resolve: nothing dropped when every marker was offered', r1.dropped, []);

const r2 = resolveCitations('Sydney leads AI investment [S9].', citable);
eq('resolve: a marker that was never offered is removed', r2.text, 'Sydney leads AI investment.');
eq('resolve: ...and reported', r2.dropped, ['[S9]']);

const r3 = resolveCitations(
  'Alloy raised $11.5m (https://australianstartup.org/invented) and Farmbot $22m (https://startupdaily.net/feed).', citable);
eq('resolve: a hand-written URL that was never offered is stripped', r3.text,
  `Alloy raised $11.5m and Farmbot $22m (${SD}).`);
eq('resolve: ...and reported', r3.dropped, ['https://australianstartup.org/invented']);
eq('resolve: markers are case-insensitive and tolerate spacing',
  resolveCitations('Fact [ s2 ].', citable).text, `Fact (${TC}).`);
eq('resolve: no citable sources means no URL can survive',
  resolveCitations(`Fact [S1] and ${TC} too.`, []).text, 'Fact and too.');

const body = `[1] Farmbot raised $22m (${SD}).\n\n[2] Tech is $248.5bn (${TC}).`;
eq('report sweep: keeps what a finding carried, drops what it did not',
  stripUngroundedUrls(`**Partial** Farmbot raised $22m (${SD}) and Sydney leads (https://www.austrade.gov.au/ai).`,
    urlsIn(body)), `**Partial** Farmbot raised $22m (${SD}) and Sydney leads.`);
eq('report sweep: trailing punctuation is not part of the URL',
  urlsIn(`see ${SD}, and ${TC}.`), [SD, TC]);

// ------------------------------------------------------------- event ledger
const ec = citableSources(SD, [{ text: 'x', score: 0.9, sourceUrl: TC, type: 'chunk' }]); // S1=SD, S2=TC

eq('events: full line parses every field',
  parseEvents(['Sophiie AI | construction | $5m | Seed | Blackbird | 2026-08-17 | [S1]'], ec)[0], {
    key: 'sophiieai|5000000', company: 'Sophiie AI', sector: 'construction', amount: '$5m',
    stage: 'Seed', investors: 'Blackbird', eventDate: '2026-08-17', sourceUrl: SD,
    raw: 'Sophiie AI | construction | $5m | Seed | Blackbird | 2026-08-17 | [S1]' });
eq('events: the marker picks the source, not the position',
  parseEvents(['Farmbot | agtech | $22m | Series B | - | - | [S2]'], ec)[0].sourceUrl, TC);
eq('events: a marker never offered yields no source rather than a guess',
  parseEvents(['Ghost Co | ai | $1m | Seed | - | - | [S9]'], ec)[0].sourceUrl, null);
eq('events: "-", "n/a" and "unknown" become null, not the literal string',
  parseEvents(['Alloy | - | $11.5m | n/a | unknown | - | [S1]'], ec)[0].sector, null);
eq('events: a short line still yields an event',
  parseEvents(['Visaible.ai | travel | $1m'], ec)[0].key, 'visaibleai|1000000');
eq('events: a line with no company is dropped', parseEvents(['  |  | $5m | Seed'], ec), []);
eq('events: non-strings and blanks are dropped', parseEvents(['', '   ', 42, null], ec), []);
eq('events: the model repeating itself in one response inserts once',
  parseEvents(['Sophiie AI | construction | $5m | Seed | Blackbird | 2026-08-17 | [S1]',
               'Sophiie AI | proptech | $5 million | seed | - | - | [S1]'], ec).length, 1);

// Keyed on AMOUNT, the field the first delta run showed is always present (4/4)
// where stage was not (2/4).
eq('key: punctuation and case do not create a second row',
  eventKey('Sophiie AI', '$5 million'), eventKey('sophiie-ai!', '$5m'));
eq('key: scale words normalise — million / m / mn',
  [eventKey('X', '$20 million'), eventKey('X', '$20m'), eventKey('X', '20mn')].join(' '),
  'x|20000000 x|20000000 x|20000000');
eq('key: billions and decimals', eventKey('Firmus', '$2.85 billion'), 'firmus|2850000000');
eq('key: a currency prefix is not part of the identity',
  eventKey('Vexev', 'US$8.6 million'), eventKey('Vexev', '$8.6m'));
eq('key: commas do not change the number', eventKey('X', '$1,750,000'), 'x|1750000');
eq('key: a DIFFERENT amount is a different event (Series A then B)',
  eventKey('Farmbot', '$5m') === eventKey('Farmbot', '$22m'), false);
eq('key: THE DEFECT THIS REPLACES — stage present one day, absent the next, same round',
  eventKey('Visaible.ai', '$1 million'), eventKey('Visaible.ai', '$1m'));
eq('key: a missing amount still keys on the company', eventKey('Farmbot', null), 'farmbot|');

// ------------------------------------------------- report section ownership
const rpt = [
  '## Divergence from baseline',
  'A sector the baseline does not list took a round.',
  '',
  '## Notes',
  'Feed was quiet.',
].join('\n');
eq('report: a section the code owns is removed whatever the model emitted',
  dropSection(rpt, 'Divergence from baseline'), ['## Notes', 'Feed was quiet.'].join('\n'));
eq('report: heading match is case-insensitive and tolerates trailing space',
  dropSection(['## divergence from baseline ', 'x', '', '## Notes', 'y'].join('\n'),
    'Divergence from baseline'), ['## Notes', 'y'].join('\n'));
eq('report: a report without that section is unchanged',
  dropSection(['## Notes', 'y'].join('\n'), 'Divergence from baseline'),
  ['## Notes', 'y'].join('\n'));
eq('report: dropping the only section leaves nothing, not a stray heading',
  dropSection(['## Divergence from baseline', 'None.'].join('\n'),
    'Divergence from baseline'), '');

// ------------------------------------------------------ baseline reaches prompt
// CLAUDE.md §12: read the effective setting from inside the code path that uses
// it, not from the launcher. `POST /baseline` reporting ok is the launcher.
const userMsg = (baseline) =>
  buildPrompt('AU funding', ['Record events'], ['fresh text'], [], [], SD,
    citableSources(SD, []), { baseline, knownEvents: [] })[1].content;

const withBase = userMsg('Seed median $4.0M. Flag below $1.3M or above $12.0M.');
eq('baseline: the text is rendered into the user message',
  withBase.includes('Flag below $1.3M or above $12.0M.'), true);
eq('baseline: under its own heading',
  /BASELINE:\n[\s\S]*Seed median/.test(withBase), true);
eq('baseline: empty means the model is told to SKIP divergence, not to find none',
  userMsg('').includes('skip divergence flagging'), true);
eq('baseline: whitespace-only is treated as absent',
  userMsg('   \n  ').includes('skip divergence flagging'), true);
eq('baseline: null is treated as absent',
  userMsg(null).includes('skip divergence flagging'), true);

// ---------------------------------------------------------------------------
// B3 — round size against the baseline's flag table (bugs.md #36).
//
// Read from the REAL baseline document, not a fixture: the bounds are
// CONSTRUCTED and get recomputed on every baseline refresh, so these tests are
// also the guard that a refresh has not broken the table the code parses.
// ---------------------------------------------------------------------------
const BASELINE = readFileSync(
  new URL('../baseline/AU-AI-FUNDING-2026H1.md', import.meta.url),
  'utf-8',
);
const BANDS = parseB3Bands(BASELINE);
const seedBand = BANDS.find((b) => b.stage.toLowerCase() === 'seed');
const statuses = (rows) => checkRoundSizes(rows, BANDS).map((v) => v.status);

eq('b3: the live baseline yields four bands', BANDS.length, 4);
eq('b3: it reads the FLAG table, not the median table above it',
  [seedBand.below, seedBand.above], [1300000, 12000000]);
eq('b3: the bounds keep the baseline own text, so nothing is reformatted',
  [seedBand.belowRaw, seedBand.aboveRaw], ['$1.3M', '$12.0M']);
eq('b3: no baseline yields no bands', parseB3Bands(null).length, 0);
eq('b3: a baseline without the table yields no bands',
  parseB3Bands('## B3\n| stage | CY2025 |\n|---|---|\n| Seed | $2.5M |').length, 0);

// The two verdicts run ab39eff8 got wrong, as the ledger actually holds them.
eq('b3: THE MISS — $20m Seed is ABOVE the $12.0M flag, not "within range"',
  statuses([{ company: 'Nybro', amount: '$20 million', stage: 'Seed' }]), ['above']);
eq('b3: THE ASSUMPTION — a stageless round is not checked, not treated as Seed',
  statuses([{ company: 'Seitec', amount: '$4 million', stage: null }]), ['no-stage']);

eq('b3: a genuinely in-range Seed is within',
  statuses([{ company: 'Sophiie AI', amount: '$5 million', stage: 'Seed' }]), ['within']);
eq('b3: under the floor is flagged too',
  statuses([{ company: 'X', amount: '$0.9m', stage: 'Seed' }]), ['below']);
eq('b3: the bounds are exclusive — exactly on the flag is within',
  statuses([{ company: 'X', amount: '$12m', stage: 'Seed' }]), ['within']);
eq('b3: pre-seed does NOT fall through to the Seed band',
  checkRoundSizes([{ company: 'X', amount: '$2 million', stage: 'Pre-Seed' }], BANDS)[0].band.stage,
  'Angel / Pre-Seed');
eq('b3: $5m Pre-Seed is ABOVE its own $3.9M flag though inside Seed range',
  statuses([{ company: 'X', amount: '$5 million', stage: 'Pre-Seed' }]), ['above']);
eq('b3: Series C maps onto Series B+',
  checkRoundSizes([{ company: 'X', amount: '$50m', stage: 'Series C' }], BANDS)[0].band.stage,
  'Series B+');
eq('b3: an unparseable amount is not checked, not zero',
  statuses([{ company: 'X', amount: 'an undisclosed sum', stage: 'Seed' }]), ['no-amount']);
eq('b3: a stage that is no B3 row is not checked',
  statuses([{ company: 'X', amount: '$3m', stage: 'Growth' }]), ['unmapped-stage']);

eq('b3: an unreadable table prints NOT CHECKED, never an empty clean list',
  renderB3Section([], [], true).includes('NOT CHECKED'), true);
eq('b3: no baseline prints "not measured", not "none"',
  renderB3Section([], [], false).includes('Not measured'), true);
eq('b3: no events to check is not the same sentence as nothing breached',
  renderB3Section([], BANDS, true).includes('No new events to check'), true);
eq('b3: the breach line quotes the baseline own bound',
  renderB3Section(
    checkRoundSizes([{ company: 'Nybro', amount: '$20 million', stage: 'Seed' }], BANDS),
    BANDS, true).includes('ABOVE** the $12.0M flag for Seed'), true);
eq('b3: a model-written B3 section is removed whatever it said',
  dropSection('## ' + B3_HEADING + '\nAll rounds look fine.\n\n## Notes\nkept', B3_HEADING),
  '## Notes\nkept');

eq('amount: the ledger key and the B3 check parse identically',
  [parseAmount('$20 million'), parseAmount('A$1.75m'), parseAmount('$123M'), parseAmount(null)],
  [20000000, 1750000, 123000000, null]);
eq('amount: an unparseable amount is null, NOT 0 (CLAUDE.md §10)',
  parseAmount('an undisclosed sum'), null);

// ---------------------------------------------------------------------------
// #37 — the deliverable must never name an already-recorded event.
//
// Two halves: the Notes section is gone structurally, and the finding-level
// leak is COUNTED rather than corrected, because the rate has never been a
// number and a fix cannot be designed from three anecdotes.
// ---------------------------------------------------------------------------
const LEDGER = ['Nybro', 'Sophiie AI', 'Space Angel', 'Visaible.ai', 'Seitec'];

// The real sentence from iteration 1 of run ab39eff8, trimmed.
const REAL_LEAK =
  'Seitec, a defence tech startup, has raised $4 million, and Nybro, a biotech ' +
  'company, has doubled its Seed round to $20 million, but the baseline already ' +
  'recorded Nybro so only Seitec is new.';

eq('leak: the real ab39eff8 finding is caught, both companies named',
  leakedCompanies(REAL_LEAK, LEDGER), ['Nybro', 'Seitec']);
eq('leak: a company never mentioned is not reported',
  leakedCompanies('Nothing new in this feed today.', LEDGER), []);
eq('leak: a possessive still counts',
  leakedCompanies("Nybro's round was already recorded.", LEDGER), ['Nybro']);
eq('leak: matching is case-insensitive',
  leakedCompanies('nybro raised again', LEDGER), ['Nybro']);
eq('leak: a multi-word name survives odd whitespace',
  leakedCompanies('Space   Angel took a grant.', LEDGER), ['Space Angel']);
eq('leak: WORD BOUNDARY — "any brochure" does not contain Nybro',
  leakedCompanies('We read any brochure we could find.', LEDGER), []);
eq('leak: a dot in a name is literal, not a regex wildcard',
  leakedCompanies('VisaibleXai is a different company.', LEDGER), []);
eq('leak: the same company twice is reported once',
  leakedCompanies('Nybro and Nybro again.', LEDGER), ['Nybro']);
eq('leak: a two-letter name is skipped — "AI" would match every finding',
  leakedCompanies('An AI company raised money.', ['AI', 'Nybro']), []);
eq('leak: an empty finding leaks nothing',
  leakedCompanies('', LEDGER), []);

eq('notes: the report prompt no longer asks for a Notes section',
  REPORT_SYSTEM.includes('## Notes'), false);
eq('notes: and it says explicitly to write nothing after',
  REPORT_SYSTEM.includes('Write NOTHING after the section above'), true);
eq('notes: a Notes section the model writes anyway is removed',
  dropSection('## Divergence from baseline\nNone.\n\n## Notes\nNybro raised $20m.', 'Notes'),
  '## Divergence from baseline\nNone.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
