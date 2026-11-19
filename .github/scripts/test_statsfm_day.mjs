// /api/statsfm can be asked for ANY day, and asks Stats.fm for exactly that day.
//
// Run: node .github/scripts/test_statsfm_day.mjs
//
// WHY THIS EXISTS. api/cron-scrobbles.js carried, for weeks, the note that
// Musicat and Stats.fm "expose no per-day history to re-derive it, so on a
// later day it's simply 0 until the fan opens their badges again". The
// consequence was real: a fan's Stats.fm plays counted for nothing on any day
// they did not personally open /badges, and the days already lost could not be
// recovered.
//
// For Stats.fm that first half was never true. `top/tracks?after=&before=`
// takes two arbitrary Unix-ms bounds — this endpoint had been calling it with
// today's bounds since the day it replaced the broken streams/recent pager,
// and the comment above that call says so in as many words ("an accurate
// per-track total for the exact window in a single call"). Only the arguments
// were pinned.
//
// WHAT WOULD BREAK SILENTLY, and is therefore what this file checks:
//   · `before` left at Date.now() — every requested day returns that day
//     UNTIL NOW. A backfill would then write today's cumulative numbers onto
//     every past date, each one bigger than the last, and look like it worked.
//   · the cache key not carrying the day — three days asked for in a row all
//     get served the first one's payload. Same symptom, different cause.
//   · a local timezone creeping into the bounds, which is the bug CLAUDE.md
//     says always comes back by a new route; this very file used to compute
//     dayBoundaryUTC('Europe/Rome', 2).
//
// The handler needs Stats.fm and Upstash, so what is tested here is the pure
// window arithmetic and the cache key, lifted out of the module source. The
// lift is asserted: if the function stops being found, this fails loudly
// rather than quietly testing nothing.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const src = readFileSync(root + 'api/statsfm.js', 'utf8');

const lift = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) {
    console.log(`  FAIL harness: ${name}() not found in api/statsfm.js — fix this test, do not let it pass by testing nothing.`);
    process.exit(1);
  }
  return m[0];
};

const mod = new Function(`${lift('siteDayStartISO')}\n${lift('dayWindow')}\nreturn { siteDayStartISO, dayWindow };`)();
ok('harness lifted the real window arithmetic', 'dayWindow + siteDayStartISO');

const DAY = 86400000;
const todayStart = new Date(mod.siteDayStartISO()).getTime();
const iso = ms => new Date(ms).toISOString();

console.log('\n--- a past day is that day, and stops at its own end');
{
  const w = mod.dayWindow('2026-11-10');
  check(!w.error, 'it is accepted', w.error || '');
  check(w.afterMs === Date.UTC(2026, 10, 10), 'it starts at 00:00 UTC on the day asked for', iso(w.afterMs));
  // THE ONE THAT MATTERS. With `before` left at now, this window would be ~9
  // days wide and every backfilled date would carry a running total.
  check(w.beforeMs === Date.UTC(2026, 10, 11), 'and ENDS at 00:00 UTC the next day, not at now', iso(w.beforeMs));
  check(w.beforeMs - w.afterMs === DAY, '  so the window is exactly 24h wide',
        `${(w.beforeMs - w.afterMs) / 3600000}h`);
  check(w.final === true, 'and a finished day is marked final, so it can be cached as long as we hold it');
  check(w.dayKey === '2026-11-10', 'and it reports which day it is', w.dayKey);
}

console.log('\n--- consecutive days do not overlap and leave no gap');
{
  const a = mod.dayWindow('2026-11-10');
  const b = mod.dayWindow('2026-11-11');
  check(a.beforeMs === b.afterMs, 'one day ends exactly where the next begins',
        `${iso(a.beforeMs)} === ${iso(b.afterMs)}`);
}

console.log('\n--- today is still today, and still moving');
{
  const w = mod.dayWindow(null);
  check(w.afterMs === todayStart, 'no day asked for means the current site day', iso(w.afterMs));
  check(Math.abs(w.beforeMs - Date.now()) < 5000, 'and it runs up to now, not to midnight',
        iso(w.beforeMs));
  check(w.final === false, 'and is not final, so it keeps the short cache freshness');
  check(w.dayKey === null, 'and reports no day key', String(w.dayKey));
  // Asking for today BY NAME must not reach past this instant either.
  const n = new Date(todayStart);
  const todayName = `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(n.getUTCDate()).padStart(2, '0')}`;
  const byName = mod.dayWindow(todayName);
  check(!byName.error, 'today can also be asked for by name', todayName);
  check(byName.beforeMs <= Date.now() + 1000, '  and still stops at now rather than in the future',
        iso(byName.beforeMs));
  check(byName.final === false, '  and is not treated as final while it is still running');
}

console.log('\n--- nonsense is refused rather than guessed at');
for (const [v, why] of [
  ['2026-13-01', 'a month that does not exist still parses as a date in JS, so only the shape is checked here'],
  ['tomorrow',   'words'],
  ['20261110',   'no dashes'],
  ['2026-11-1',  'a one-digit day'],
  ["2026-11-10' OR 1=1", 'anything injected'],
]) {
  const w = mod.dayWindow(v);
  // 2026-13-01 is shape-valid and Date.UTC rolls it to 2027-01-01, which is in
  // the future — so it is refused by the future check rather than the shape
  // one. Either refusal is correct; silently accepting it is not.
  check(!!w.error, `"${v}" is refused`, w.error || why);
}
{
  const future = new Date(todayStart + 2 * DAY);
  const key = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, '0')}-${String(future.getUTCDate()).padStart(2, '0')}`;
  const w = mod.dayWindow(key);
  check(!!w.error, 'a future day is refused', `${key}: ${w.error}`);
}

console.log('\n--- the cache key carries the day');
{
  // Three days asked for in a row must not be served one payload. The key is
  // built in the handler, so it is read as text.
  const keyLine = (src.match(/const cacheKey = `[^`]+`/) || [''])[0];
  check(/\$\{win\.dayKey/.test(keyLine), 'the cache key includes the requested day', keyLine);
  check(/sfmcache:v3/.test(keyLine), 'and the version was bumped past the day-less v2 payloads',
        keyLine);
}

console.log('\n--- no named timezone reached the boundary');
{
  // CLAUDE.md: every instance of this bug has arrived by a different route, and
  // this exact file carried one — dayBoundaryUTC('Europe/Rome', 2).
  // Matched against the IANA REGION PREFIXES, not any "word/word" string — the
  // first draft of this check matched 'application/json' and failed on a
  // Content-Type header, which is the kind of false alarm that gets a real
  // check deleted.
  const code = src.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const tz = code.match(/['"](?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_+-]+['"]|timeZone\s*:/);
  check(!tz, 'the day boundary reads no named timezone', tz ? tz[0] : 'UTC only');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
