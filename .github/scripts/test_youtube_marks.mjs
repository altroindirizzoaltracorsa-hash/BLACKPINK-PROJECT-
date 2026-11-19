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

// ── THE TWO RELEASE COPIES MUST AGREE ──────────────────────────────────────
//
// There is a FOURTH list, and this file had never opened the file it is in.
// api/youtube-stats.js carries its own copy of RELEASE — duplicated on purpose,
// because the shared module they once lived in would not load on Vercel and
// crashed both endpoints at import. Its own header says what the duplication
// costs when it drifts: that endpoint stamps a milestone the instant it is
// crossed, and for an id it has not heard of it writes `since: null` — the
// "how long after release" figure — and the write is HSETNX, so the history
// endpoint can never correct it afterwards.
//
// It drifted. The copy stopped being updated after ROSÉ in September while
// youtube-history.js's kept growing, so Tarantino, ADDICTED, Someone to Hold
// and Leave With Me all crossed milestones against a map that did not contain
// them. Nothing caught it because nothing compared them.
//
// Keys AND instants, not just keys: a copy that lists the right ids at the
// wrong times stamps a wrong `since` rather than a null, which is worse —
// null at least looks missing.
const stats = await readFile(ROOT + '/api/youtube-stats.js', 'utf8');
// COMMENTS STRIPPED FIRST, and that is not tidiness. Without it the regex
// matches an entry inside a comment, so commenting a release out — the exact
// way one gets disabled — still reads as present and the check passes while
// the endpoint stamps since:null. Caught by mutation-testing this check
// rather than by reading it: deleting a line failed as intended, commenting
// the same line out did not.
// Line-oriented rather than a general comment stripper: these maps are one
// `'id': 'instant', // note` per line, and both map bodies are machine-written
// in that shape.
const pairs = (src) => {
  const b = (block(src, 'const RELEASE = {') || '')
    .split('\n')
    .filter(l => !l.trimStart().startsWith('//'))
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
  return Object.fromEntries([...b.matchAll(/'([A-Za-z0-9_-]{11})':\s*'([^']+)'/g)]
    .map(m => [m[1], m[2]]));
};
{
  const a = pairs(api), b = pairs(stats);
  const missing = Object.keys(a).filter(id => !(id in b));
  const extra   = Object.keys(b).filter(id => !(id in a));
  const differs = Object.keys(a).filter(id => id in b && a[id] !== b[id])
    .map(id => `${id}: ${a[id]} vs ${b[id]}`);
  missing.length
    ? bad('youtube-stats.js knows every release youtube-history.js does',
          `${missing.join(', ')} — these stamp since:null, permanently (HSETNX)`)
    : ok('youtube-stats.js knows every release youtube-history.js does',
         `${Object.keys(b).length} entries`);
  extra.length
    ? bad('  and no release the other has never heard of', extra.join(', '))
    : ok('  and no release the other has never heard of');
  differs.length
    ? bad('  at the same instants', differs.join('; '))
    : ok('  at the same instants');
}

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

// ── The two rules that make this automatic instead of remembered ────────────
//
// "You should know by now that we need to fetch the 24h mark and the 7 days
// mark." Correct, and the way to know it is not to remember it. A release is
// added to this site in a hurry, on the day, and every list it has to reach is
// a chance to miss one — ADDICTED reached two of four and the 24h figure was
// gone before anyone looked.
//
// RULE 1: an MV with a 24h mark must also have a 7-day mark. Teasers are
// exempt and have to be named here, so skipping one is a decision someone
// wrote down rather than a gap nobody noticed.
const NO_SEVEN_DAY = {
  'LzgE8ift2Uw': 'JISOO teaser — teasers are tracked for their first day only',
  'h-7_04c_hVc': 'LISA teaser — same',
};
const missing7d = releaseIds.filter(id => !extraIds.includes(id) && !NO_SEVEN_DAY[id]);
missing7d.length
  ? bad('every release with a 24h mark also has a 7-day mark',
        `${missing7d.join(', ')} — add it to EXTRA_MARKS, or to NO_SEVEN_DAY with a reason`)
  : ok('every release with a 24h mark also has a 7-day mark',
       `${releaseIds.length - Object.keys(NO_SEVEN_DAY).length} with both, ${Object.keys(NO_SEVEN_DAY).length} deliberately exempt`);

