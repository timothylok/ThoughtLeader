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
} from '../src/prompt.ts';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
