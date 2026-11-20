// A video's history, bucketed by day / week / month, the way kworb shows one.
//
// Run: node .github/scripts/test_youtube_video_history.mjs
//
// THE RULE THE WHOLE FILE EXISTS FOR: a bucket's gain is the views at its end
// minus the views before it began — NOT the sum of the daily deltas inside it.
// View counts are cumulative, so a span is immune to a missing reading and to
// one reading landing late, which are the two things that actually happen
// here. A sum would also silently drop the first reading of a video, whose
// daily_delta is null.
//
// And the first bucket of every view has NO gain. There is no reading before
// it to measure from, so a dash is the honest answer; a zero would be wrong
// and "all the views it has" would be far worse — it would report DDU-DU
// DDU-DU as having gained 2.4 billion in its first tracked week.
import { buildDaily, buildBuckets, isoWeek, bucketBy } from '../../api/youtube-video-history.js';
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

// A series like the real one: one reading a day, ascending, ~24h apart.
const mk = (startUTC, n, step = 240000, startViews = 1_000_000_000, tweak = () => ({})) => {
  const out = []; let views = startViews;
  for (let i = 0; i < n; i++) {
    const d = new Date(startUTC + i * 86400000);
    const t = tweak(i) || {};
    const delta = t.delta !== undefined ? t.delta : step;
    views += delta;
    out.push({ date: d.toISOString().slice(0, 10), views,
               daily_delta: i === 0 ? null : delta,
               hours_since: t.hours !== undefined ? t.hours : (i === 0 ? null : 24) });
  }
  return out;
};
const OCT4 = Date.UTC(2026, 9, 4);

console.log('--- ISO weeks, because a week has to mean one thing');
{
  // Monday-based and Thursday-decides-the-year, so a Sunday is not its own
  // week and Jan 1 does not invent a week 53 for a year that has 52.
  const w = (y, m, d) => { const r = isoWeek(new Date(Date.UTC(y, m, d))); return `${r.year}-W${r.week}`; };
  check(w(2026, 10, 16) === w(2026, 10, 22), 'Mon 16 Nov and Sun 22 Nov are the same week',
        `${w(2026, 10, 16)} / ${w(2026, 10, 22)}`);
  check(w(2026, 10, 22) !== w(2026, 10, 23), '  and Mon 23 Nov is the next one');
  // A Sunday-based week would put 22 Nov with 23 Nov instead. This is the
  // check that catches someone "fixing" the day offset.
  check(w(2026, 10, 15) !== w(2026, 10, 16), '  Sun 15 Nov belongs to the week before, not after');
}

console.log('\n--- a bucket gain is a span, not a sum of deltas');
{
  // 21 days from Mon 5 Oct: three whole ISO weeks, 240,000 a day.
  const { weekly } = buildBuckets(mk(Date.UTC(2026, 9, 5), 21));
  check(weekly.length === 3, 'three whole weeks bucket as three', `${weekly.length}`);
  check(weekly[0].gain === null, 'the first week has no gain — nothing precedes it', `${weekly[0].gain}`);
  check(weekly[1].gain === 240000 * 7, '  the second is a full week of views',
        `${weekly[1].gain}`);
  check(weekly[2].gain === 240000 * 7, '  and so is the third', `${weekly[2].gain}`);
}
{
  // THE CASE A SUM GETS WRONG. Drop a day out of the middle of week two: the
  // views still accumulate (the counter never stops), there is simply no
  // reading. A span across the week is unchanged, because the endpoints did
  // not move. A sum of the rows present would come up one day short.
  const full = mk(Date.UTC(2026, 9, 5), 21);
  const holed = full.filter(r => r.date !== '2026-10-14');
  const a = buildBuckets(full).weekly[1].gain;
  const b = buildBuckets(holed).weekly[1].gain;
  check(a === b, 'a missing reading inside a week does not change its gain',
        `${a} with the day, ${b} without`);
  const sumOfDeltas = holed.filter(r => r.date >= '2026-10-12' && r.date <= '2026-10-18')
    .reduce((s, r) => s + (r.daily_delta || 0), 0);
  check(sumOfDeltas !== b, '  whereas summing the deltas present would be short',
        `sum ${sumOfDeltas} vs span ${b}`);
}
{
  // A recount flows through rather than being clamped. YouTube takes totals
  // down and the schema says not to "fix" that.
  const s = mk(Date.UTC(2026, 9, 5), 21, 240000, 1e9, i => (i === 9 ? { delta: -500000 } : {}));
  const wk = buildBuckets(s).weekly;
  check(wk[1].gain < 240000 * 7, 'a recount inside a week pulls its gain down',
        `${wk[1].gain}`);
}

