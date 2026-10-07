// Drive the real girlgroups.html Road to 1B card and check the chart.
//
// Run: node .github/scripts/test_road_to_1b_chart.mjs
//
// The fixture is REAL: four tracks straight out of /api/girlgroups?view=1b
// (probe run 37564299241), chosen because they are the four shapes the chart
// has to survive —
//
//   Magnetic           a big shift (-18 days), speeding up
//   OMG                a 3-day shift: the two rays nearly coincide, so the
//                      caption is the only thing that can carry it
//   Ditto              a 5-day shift, slowing
//   How You Like That  already past 1B, so the readings sit ABOVE the line and
//                      there is no arrival arithmetic at all
//
// The chart draws the climb against a 1B ceiling with a projection ray per
// pace. What is asserted is the part that was wrong before and is easy to
// regress: that gold means ONLY the finish line, that the legend names the two
// date ranges rather than asking the reader to decode "pace since", and that
// each ray lands where its own arithmetic says it should.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const PAGE = new URL('../../girlgroups.html', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

const series = (from, to, lo, hi, n = 25) => {
  const t0 = Date.parse(from + 'T00:00:00Z'), t1 = Date.parse(to + 'T00:00:00Z');
  return Array.from({ length: n }, (_, i) => ({
    d: new Date(t0 + (t1 - t0) * (i / (n - 1))).toISOString().slice(0, 10),
    s: Math.round(lo + (hi - lo) * (i / (n - 1))),
  }));
};
const TRACKS = [
  { group: 'ILLIT', name: 'Magnetic', streams: 893296009, rate: 578847.72,
    daysLeft: 185, totalDays: 1109, eta: '2027-04-08',
    trend: { early: 551661.15, late: 608299.83, earlyFrom: '2026-09-10',
             midAt: '2026-09-23', lateTo: '2026-10-05',
             daysAtEarly: 194, daysAtLate: 176, shift: -18 },
    series: series('2026-09-10', '2026-10-05', 878824816, 893296009) },
  { group: 'NewJeans', name: 'OMG', streams: 983656799, rate: 295370.44,
    daysLeft: 56, totalDays: 1428, eta: '2026-11-30',
    trend: { early: 302655.08, late: 287478.75, earlyFrom: '2026-09-10',
             midAt: '2026-09-23', lateTo: '2026-10-05',
             daysAtEarly: 54, daysAtLate: 57, shift: 3 },
    series: series('2026-09-10', '2026-10-05', 976272538, 983656799) },
  { group: 'NewJeans', name: 'Ditto', streams: 971222327, rate: 389848.32,
    daysLeft: 74, totalDays: 1460, eta: '2026-12-18',
    trend: { early: 402485.46, late: 376158.08, earlyFrom: '2026-09-10',
             midAt: '2026-09-23', lateTo: '2026-10-05',
             daysAtEarly: 72, daysAtLate: 77, shift: 5 },
    series: series('2026-09-10', '2026-10-05', 961476119, 971222327) },
  { group: 'BLACKPINK', name: 'How You Like That', streams: 1297280618, rate: 226738.8,
    daysLeft: null, totalDays: null, eta: null,
    trend: { early: 230099.92, late: 223097.58, earlyFrom: '2026-09-10',
             midAt: '2026-09-23', lateTo: '2026-10-05',
             daysAtEarly: null, daysAtLate: null, shift: null },
    series: series('2026-09-10', '2026-10-05', 1291612148, 1297280618) },
];

