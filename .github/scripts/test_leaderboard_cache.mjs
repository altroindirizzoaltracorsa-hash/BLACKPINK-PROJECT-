// How long a copy of the leaderboard may be served for.
//
// Run: node .github/scripts/test_leaderboard_cache.mjs
//
// The board is the heaviest thing the site reads — 235 KB, the whole thing in
// one key — so the cache window is what decides most of the Upstash bill. It
// is also the one cache on the site that must end at a precise instant: the
// board resets at 00:00 UTC, and a copy served across that boundary shows
// yesterday's standings to somebody who has already started today.
//
// Those two pull in opposite directions, and the way this went wrong before is
// the reason for this file: `s-maxage` and `stale-while-revalidate` ADD UP. A
// copy is fresh for the first and then servable for the second on top. Clamping
// each to "seconds until reset" separately looks right and is not — at 90s
// before the reset it gives 60 + 90, which keeps serving the old board a minute
// and a half into the new day.
//
// So the arithmetic is lifted out of the endpoint and swept across the whole
// day rather than checked at a couple of convenient points.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const src = readFileSync(root + 'api/leaderboard.js', 'utf8');

// The REAL lines out of the endpoint, not a copy kept here. A test with its own
// copy of the sum is a test that agrees with itself.
const ttlLine = (src.match(/^\s*const ttl = .*$/m) || [])[0];
const swrLine = (src.match(/^\s*const swr = .*$/m) || [])[0];
const maxLine = (src.match(/^\s*const LB_TTL = \d+;.*$/m) || [])[0];
check(!!ttlLine && !!swrLine, 'found the two cache lines in api/leaderboard.js');
check(!!maxLine, 'and the fresh window is a named constant', (maxLine || '').trim());

const windows = new Function('secsToReset',
  `${maxLine}\n${ttlLine}\n${swrLine}\nreturn { ttl, swr };`);
const LB_TTL = Number((maxLine.match(/= (\d+)/) || [])[1]);

console.log('\n--- a copy is never servable past the reset');
{
  // Every second of the last two hours before the boundary, plus the far side
  // of a day. The failure this guards lived in a narrow band — only when the
  // reset was closer than the two windows summed — so sampling a few round
  // numbers would have missed it.
  const bad = [];
  for (let s = 0; s <= 7200; s++) {
    const { ttl, swr } = windows(s);
    if (ttl + swr > s) bad.push(`${s}s left → ${ttl}+${swr}`);
    if (ttl < 0 || swr < 0) bad.push(`${s}s left → negative window ${ttl}/${swr}`);
  }
  check(bad.length === 0, 'the two windows together never outlast the day',
        bad.slice(0, 3).join(', ') + (bad.length > 3 ? ` …${bad.length} in all` : ''));

  // And the specific shape that was wrong, named rather than left to the sweep:
  // close enough that the fresh window alone reaches the boundary.
  const near = windows(45);
  check(near.ttl === 45 && near.swr === 0,
        '45s before the reset, the copy expires exactly at it', `${near.ttl}+${near.swr}`);
  const at = windows(0);
  check(at.ttl === 0 && at.swr === 0, 'and at the boundary itself nothing is cached',
        `${at.ttl}+${at.swr}`);
}

console.log('\n--- and the rest of the day it is the full window');
{
  const far = windows(3600);
  check(far.ttl === LB_TTL, `an hour out, the fresh window is the full ${LB_TTL}s`, String(far.ttl));
  // The size of that window is the Upstash bill. 235 KB per origin read, so
  // 30s is ~2 reads a minute per edge region and 60s is ~1 — the difference is
  // about 10 GB a month against an allowance that was 10 GB.
  check(LB_TTL >= 60, 'and it is at least 60s, which is what halved the bandwidth',
        `${LB_TTL}s`);
  // Not unbounded either: this is a live board and people watch their own rank
  // move on it.
  check(LB_TTL <= 120, 'but not so long that a rank change goes unseen for minutes',
        `${LB_TTL}s`);
}

console.log('\n--- the header actually carries them');
{
  check(/s-maxage=\$\{ttl\}, stale-while-revalidate=\$\{swr\}/.test(src),
        'both windows are written into Cache-Control');
  // Vercel strips s-maxage from what it serves, so this can only be read from
  // the source — which is also why check_bandwidth_budget.py reads the source
  // rather than the response.
  check(/res\.setHeader\('Cache-Control'/.test(src), 'on the response itself');
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