console.log('\n--- months bucket by calendar month');
{
  const { monthly } = buildBuckets(mk(OCT4, 47));
  check(monthly.length === 2, 'Oct 4 to Nov 19 is two calendar months', `${monthly.length}`);
  check(monthly[0].key === '2026-10' && monthly[1].key === '2026-11', '  keyed by year-month',
        monthly.map(m => m.key).join(', '));
  check(monthly[0].gain === null, '  October has no gain: it is the first', `${monthly[0].gain}`);
  // November's gain is measured from October's LAST reading, not from its
  // first — the bucket's level at its end is what the next one measures from.
  const oct = monthly[0].views, nov = monthly[1].views;
  check(monthly[1].gain === nov - oct, '  November is measured from October\'s close',
        `${monthly[1].gain}`);
}

console.log('\n--- the daily view normalises, like the board does');
{
  // A run 30h after the last is not a day. Same rule, same reason, as the
  // board's "Daily gain": hours_since exists because these land 22-26h apart.
  const s = mk(OCT4, 5, 240000, 1e9, i => (i === 3 ? { delta: 300000, hours: 30 } : {}));
  const d = buildDaily(s);
  check(d[3].gain === 240000, 'a 30-hour gap is scaled back to 24', `${d[3].gain} from a raw 300000`);
  check(d[0].gain === null, 'the first reading has no gain rather than a guess', `${d[0].gain}`);
}
{
  // If hours_since is missing the fallback differences the cumulative views,
  // which needs no gap at all — better than reporting nothing.
  const s = mk(OCT4, 3);
  s[2].hours_since = null; s[2].daily_delta = null;
  const d = buildDaily(s);
  check(d[2].gain === 240000, 'a row with no hours falls back to differencing views',
        `${d[2].gain}`);
}

console.log('\n--- ordering and labels');
{
  const d = buildDaily(mk(OCT4, 3));
  check(d[0].key === '2026-10-04' && d[2].key === '2026-10-06',
        'the series stays ascending; the panel reverses it for display',
        `${d[0].key} → ${d[2].key}`);
  check(/^Oct 4$/.test(d[0].label), 'days are labelled readably', d[0].label);
  const { weekly, monthly } = buildBuckets(mk(OCT4, 47));
  check(/–|-/.test(weekly[1].label), 'weeks are labelled as a range', weekly[1].label);
  check(/^Oct 2026$/.test(monthly[0].label), 'months name the month', monthly[0].label);
}

console.log('\n--- likes, comments and subscribers');
{
  // These cost NO extra quota: api/youtube-catalog.js already asks YouTube for
  // part=statistics, which carries likeCount and commentCount beside
  // viewCount. They were parsed past and dropped.
  const cat = readFileSync(root + 'api/youtube-catalog.js', 'utf8');
  check(/likes: it\.statistics\?\.likeCount/.test(cat), 'likes are kept from the stats already fetched');
  check(/comments: it\.statistics\?\.commentCount/.test(cat), '  and comments too');
  check(!/part: 'statistics,snippet,contentDetails'[^]*?part: 'statistics/.test(cat) &&
        (cat.match(/part: 'statistics,snippet,contentDetails'/g) || []).length === 1,
        '  from the one videos call, not a second one');
  // Subscribers needed only `statistics` adding to a channels call that was
  // already being made.
  check(/snippet,contentDetails,statistics/.test(cat), '  subscribers ride on the channels call');
  check(/hiddenSubscriberCount/.test(cat),
        '  and a channel that hides its count yields null, not 0');

  // NULL IS NOT ZERO anywhere in this chain. A video with comments off has no
  // comment count; it does not have zero comments. Collapsing the two invents
  // a fact — and would read a switch being flipped as every comment being
  // deleted.
  const api2 = readFileSync(root + 'api/youtube-video-history.js', 'utf8');
  check(/likes:\s+r\.like_count\s+== null \? null : Number/.test(api2),
        'the history preserves a missing like count as null');
  check(/comments: r\.comment_count == null \? null : Number/.test(api2),
        '  and a missing comment count');
  const snap = readFileSync(root + '.github/scripts/snapshot_youtube.py', 'utf8');
  check(/"like_count": v\.get\("likes"\)/.test(snap) && !/v\.get\("likes"\) or 0/.test(snap),
        '  and the snapshot writes null rather than coercing to 0');
  // NO SUBSCRIBER GAIN, ANYWHERE. YouTube rounds the count to three
  // significant figures, so on a 95.8M channel the step is 100,000: a true
  // gain of 20,000 a day shows as four days of nothing and then a jump of a
  // whole step. A "daily subscribers" figure would be the rounding presented
  // as fan behaviour.
  const mig = readFileSync(root + 'supabase/migrations/youtube_likes_comments_subs.sql', 'utf8');
  check(!/daily_delta/.test(mig.split('youtube_channel_daily_stats')[1] || ''),
        'the channel table has no delta column, because the counts are rounded');
}

