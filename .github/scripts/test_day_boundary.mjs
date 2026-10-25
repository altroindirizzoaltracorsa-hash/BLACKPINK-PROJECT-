// The day turns over at 00:00 UTC, in every month of the year.
//
// Run: node .github/scripts/test_day_boundary.mjs
//
// Reported on 2026-10-25, the morning Italy came off summer time: the board
// said "resets 2:00 AM GMT+1 · 17h 37m left" at 08:23 local. Both halves were
// faithful renderings of a boundary that had moved. It was computed as 2 AM
// Rome —
//
//     Date.UTC(y, m, d, 2 - offset)     // offset 2 in summer, 1 in winter
//
// — which equals 00:00 UTC only while Italy is on summer time. With the offset
// back to 1 the boundary slid to 01:00 UTC, an hour after the rollover Spotify
// and the rest of the site use. An hour of plays lands on the wrong date, twice
// a year, in opposite directions.
//
// Six files carried their own copy of that arithmetic, which is why this checks
// all six rather than one. They are copies by necessity — each Vercel function
// is standalone and the repo has no shared module — so the guard is that they
// agree with each other and with 00:00 UTC, not that there is only one of them.
//
// The display layer was never the bug and is not changed: localResetLabel()
// formats the real instant in the reader's own clock, so the same boundary
// reads 1 AM in Rome through winter, 2 AM through summer, and the right hour in
// Manila. Nothing names an hour; that is the point.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// Each file, the boundary function in it, and how to read a day-start in ms
// out of whatever that function returns.
const SOURCES = [
  ['index.html',             'getDayBounds',          r => r.from * 1000],
  ['api/leaderboard.js',     'bpDayBounds',           r => r.from * 1000],
  ['api/cron-scrobbles.js',  'getDayBounds',          r => r.from * 1000],
  ['api/control-ranking.js', 'getTimeBounds',         r => r.dayFrom * 1000],
  ['api/playlist.js',        'currentItalyDayStart',  r => r],
  ['api/sync-playlist.js',   'currentItalyDayStart',  r => r],
];

// Instants chosen to straddle both changeovers and both sides of the old
// boundary. 00:30 UTC is the hour the bug moved: under 2-AM-Rome-in-winter it
// belonged to the PREVIOUS day.
const MOMENTS = [
  ['2026-06-15T12:00:00Z', 'mid-summer, midday'],
  ['2026-06-15T00:30:00Z', 'mid-summer, just after rollover'],
  ['2026-10-25T08:23:00Z', 'the morning DST ended — the reported case'],
  ['2026-10-25T00:30:00Z', 'that same day, inside the disputed hour'],
  ['2026-12-01T01:30:00Z', 'deep winter, past the old 2-AM-Rome boundary'],
  ['2027-03-28T02:30:00Z', 'the spring changeover'],
  ['2026-01-01T00:00:00Z', 'exactly on a rollover, new year'],
];

// Pull one function (plus anything it calls) out of a source file and run it
// with Date.now() pinned. Extracting rather than restating keeps the test
// measuring the shipped code.
function extract(file, fn) {
  const src = readFileSync(root + file, 'utf8');
  const re = new RegExp(`^function ${fn}\\([\\s\\S]*?^\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`${file}: could not find function ${fn}`);
  // Any helper the boundary code is known to lean on, in either the current
  // shape or the 2-AM-Rome one. Without the old names, reverting the bug makes
  // this throw ReferenceError instead of reporting the hour it is off by — red
  // either way, but only one of those tells you what broke.
  const HELPERS = ['utcDayStart', 'lastSunday', '_lastSunday', 'bpLastSunday',
                   'getItalyOffset', '_italyOffset', 'bpItalyOffset', 'italyNow'];
  const found = HELPERS
    .map(h => (src.match(new RegExp(`^function ${h}\\([\\s\\S]*?^\\}`, 'm')) || [])[0])
    .filter(Boolean);
  return found.concat(m[0]).join('\n');
}

for (const [iso, why] of MOMENTS) {
  const at = Date.parse(iso);
  const expected = Date.UTC(
    new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate());
  console.log(`\n--- ${iso}  (${why})`);
  console.log(`    expecting day to start at ${new Date(expected).toISOString()}`);
  for (const [file, fn, read] of SOURCES) {
    let got;
    try {
      const body = extract(file, fn);
      // Date.now() is pinned; everything else is the real Date.
      // The real Date comes in as a parameter: declaring `const Date` and then
      // reading the outer `Date` to wrap it puts the read inside its own
      // temporal dead zone, which is what the first version of this did.
      const run = new Function('__now', '__Date', `
        const Date = new Proxy(__Date, {
          apply: (t, s, a) => a.length ? __Date(...a) : new __Date(__now).toString(),
          construct: (t, a) => a.length ? new __Date(...a) : new __Date(__now),
          get: (t, p) => p === 'now' ? () => __now : __Date[p],
        });
        ${body}
        return ${fn}();
      `);
      got = read(run(at, Date));
    } catch (e) {
      check(false, `${file} → ${fn}()`, e.message);
      continue;
    }
    if (!Number.isFinite(got)) {
      // Not a boundary failure — the test read the wrong field out of this
      // file's return shape, and saying so beats crashing on toISOString().
      check(false, `${file} → ${fn}()`, `unreadable result: ${JSON.stringify(got)}`);
      continue;
    }
    const diffH = (got - expected) / 3600000;
    check(got === expected, `${file} → ${fn}()`,
          got === expected ? '' : `${new Date(got).toISOString()} — off by ${diffH}h`);
  }
}

console.log('\n--- no file still carries the DST arithmetic');
// The specific expression, and the helpers that only ever fed it. A comment
// quoting it for explanation is fine; a live `2 - offset` is not.
for (const [file] of SOURCES) {
  const src = readFileSync(root + file, 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const hits = code.match(/2 - (offset|_italyOffset\(\)|bpItalyOffset\(\))|getItalyOffset|bpItalyOffset|_italyOffset|italyNow\(/g) || [];
  check(hits.length === 0, `${file} has no live DST offset code`, [...new Set(hits)].join(', '));
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
