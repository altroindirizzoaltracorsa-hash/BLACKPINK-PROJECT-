// A video with a mark must also be a video we RECORD.
//
// Run: node .github/scripts/test_youtube_marks.mjs
//
// Three lists decide whether a 24h or 7-day figure gets frozen, and they are
// in two files:
//   vs.html   ROWS/VIDEOS   — what the page draws
//   api/youtube-history.js
//             RELEASE / EXTRA_MARKS — which instants get pinned
//             DEFAULT_IDS           — what ?snapshot=1 actually records
//
// Tarantino was in the first two and not the third. The page drew it, a mark
// existed for it, and nothing was writing points — so at the mark there was no
// stored reading within the 95-minute tolerance and the pin was simply never
// taken. Nothing failed: the capture job ran, slept to the instant, sampled,
// and exited green. The figure is just gone.
//
// So: anything with a mark must be recorded, and anything on the page should
// be too. Parsed out of the sources rather than imported, because both files
// are browser/serverless modules that will not load standalone here.
import { readFile } from 'node:fs/promises';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const api = await readFile(ROOT + '/api/youtube-history.js', 'utf8');
const vs  = await readFile(ROOT + '/vs.html', 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const block = (src, start) => {
  const i = src.indexOf(start);
  if (i < 0) return null;
  const open = src.indexOf(start.endsWith('[') ? '[' : '{', i);
  const close = start.endsWith('[') ? ']' : '}';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === src[open]) depth++;
    else if (src[j] === close && --depth === 0) return src.slice(open, j + 1);
  }
  return null;
};
const idsIn = txt => [...new Set((txt || '').match(/['"]([A-Za-z0-9_-]{11})['"]/g) || [])]
  .map(s => s.slice(1, -1));

const defaultIds = idsIn(block(api, 'const DEFAULT_IDS = ['));
const releaseIds = idsIn(block(api, 'const RELEASE = {'));
const extraIds   = idsIn(block(api, 'const EXTRA_MARKS = {'));
const pageIds    = idsIn(block(vs, 'const ROWS = ['));

console.log(`    recorded ${defaultIds.length} · released ${releaseIds.length} · extra marks ${extraIds.length} · on the page ${pageIds.length}`);
defaultIds.length ? ok('DEFAULT_IDS parsed') : bad('DEFAULT_IDS parsed');
releaseIds.length ? ok('RELEASE parsed') : bad('RELEASE parsed');
pageIds.length    ? ok('the page ROWS parsed') : bad('the page ROWS parsed');

// The rule that was broken.
const marked = [...new Set([...releaseIds, ...extraIds])];
const unrecorded = marked.filter(id => !defaultIds.includes(id));
unrecorded.length
  ? bad('every video with a mark is recorded by the snapshot', unrecorded.join(', '))
  : ok('every video with a mark is recorded by the snapshot', `${marked.length} marked`);

// SAME FAMILY, AND IT IS NOT THE WEAKER ONE. This was a console.log — "reported
// rather than enforced, the page may legitimately show something before it is
// worth recording" — and on 2026-10-31 it printed
//
//     on the page but not recorded: Pksr9T8m_aA
//
// and exited 0. ADDICTED had been on vs.html for two days with nothing
// recording it, so its 24h figure was lost exactly the way Tarantino's was,
// while the check written to stop that recurrence watched it happen and said
// "all good". A rule that only prints is not a rule.
//
// The reason it was soft does not survive contact with what happened: a video
// is put on this page BECAUSE someone is watching it, and the live series is
// then written only while a visitor has the tab open — which is nobody,
// overnight, exactly when a mark tends to fall. "On the page" is the signal
// that it needs recording, not a reason to wait.
const pageUnrecorded = pageIds.filter(id => !defaultIds.includes(id));
pageUnrecorded.length
  ? bad('every video on the page is recorded by the snapshot', `${pageUnrecorded.join(', ')} — only a visitor with vs.html open writes points for these`)
  : ok('every video on the page is recorded by the snapshot', `${pageIds.length} on the page`);

// And the other direction, which is how ADDICTED slipped through: the capture
// job's MARK_UTC list is a FOURTH place an instant can be named, and naming it
// there without a matching mark in this file buys nothing. The job sleeps to
// the instant, samples, finds no mark for anything, and exits 0 green.
//
// COMPARED AS INSTANTS, NOT AS IDS. The first version of this check asked only
// whether the video had *a* mark somewhere, and both mutations that reproduce
// the real bug walked straight through it: drop the RELEASE entry and the
// 7-day mark still answers for the id, drop the 7-day mark and RELEASE does.
// Each instant in MARK_UTC has to have its own mark at that instant.
const job = await readFile(ROOT + '/.github/workflows/youtube-24h-mark.yml', 'utf8');
const markUtcDefault = (job.match(/MARK_UTC:[^\n]*?\|\|\s*'([^']+)'/) || [])[1] || '';
const jobInstants = markUtcDefault.split(',').map(s => s.trim()).filter(Boolean);

const DAY = 86400000;
const apiInstants = new Set();
for (const m of (block(api, 'const RELEASE = {') || '').matchAll(/'([A-Za-z0-9_-]{11})':\s*'([^']+)'/g)) {
  apiInstants.add(new Date(Date.parse(m[2]) + DAY).toISOString().replace('.000', ''));
}
for (const m of (block(api, 'const EXTRA_MARKS = {') || '').matchAll(/at:\s*'([^']+)'/g)) {
  apiInstants.add(new Date(Date.parse(m[1])).toISOString().replace('.000', ''));
}
jobInstants.length
  ? ok('the capture job names some instants', `${jobInstants.length}`)
  : bad('the capture job names some instants — MARK_UTC did not parse');
const orphans = jobInstants.filter(t => !apiInstants.has(new Date(Date.parse(t)).toISOString().replace('.000', '')));
orphans.length
  ? bad('every instant the job sleeps to has a mark to freeze',
        `${orphans.join(', ')} — in MARK_UTC with no RELEASE+24h or EXTRA_MARKS entry at that instant`)
  : ok('every instant the job sleeps to has a mark to freeze', `${jobInstants.length} instants`);

// DEFAULT_IDS is sliced to 10 before use, so an 11th id is silently dropped —
// and it would be dropped from the END, which is where a new release is added.
defaultIds.length <= 10
  ? ok('DEFAULT_IDS fits the 10-id cap', `${defaultIds.length}/10`)
  : bad('DEFAULT_IDS fits the 10-id cap — ids past the 10th are silently dropped', `${defaultIds.length}`);

// And the specific thing that went wrong, named so a regression is obvious.
defaultIds.includes('-5ZXrO_lYSA')
  ? ok('Tarantino is recorded')
  : bad('Tarantino is recorded');

console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
