// What date a chart row is labelled with, and what counts as its previous row.
//
// Run: node .github/scripts/test_chart_dates.mjs
//
// chart_positions rows were stamped with the FETCH date. Spotify publishes its
// daily charts in arrears — at 06:30 UTC on 2026-10-24 the service was still
// serving the 2026-10-22 chart — so every row was dated one to two days ahead
// of the data inside it, and /spotify-charts showed a two-day-old chart under
// today's heading. The payload states the day it covers; that is what the row
// now carries.
//
// Changing the label changes what "the previous chart" means, which is what
// decides NEW / RE-ENTRY and the streams delta. That is the part worth pinning:
// a row must compare against the newest row strictly BEFORE its own date, not
// against whatever the newest row in the table happens to be.
import { readFile } from 'node:fs/promises';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const src = await readFile(ROOT + '/api/proxy-image.js', 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d !== undefined ? ` → ${JSON.stringify(d)}` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d !== undefined ? ` → ${JSON.stringify(d)}` : ''}`); };
const eq  = (m, got, want) => JSON.stringify(got) === JSON.stringify(want) ? ok(m, got) : bad(`${m} (want ${JSON.stringify(want)})`, got);

// The real function, lifted from the handler rather than retyped — a copy
// would keep passing after the original changed.
const m = src.match(/const chartDateOf = d =>[\s\S]*?\|\| null;/);
if (!m) { console.log('  FAIL chartDateOf not found in api/proxy-image.js'); process.exit(1); }
const chartDateOf = eval(`(${m[0].replace(/^const chartDateOf = /, '').replace(/;$/, '')})`);
ok('chartDateOf lifted from the handler');

console.log('\n--- the date the chart states ---');
// Exactly what regional-vn-daily returned on 2026-10-24.
eq('the real Vietnam payload',
   chartDateOf({ displayChart: { date: '2026-10-22', chartMetadata: { dimensions: { latestDate: '2026-10-22' } } } }),
   '2026-10-22');
eq('falls back to dimensions.latestDate',
   chartDateOf({ displayChart: { chartMetadata: { dimensions: { latestDate: '2026-10-21' } } } }), '2026-10-21');
eq('null when the payload states nothing', chartDateOf({ displayChart: {} }), null);
eq('null when there is no displayChart', chartDateOf({}), null);
eq('null, not a crash, on a null payload', chartDateOf(null), null);

console.log('\n--- "the previous chart" is relative to the row\'s own date ---');
// `consecutive` means the prior row is the group's most recent recorded run —
// NOT that it is the calendar day before. A gap in our recording still leaves
// the row before it as the previous run; that is why it gates RE-ENTRY rather
// than being a date subtraction.
const priorRows = [
  { spotify_track_id: 'x', country: 'TH', chart_type: 'daily', tracking_date: '2026-10-21', streams: 100 },
  { spotify_track_id: 'x', country: 'TH', chart_type: 'daily', tracking_date: '2026-10-22', streams: 150 },
  { spotify_track_id: 'x', country: 'TH', chart_type: 'daily', tracking_date: '2026-10-18', streams: 50 },
];
const priorsByKey = {}, groupDates = {};
for (const r of [...priorRows].sort((a, b) => b.tracking_date.localeCompare(a.tracking_date))) {
  (priorsByKey[`${r.spotify_track_id}::${r.country}::${r.chart_type}`] ||= []).push(r);
  (groupDates[`${r.country}::${r.chart_type}`] ||= []).push(r.tracking_date);
}
// The handler's OWN function, not a retyped copy of it: the copy passed when
// the original was made to ignore the row's date entirely.
const pf = src.match(/function priorForDate\(priors, groupDates, date\) \{[\s\S]*?\n\}/);
if (!pf) { console.log('  FAIL priorForDate not found in api/proxy-image.js'); process.exit(1); }
const priorForDate = eval(`(${pf[0]})`);
ok('priorForDate lifted from the handler');
const pick = date => {
  const { prior, consecutive } = priorForDate(priorsByKey['x::TH::daily'], groupDates['TH::daily'], date);
  return { prior: prior?.tracking_date ?? null, consecutive };
};
eq('a 10-23 row compares against 10-22', pick('2026-10-23'), { prior: '2026-10-22', consecutive: true });
eq('a 10-22 row compares against 10-21, never against itself',
   pick('2026-10-22'), { prior: '2026-10-21', consecutive: true });
eq('a 10-20 row takes 10-18 as the previous RUN, gap and all',
   pick('2026-10-20'), { prior: '2026-10-18', consecutive: true });
eq('a row older than everything stored has no prior',
   pick('2026-10-01'), { prior: null, consecutive: false });

// The case `consecutive` exists for. The GROUP charted on 10-22 (some other
// track held it), but THIS track did not — it was on 10-21 and is back on
// 10-23. That is a RE-ENTRY, and the streams delta must not be computed
// across the gap. Every fixture above has the track present on the group's
// last run, so they cannot tell a correct `consecutive` from one hardwired
// true; this one can.
const reentry = priorForDate(
  [{ tracking_date: '2026-10-21', streams: 100 }, { tracking_date: '2026-10-18', streams: 50 }],
  ['2026-10-22', '2026-10-21', '2026-10-18'],
  '2026-10-23');
eq('a track that missed the group\'s last run is NOT consecutive',
   { prior: reentry.prior?.tracking_date ?? null, consecutive: reentry.consecutive },
   { prior: '2026-10-21', consecutive: false });

console.log('\n--- the handler no longer stamps the fetch date ---');
src.includes('tracking_date: _date')
  ? ok('rows carry the chart\'s own date')
  : bad('rows carry the chart\'s own date');
/tracking_date: today\b/.test(src.slice(src.indexOf('charts === \'fetch-songs\'')))
  ? bad('a "tracking_date: today" survives in the songs sweep')
  : ok('no "tracking_date: today" left in the songs sweep');

console.log('\n--- charts Spotify does not publish ---');
// Cyprus has no DAILY song chart, no artist chart and no album chart, but it
// DOES have a weekly song chart — so the country must not be dropped, only the
// aliases that 404. Each was checked individually; a single 404 is not grounds
// to stop asking for the others.
const sk = src.match(/const NO_SUCH_CHART = new Set\(\[[\s\S]*?\]\);\s*const chartPublished = [\s\S]*?;\n/);
if (!sk) { console.log('  FAIL chartPublished not found in api/proxy-image.js'); process.exit(1); }
const chartPublished = new Function(`${sk[0]} return chartPublished;`)();
ok('chartPublished lifted from the handler');
eq('cy daily songs is not requested',  chartPublished('regional', 'cy', 'daily'),  false);
eq('cy WEEKLY songs still is',         chartPublished('regional', 'cy', 'weekly'), true);
eq('cy daily artists is not',          chartPublished('artist',   'cy', 'daily'),  false);
eq('cy albums is not',                 chartPublished('album',    'cy', 'weekly'), false);
eq('an unverified alias is still tried', chartPublished('artist', 'cy', 'weekly'), true);
eq('other countries are untouched',    chartPublished('regional', 'th', 'daily'),  true);
eq('matching ignores case',            chartPublished('regional', 'CY', 'daily'),  false);

// Knowing which charts are absent is useless if a sweep does not ask. These
// are source checks, which are weaker than driving the handler — but the
// handler needs Supabase and a Spotify token to run, and a sweep that quietly
// stopped consulting the list would otherwise pass every behavioural test
// here while paying for 404s again.
for (const [kind, needle] of [
  ['songs',   "chartPublished('regional', country, chartType)"],
  ['artists', "chartPublished('artist', country, chartType)"],
  ['albums',  "chartPublished('album', c, 'weekly')"],
]) {
  src.includes(needle)
    ? ok(`the ${kind} sweep consults the skip list`)
    : bad(`the ${kind} sweep consults the skip list`);
}

console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