console.log('\n--- the page, and what it refuses to show');
const site = readFileSync(root + 'index.html', 'utf8');
// A PAGE AT /youtube/<video id>. It was a panel inside the card first (a
// 47-row table growing out of one card pushes every video below it off the
// screen) and then an overlay sheet (covers the board, and has no address).
// A page has a URL: bookmarkable, pasteable, and the back button works.
check(/id="page-ytvideo"/.test(site), 'the history is its own page');
// A DASH FOR EVERY UNPUBLISHED FIGURE — a 0 would say nobody did it.
check(/r\.gain == null \? '—'/.test(site) && /n == null \? '—'/.test(site),
      '  printing a dash for a figure that was never published, not a zero');
// The subscriber count is YouTube's rounded one and is labelled as such, and
// no gain is derived from it anywhere: the rounding step on a 95.8M channel
// is 100,000, so a "daily subscribers" figure would be the rounding presented
// as fan behaviour.
check(/rounded by YouTube/.test(site), '  saying the subscriber count is rounded');
check(!/subscriber.{0,20}gain|gain.{0,20}subscriber/i.test(site),
      '  and showing no subscriber gain anywhere');
// Dislikes left the API in December 2021; nothing should claim to have them.
check(!/dislike/i.test(site), '  and claiming no dislike count, which YouTube stopped publishing');
check(!/ytm-hist-overlay|ytm-hist-sheet|closeYtmHistory/.test(site),
      '  with no overlay left behind');
// The route. The trailing slash is load-bearing: '/youtube-charts' is a
// different page and startsWith('/youtube') would swallow it.
check(/clean\.startsWith\('\/youtube\/'\)\) return 'ytvideo'/.test(site),
      '  routed from /youtube/<id>');
check(/'\/youtube-charts'/.test(site), '  and /youtube-charts still exists to be confused with');
// NOT in PAGE_PATHS: showPage reverse-looks-up a page's path there, and a
// second entry pointing at /youtube would make '/youtube' ambiguous.
const paths = (site.match(/const PAGE_PATHS = \{([\s\S]*?)\};/) || [])[1] || '';
check(!/ytvideo:/.test(paths),
      '  and deliberately absent from PAGE_PATHS, which would make /youtube ambiguous',
      paths.includes('ytvideo') ? 'ytvideo is in PAGE_PATHS' : 'absent');
// Push the URL BEFORE switching page, or showPage rewrites it back to the
// board's path and the deep link is lost the instant it is created.
check(/history\.pushState\(\{ page: 'ytvideo' \}, '', `\/youtube\/\$\{vid\}`\);\s*\n\s*showPage\('ytvideo'\);/.test(site),
      '  the URL is pushed before the page switches, not after');
// A cold load and every back/forward must rebuild it — the page cannot assume
// a card was clicked.
check(/if \(page === 'ytvideo'\) loadYtVideoPage\(\);/.test(site),
      '  and showPage rebuilds it on cold load and on back/forward');
// A malformed id is not a page. Eleven base62 characters or it is the board.
check(/\^\\\/youtube\\\/\(\[A-Za-z0-9_-\]\{11\}\)/.test(site),
      '  an id must be 11 base62 characters');
check(/if \(!vid\) \{ showPage\('ytviews'\); return; \}/.test(site),
      '  and anything else falls back to the board rather than an empty page');
// A slow fetch must not drop one video's table under another video's heading.
// The RENDER call specifically: the same guard is on the error path, so a
// loose match passes while the success path is broken.
check(/if \(_ytmHistVid === vid\) \{ ytvdHead\(/.test(site),
      '  a response arriving after the reader moved on is discarded');
check(/_ytmHist\.has\(vid\)/.test(site), '  and the series is cached, so going back is free');

// A ROUTE THAT ONLY THE SPA KNOWS ABOUT IS A 404 ON A COLD LOAD. Every other
// deep-linked path on this site has a rewrite in vercel.json sending it to
// index.html; without one, pasting /youtube/<id> into a fresh tab hits Vercel
// looking for a file that is not there, and the router never runs to fix it.
{
  const vercel = JSON.parse(readFileSync(root + 'vercel.json', 'utf8'));
  const sources = (vercel.rewrites || []).map(r => r.source);
  check(sources.includes('/youtube'), 'the board still has its rewrite');
  check(sources.some(x => /^\/youtube\/:/.test(x)),
        '  and /youtube/<id> has one too, or a pasted link 404s',
        sources.filter(x => x.startsWith('/youtube')).join(', '));
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