// RULE 2: a mark that has not happened yet must be QUEUED in the capture job.
// A mark the job does not name is left to the hourly snapshot, which lands
// within the 95-minute tolerance but not on the instant — and if the id is
// also unrecorded, to nothing at all. Past marks may stay or go; the job
// ignores them either way.
const now = Date.now();
const pending = [];
for (const m of (block(api, 'const RELEASE = {') || '').matchAll(/'([A-Za-z0-9_-]{11})':\s*'([^']+)'/g)) {
  const at = Date.parse(m[2]) + DAY;
  if (at > now) pending.push([m[1] + ' 24h', at]);
}
for (const m of (block(api, 'const EXTRA_MARKS = {') || '').matchAll(/'([A-Za-z0-9_-]{11})':\s*\[([^\]]*)\]/g)) {
  for (const e of m[2].matchAll(/key:\s*'([^']+)'[^}]*?at:\s*'([^']+)'/g)) {
    const at = Date.parse(e[2]);
    if (at > now) pending.push([`${m[1]} ${e[1]}`, at]);
  }
}
const queued = new Set(jobInstants.map(t => Date.parse(t)));
const unqueued = pending.filter(([, at]) => !queued.has(at));
unqueued.length
  ? bad('every mark still in the future is queued in the capture job',
        `${unqueued.map(([n, at]) => `${n} @ ${new Date(at).toISOString()}`).join(', ')} — add it to MARK_UTC and dispatch the job by hand a few hours before`)
  : ok('every mark still in the future is queued in the capture job',
       pending.length ? pending.map(([n]) => n).join(', ') : 'none pending');
const orphans = jobInstants.filter(t => !apiInstants.has(new Date(Date.parse(t)).toISOString().replace('.000', '')));
orphans.length
  ? bad('every instant the job sleeps to has a mark to freeze',
        `${orphans.join(', ')} — in MARK_UTC with no RELEASE+24h or EXTRA_MARKS entry at that instant`)
  : ok('every instant the job sleeps to has a mark to freeze', `${jobInstants.length} instants`);

// DEFAULT_IDS is sliced to MAX_IDS before use, so anything past it is silently
// dropped — and dropped from the END, which is where a new release is added.
// So the id that stops being recorded is the one that most needs recording.
//
// READ FROM THE SOURCE, not written here as a literal. This check used to hold
// a hardcoded 10 against a `.slice(0, 10)` at the call site, with DEFAULT_IDS
// sitting at exactly 10 — two numbers in two files with nothing tying them
// together, and the next release would have tripped it. Parsing the constant
// means raising the cap and raising this check are the same edit.
const maxIds = Number((api.match(/const MAX_IDS\s*=\s*(\d+)/) || [])[1]);
Number.isFinite(maxIds)
  ? ok('MAX_IDS parsed from the handler', String(maxIds))
  : bad('MAX_IDS parsed from the handler', 'no `const MAX_IDS = <n>` in api/youtube-history.js');
// And the slice must actually use it, or the constant is decoration.
/\.slice\(0,\s*MAX_IDS\)/.test(api)
  ? ok('  and the handler slices by it')
  : bad('  and the handler slices by it', 'the call site still carries a literal');
defaultIds.length <= maxIds
  ? ok('DEFAULT_IDS fits the cap', `${defaultIds.length}/${maxIds}`)
  : bad('DEFAULT_IDS fits the cap — ids past it are silently dropped',
        `${defaultIds.length}/${maxIds}: ${defaultIds.slice(maxIds).join(', ')} would never be recorded`);

// And the specific thing that went wrong, named so a regression is obvious.
defaultIds.includes('-5ZXrO_lYSA')
  ? ok('Tarantino is recorded')
  : bad('Tarantino is recorded');

console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