const p = await b.newPage({ viewport: { width: 412, height: 1200 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/*', async route => {
  const u = new URL(route.request().url());
  if (u.pathname.endsWith('/girlgroups') || u.pathname.endsWith('girlgroups.html'))
    return route.fulfill({ path: PAGE, contentType: 'text/html' });
  if (u.pathname === '/api/girlgroups')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      asOf: '2026-10-05', floor: 4e8,
      tracks: TRACKS.filter(t => t.eta), done: TRACKS.filter(t => !t.eta) }) });
  if (u.hostname.includes('fonts.g')) return route.continue();
  return route.fulfill({ status: 204, body: '' });
});
await p.goto('https://www.blinksunited.com/girlgroups', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);

// The chart lives behind the row expander, which has its own interactions. This
// test is about the chart, so it renders it directly from the page's own code.
await p.evaluate((tracks) => {
  const host = document.createElement('div');
  host.id = 'test-charts';
  document.body.appendChild(host);
  host.innerHTML = tracks.map(t => `<div class="card chartwrap">${_bChart(t)}</div>`).join('');
}, TRACKS);
await p.waitForTimeout(300);

const got = await p.$$eval('.chartwrap', els => els.map(el => {
  const svg = el.querySelector('svg.b-chart');
  const strokes = [...svg.querySelectorAll('[stroke]')].map(n => n.getAttribute('stroke'));
  const rays = [...svg.querySelectorAll('path[stroke]')]
    .filter(n => n.getAttribute('stroke') !== '#fff2f6')
    .map(n => ({ col: n.getAttribute('stroke'), d: n.getAttribute('d'),
                 dash: n.getAttribute('stroke-dasharray') || '' }));
  return {
    strokes,
    rays,
    dots: [...svg.querySelectorAll('circle[fill]')].map(n => n.getAttribute('fill')),
    gold: strokes.filter(s => s === '#f5c542').length,
    legend: [...el.querySelectorAll('.b-leg span')].map(n => n.textContent.trim()),
    legendCols: [...el.querySelectorAll('.b-leg i')].map(n => n.style.background),
    hairline: svg.innerHTML.includes('stroke-opacity="0.18"'),
    cap: el.querySelector('.b-cap')?.textContent.trim(),
    note: el.querySelector('.b-note')?.textContent.trim(),
    oneB: /1B/.test(svg.textContent),
  };
}));
console.log(`--- ${got.length} chart(s)`);
check(got.length === 4, `one per track (${got.length})`);
const [mag, omg, ditto, past] = got;

console.log('\n--- the 1B ceiling is back and is the point of the picture');
check(got.every(x => x.oneB), 'every chart labels the 1B line');
check(past.oneB, 'including the one already past it, which has to pull the line into view');

console.log('\n--- gold means the finish line, and nothing else');
// It used to be the 1B rule, the earlier pace AND a flagged reading at once.
check(mag.rays.every(r => r.col !== '#f5c542'),
      `no projection ray is gold (${mag.rays.map(r => r.col).join(', ')})`);
check(mag.rays.some(r => r.col === '#ff8fb4') && mag.rays.some(r => r.col === '#ff2e77'),
      'the two paces are the ordered pink pair — lighter is older');
check(mag.rays.find(r => r.col === '#ff8fb4').dash !== ''
      && mag.rays.find(r => r.col === '#ff2e77').dash === '',
      'and the older one is dashed, so they differ by more than hue');

console.log('\n--- the legend names the windows instead of asking for a decode');
check(!mag.legend.some(l => /pace since|pace to/.test(l)),
      `no "pace since" (${mag.legend.join(' · ')})`);
check(mag.legend.includes('09-10–09-23') && mag.legend.includes('09-23–10-05'),
      'both date ranges are spelled out');
check(mag.legend[0] === 'recorded' && mag.legend[mag.legend.length - 1] === '1B',
      'recorded first, 1B last');

console.log('\n--- each ray lands where its own arithmetic says');
// Faster pace -> fewer days -> crosses 1B further LEFT. Read the ray endpoints.
const endX = r => parseFloat(r.d.split('L')[1].trim().split(' ')[0]);
for (const [name, x, early, late] of [['Magnetic', mag, 194, 176],
                                      ['OMG', omg, 54, 57], ['Ditto', ditto, 72, 77]]) {
  const e = x.rays.find(r => r.col === '#ff8fb4'), l = x.rays.find(r => r.col === '#ff2e77');
  check((endX(e) > endX(l)) === (early > late),
        `${name}: the ${early > late ? 'recent' : 'earlier'} pace crosses first `
        + `(${endX(e).toFixed(1)} vs ${endX(l).toFixed(1)}px for ${early}d / ${late}d)`);
}
check(mag.hairline && omg.hairline, 'a hairline marks today, where recording stops');
check(mag.dots.includes('#fff2f6'), "and today's reading carries a dot");

console.log('\n--- the sentence carries what the rays cannot');
// On OMG the two rays are within a few pixels; the words are the only place the
// 3-day shift can actually be read.
check(/Speeding up/.test(mag.cap) && /56,639\/day/.test(mag.cap)
      && /18 days/.test(mag.cap), `Magnetic: ${mag.cap}`);
check(/Slowing/.test(omg.cap) && /15,176\/day/.test(omg.cap) && /3 days/.test(omg.cap),
      `OMG: ${omg.cap}`);
check(/Slowing/.test(ditto.cap) && /26,327\/day/.test(ditto.cap), `Ditto: ${ditto.cap}`);
check(Math.round(608299.83 - 551661.15) === 56639
      && Math.round(302655.08 - 287478.75) === 15176,
      'that gap is late minus early, not a new quantity');
check(/Already past 1B/.test(past.cap) && /slowing/.test(past.cap), `past 1B: ${past.cap}`);

console.log('\n--- the headline-date caveat is present but subordinate');
check(!/106\.70M/.test(mag.cap) && /106\.70M/.test(mag.note),
      'the distance sits on the dim line, not in the verdict');
check(/averages the whole window/.test(mag.note) && /Apr 8, 2027/.test(mag.note),
      `and it names the card's own date: ${mag.note}`);
check(past.note === undefined, 'a track past 1B has no date to caveat');

console.log('\n--- layout');
const of = await p.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(of <= 1, `no horizontal overflow at 412px (${of}px)`);
check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);

await p.screenshot({ path: '/tmp/road-to-1b.png', fullPage: true }).catch(() => {});
await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
