// The /youtube board's DAILY GAIN is a day's worth of views, not a run's worth.
//
// Run: node .github/scripts/test_youtube_gains.mjs
//
// WHY THIS IS NOT JUST "SHOW daily_delta". That column is "views since the
// previous reading", and the previous reading is not 24 hours ago: GitHub
// delays scheduled runs on this repo by 2-5 hours routinely, and the snapshot
// table carries hours_since precisely so a rate can be computed against real
// elapsed time. A card that printed the raw delta under a label saying "a day"
// would read 29 hours of views as a day's, and would do it on exactly the days
// a run slipped — which is to say, invisibly and often.
//
// So the endpoint normalises, and the case below that catches a regression is
// the DELAYED one: at exactly 24h the raw and normalised numbers are identical
// and a broken implementation passes.
//
// AND A NEGATIVE GAIN MUST SURVIVE. YouTube recounts continuously and takes
// totals back down; youtube_video_daily_stats' own comment says anything
// reading daily_delta must cope with a negative and must not "fix" it.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const api = readFileSync(root + 'api/youtube-milestones.js', 'utf8');

console.log('--- the columns are actually fetched');
// The gain costs no extra request because these ride on a query the board
// already makes — but only if they are in the select.
const sel = (api.match(/select:\s*'(video_ref,date,views[^']*)'/) || [])[1] || '';
check(/\bdaily_delta\b/.test(sel), 'daily_delta is in the snapshot select', sel);
check(/\bhours_since\b/.test(sel), 'hours_since is too — without it nothing can be normalised', sel);

console.log('\n--- the gain maths');
// Pulled out of the source and evaluated: it is a pure function, and importing
// the module would try to reach Supabase.
const fn = (api.match(/const RECENT_DAYS[\s\S]*?\nfunction gainsPerVideo\([\s\S]*?\n}\n/) || [])[0];
check(!!fn, 'gainsPerVideo could be read out of the endpoint');
const gainsPerVideo = new Function(`${fn}; return gainsPerVideo;`)();

const t = (daysAgo, hours) => new Date(Date.UTC(2026, 10, 20, 12) - daysAgo * 86400000).toISOString();
const row = (ref, daysAgo, views, delta, hours) =>
  ({ video_ref: ref, captured_at: t(daysAgo), views, daily_delta: delta, hours_since: hours });

{
  // A run 29 hours after the last one. 290,000 views in 29h is 240,000 a day.
  // THIS is the case that fails if anyone prints the raw delta.
  const g = gainsPerVideo([row(1, 0, 10_290_000, 290_000, 29)]).get(1);
  check(g.gain === 240000, 'a delayed run is normalised to 24h, not shown raw',
        `${g.gain} (raw delta was 290000)`);
}
{
  // The flattering case: at exactly 24h both answers agree, which is why it
  // cannot be the only test.
  const g = gainsPerVideo([row(1, 0, 10_240_000, 240_000, 24)]).get(1);
  check(g.gain === 240000, 'an on-time run is unchanged', `${g.gain}`);
}
{
  // A fast run — 6 hours after the last — must be scaled UP, not reported as
  // a tiny day.
  const g = gainsPerVideo([row(1, 0, 10_060_000, 60_000, 6)]).get(1);
  check(g.gain === 240000, 'a run taken early is scaled up, not under-reported', `${g.gain}`);
}
{
  const g = gainsPerVideo([row(1, 0, 9_900_000, -120_000, 24)]).get(1);
  check(g.gain === -120000, 'a recount stays negative and is not clamped to zero', `${g.gain}`);
}
{
  // One reading has no past to compare against. The board already refuses to
  // guess a rate from one reading; the gain must refuse the same way.
  const g = gainsPerVideo([{ video_ref: 1, captured_at: t(0), views: 5, daily_delta: null, hours_since: null }]).get(1);
  check(g.gain === null, 'one reading yields no gain rather than a guess', `${g.gain}`);
  check(g.gain7 === null, '  and no week average either');
}

console.log('\n--- the week average is a SPAN, not an average of deltas');
{
  // Seven readings, deliberately UNEVEN: a 2-day hole in the middle. Averaging
  // the deltas would weight a 2-day jump the same as a 1-day one. A span
  // cannot be fooled: 7,000,000 gained over 7 days is 1,000,000 a day however
  // the readings fell inside it.
  const rows = [
    row(1, 0, 17_000_000, 2_000_000, 48),
    row(1, 2, 15_000_000, 1_000_000, 24),
    row(1, 3, 14_000_000, 1_000_000, 24),
    row(1, 4, 13_000_000, 1_000_000, 24),
    row(1, 5, 12_000_000, 1_000_000, 24),
    row(1, 6, 11_000_000, 1_000_000, 24),
    row(1, 7, 10_000_000, 1_000_000, 24),
  ];
  const g = gainsPerVideo(rows).get(1);
  check(g.gain7 === 1_000_000, 'views gained across the window / days elapsed',
        `${g.gain7}`);
  check(Math.round(g.gainSpanDays) === 7, '  and it reports the span it used', `${g.gainSpanDays}`);
  // The newest row is a 2-day gap, so its normalised daily gain is HALF its
  // raw delta — and must not be confused with the week figure.
  check(g.gain === 1_000_000, '  while the day figure normalises that 48h row', `${g.gain}`);
}
{
  // Readings older than the window must not stretch the span. A reading from
  // 30 days ago would otherwise turn a week rate into a month rate.
  const rows = [
    row(1, 0, 10_700_000, 100_000, 24),
    row(1, 7, 10_000_000, 100_000, 24),
    row(1, 30, 1_000_000, 100_000, 24),
  ];
  const g = gainsPerVideo(rows).get(1);
  check(g.gain7 === 100_000, 'a reading outside the window is excluded', `${g.gain7}`);
  check(Math.round(g.gainSpanDays) === 7, '  so the span stays a week', `${g.gainSpanDays}`);
}
{
  // Order must not matter — the query happens to return newest first, and this
  // must not silently depend on that.
  const asc = [row(1, 3, 1_000_000, 100_000, 24), row(1, 0, 1_300_000, 100_000, 24)];
  const g = gainsPerVideo(asc).get(1);
  check(g.gain === 100_000, 'rows arriving oldest-first still read correctly', `${g.gain}`);
  check(g.gain7 === 100_000, '  including the week figure', `${g.gain7}`);
}

console.log('\n--- the card shows it');
const site = readFileSync(root + 'index.html', 'utf8');
check(/function ytmGain\(/.test(site), 'there is a gain formatter');
check(/const gain = ytmGain\(v\.gain\)/.test(site), '  the card reads v.gain');
check(/ytm-val \$\{Number\(v\.gain\) < 0 \? 'down' : 'up'\}/.test(site),
      '  and colours a recount differently rather than hiding it');
// A signed figure, so "+240K" and "−120K" are distinguishable at a glance.
const gf = (site.match(/function ytmShort[\s\S]*?\n}\n/) || [''])[0]
         + (site.match(/function ytmGain[\s\S]*?\n}\n/) || [''])[0];
const ytmGain = new Function(`${gf}; return ytmGain;`)();
check(ytmGain(1_234_567) === '+1.2M', '  positive gains carry a +', ytmGain(1_234_567));
check(ytmGain(-98_000).startsWith('−'), '  negative gains carry a minus', ytmGain(-98_000));
check(ytmGain(null) === null, '  and a missing gain renders nothing', String(ytmGain(null)));

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
