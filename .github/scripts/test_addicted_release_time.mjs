// ADDICTED goes out at one instant, and the site has five copies of it.
//
// Run: node .github/scripts/test_addicted_release_time.mjs
//
// The countdown was set to 2026-10-30T04:00:00Z — 1PM KST, the hour JISOO's
// CLICK and the other singles used. The official timetable says 8AM KST on
// Oct 30, which is 2026-10-29T23:00:00Z. Five hours earlier. The countdown
// would have sat there showing time remaining while the song was already out,
// and the existing test asserted the wrong value, so it PROTECTED the bug
// rather than catching it.
//
// So this does not assert a timestamp someone typed. It derives the instant
// from the published timetable — every city on the poster, rendered in its own
// zone and compared against what the poster prints — and then checks that each
// copy in the site agrees with it. Getting the release time wrong now requires
// the poster to be wrong too.
//
// Five copies, because there are five: the card's data-target, the "release
// times worldwide" block, the human sub-line, ADDICTED_RELEASE_AT (which hides
// the pre-save block and stamps the share card), and the share card's own
// dateLine. They are separate on purpose — different parts of the page — and
// nothing but this check keeps them in step.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// The TIMETABLE poster, transcribed. City, IANA zone, and the local time it
// prints. This is the source of truth; everything else is derived.
const POSTER = [
  ['Los Angeles', 'America/Los_Angeles', 'Oct 29 @ 4:00 PM'],
  ['Mexico City', 'America/Mexico_City', 'Oct 29 @ 5:00 PM'],
  ['New York',    'America/New_York',    'Oct 29 @ 7:00 PM'],
  ['São Paulo',   'America/Sao_Paulo',   'Oct 29 @ 8:00 PM'],
  ['Auckland',    'Pacific/Auckland',    'Oct 30 @ 12:00 PM'],
  ['Beijing',     'Asia/Shanghai',       'Oct 30 @ 7:00 AM'],
  ['Sydney',      'Australia/Sydney',    'Oct 30 @ 10:00 AM'],
  ['Bangkok',     'Asia/Bangkok',        'Oct 30 @ 6:00 AM'],
  ['London',      'Europe/London',       'Oct 29 @ 11:00 PM'],
  ['Manila',      'Asia/Manila',         'Oct 30 @ 7:00 AM'],
  ['Mumbai',      'Asia/Kolkata',        'Oct 30 @ 4:30 AM'],
  ['Paris',       'Europe/Paris',        'Oct 30 @ 12:00 AM'],
  ['Seoul',       'Asia/Seoul',          'Oct 30 @ 8:00 AM'],
  ['Tokyo',       'Asia/Tokyo',          'Oct 30 @ 8:00 AM'],
];

const RELEASE = '2026-10-29T23:00:00Z';

const render = (iso, tz) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(iso));
  const g = t => (parts.find(p => p.type === t) || {}).value;
  return `${g('month')} ${g('day')} @ ${g('hour')}:${g('minute')} ${g('dayPeriod')}`;
};

console.log(`--- ${RELEASE} is the instant the poster describes`);
// All fourteen, not a sample. A release time that satisfies thirteen cities and
// not the fourteenth is the wrong release time, and a transcription slip in
// this very file would otherwise read as agreement.
for (const [city, tz, printed] of POSTER) {
  const got = render(RELEASE, tz);
  check(got === printed, `${city} reads ${printed}`, got === printed ? '' : `got ${got}`);
}

console.log('\n--- and no other hour does');
// Guards against the file being "fixed" by moving both the poster and the code
// together. The old value has to be refuted explicitly.
for (const wrong of ['2026-10-30T04:00:00Z', '2026-10-29T22:00:00Z', '2026-10-30T00:00:00Z']) {
  const agree = POSTER.filter(([, tz, printed]) => render(wrong, tz) === printed).length;
  check(agree === 0, `${wrong} matches no city`, `${agree}/${POSTER.length}`);
}

console.log('\n--- every copy in the site agrees');
{
  const page = readFileSync(root + 'index.html', 'utf8');
  const card = page.match(/<div class="cd-card cd-card-addicted"[\s\S]*?<\/details>\s*<\/div>/);
  check(!!card, 'found the ADDICTED card');
  const block = card ? card[0] : '';

  check(block.includes(`data-target="${RELEASE}"`), 'the countdown counts to it',
        (block.match(/data-target="([^"]+)"/) || [])[1]);
  check(block.includes(`data-times-for="${RELEASE}"`), '"release times worldwide" is built from it',
        (block.match(/data-times-for="([^"]+)"/) || [])[1]);

  const relAt = (page.match(/const ADDICTED_RELEASE_AT = '([^']+)'/) || [])[1];
  check(relAt === RELEASE, 'ADDICTED_RELEASE_AT agrees', relAt);

  // The two human-readable lines. Checked for the correct hour AND against the
  // old one, because a stale "1PM KST" beside a corrected countdown is its own
  // bug — the page would be telling the reader two different times.
  const sub = (block.match(/<div class="cd-sub">([^<]*)</) || [])[1] || '';
  check(/8AM KST/.test(sub) && !/1PM KST|12AM EDT/.test(sub),
        'the card\'s sub-line names the real hour', sub.trim());
  const dateLine = (page.match(/dateLine: 'Out Oct 30, 2026[^']*'/) || [])[0] || '';
  check(/8AM KST/.test(dateLine) && !/1PM KST|12AM EDT/.test(dateLine),
        'the share card\'s date line names the real hour', dateLine);
}

console.log('\n--- the assets and the snippet are wired in');
{
  const page = readFileSync(root + 'index.html', 'utf8');
  for (const f of ['/strips/addicted-1.webp', '/strips/addicted-2.jpg', '/strips/addicted-3.jpg']) {
    check(page.includes(f), `${f} is on the page`);
    check(readFileSync(root + f.slice(1)).length > 1000, `${f} exists in the repo`);
  }
  check(/data-vid="rdPMdCzb5yg"/.test(page), 'the snippet is embedded');
  // The facade matters: no iframe until someone taps, so no third-party cookie
  // for a visitor who never watches it.
  check(!/youtube(-nocookie)?\.com\/embed\/rdPMdCzb5yg/.test(page),
        'and only as a click-to-play facade, not a live iframe');

  // Every picture the picker offers must declare whether it already carries the
  // lockup. A new one added without the flag would be drawn under a second copy
  // of the wordmark.
  const pics = page.match(/const ADDICTED_CARD_PICS = \[([\s\S]*?)\];/);
  check(!!pics, 'the share-card picker has a picture list');
  if (pics) {
    const rows = pics[1].split('\n').filter(l => l.includes('url:'));
    check(rows.length >= 2, `it offers ${rows.length} backgrounds`);
    check(rows.every(l => /hasLockup:\s*(true|false)/.test(l)),
          'and every one declares hasLockup',
          rows.filter(l => !/hasLockup:/.test(l)).join(' / '));
  }
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
