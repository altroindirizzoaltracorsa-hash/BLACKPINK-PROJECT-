// Drive the real girlgroups.html Road to 1B card and check the chart.
//
// Run: node .github/scripts/test_road_to_1b_chart.mjs
//
// The fixture is REAL: four tracks straight out of /api/girlgroups?view=1b
// (probe run 37564299241), chosen because they are the four shapes the chart
// has to survive —
//
//   Magnetic           a big shift (-18 days), the case the old chart drew least badly
//   OMG                a 3-day shift: the old chart drew both projections as ONE line,
//                      so the caption's "3 days further" had nothing behind it
//   Ditto              a 5-day shift, slowing
//   How You Like That  already past 1B, so there is no arrival arithmetic at all
//
// What is actually asserted is that the picture agrees with the arithmetic: the
// bar lengths are in the same ratio as the rates, the days under each bar are
// the ones trendOf computed, and the faster pace is the one with the nearer date.
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

const open = async (width) => {
  const p = await b.newPage({ viewport: { width, height: 1200 }, deviceScaleFactor: 2 });
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
  return { p, errs };
};

const { p, errs } = await open(412);

// The chart lives behind the row's expander, so open every row first.
const opened = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('[onclick*="_bToggle"], .brow, .b-row')];
  rows.forEach(r => { try { r.click(); } catch {} });
  return document.querySelectorAll('.b-panel').length;
});
if (!opened) {
  // Fall back to calling the renderer directly — the point of this test is the
  // chart, not the expander, and the expander has its own interactions.
  await p.evaluate((tracks) => {
    const host = document.createElement('div');
    host.id = 'test-charts';
    document.body.appendChild(host);
    host.innerHTML = tracks.map(t => `<div class="card">${_bChart(t)}</div>`).join('');
  }, TRACKS);
}
await p.waitForTimeout(300);

const panels = await p.$$eval('.b-panel', els => els.map(el => ({
  sparks: el.querySelectorAll('.b-spark').length,
  paths: el.querySelectorAll('.b-spark path').length,
  bars: [...el.querySelectorAll('.b-pbar i')].map(i => ({
    pct: parseFloat(i.style.width), col: i.style.background,
    px: i.getBoundingClientRect().width,
  })),
  rates: [...el.querySelectorAll('.b-prate')].map(e => e.textContent.trim()),
  days: [...el.querySelectorAll('.b-pdays')].map(e => e.textContent.trim()),
  cap: el.querySelector('.b-cap')?.textContent.trim(),
  legend: el.querySelectorAll('.b-leg').length,
})));

console.log(`--- ${panels.length} chart(s) rendered`);
check(panels.length === 4, `one per track (${panels.length})`);

const [mag, omg, ditto, past] = panels;

console.log('\n--- the climb is on its own scale, not under a 1B ceiling');
check(panels.every(x => x.sparks === 1 && x.paths === 2),
      'every card draws the recorded line and its area fill');
check(panels.every(x => x.legend === 0),
      'and no legend box — one series, and the bars are direct-labelled');

console.log('\n--- the bars are proportional to the rates, from zero');
// Magnetic: 551,661 vs 608,300 -> the earlier bar must be 90.7% of the later.
const ratio = (a, b) => a / b;
check(Math.abs(ratio(mag.bars[0].pct, mag.bars[1].pct) - ratio(551661, 608300)) < 0.01,
      `Magnetic's bars are in the rates' ratio, 0.907 (${(mag.bars[0].pct / mag.bars[1].pct).toFixed(3)})`);
check(mag.bars[1].pct === 100, 'the faster pace sets the scale');
check(Math.abs(ratio(omg.bars[1].pct, omg.bars[0].pct) - ratio(287478.75, 302655.08)) < 0.01,
      `OMG's slower recent pace draws SHORTER (${omg.bars[1].pct} vs ${omg.bars[0].pct})`);
// This is the case the old chart could not show at all: a 3-day shift drew as
// one line. Here it is a visible difference in bar length.
check(omg.bars[0].px - omg.bars[1].px > 4,
      `and the difference is ${(omg.bars[0].px - omg.bars[1].px).toFixed(1)}px of real estate, `
      + 'not the single overlapping line the old chart drew');

console.log('\n--- the numbers under the bars are the ones trendOf computed');
check(mag.rates[0].startsWith('+551,661') && mag.rates[1].startsWith('+608,300'),
      `Magnetic: ${mag.rates.join(' / ')}`);
check(mag.days[0].includes('194 days') && mag.days[1].includes('176 days'),
      `and its two arrival dates: ${mag.days.join(' · ')}`);
check(/Apr 17, 2027/.test(mag.days[0]) && /Mar 30, 2027/.test(mag.days[1]),
      'dated from the last reading, not from today');
check(omg.days[0].includes('54 days') && omg.days[1].includes('57 days'),
      `OMG: ${omg.days.join(' · ')}`);
check(ditto.days[0].includes('72 days') && ditto.days[1].includes('77 days'),
      `Ditto: ${ditto.days.join(' · ')}`);

console.log('\n--- the faster pace always has the nearer date');
for (const [name, x] of [['Magnetic', mag], ['OMG', omg], ['Ditto', ditto]]) {
  const d = x.days.map(s => parseInt(s.match(/(\d[\d,]*) days/)[1].replace(/,/g, ''), 10));
  const r = x.bars.map(bb => bb.pct);
  const consistent = (r[0] > r[1]) === (d[0] < d[1]);
  check(consistent, `${name}: longer bar ↔ fewer days (${r.join('/')}% → ${d.join('/')}d)`);
}

console.log('\n--- past 1B has no arrival arithmetic');
check(past.bars.length === 2 && past.days.length === 0,
      `two paces, no days (${past.bars.length} bars, ${past.days.length} day lines)`);
check(/Already past 1B/.test(past.cap) && /slowing/.test(past.cap),
      `and says so: "${past.cap}"`);

console.log('\n--- the sentence still matches the picture');
check(/18 days closer/.test(mag.cap) && /106\.70M/.test(mag.cap), `Magnetic: ${mag.cap}`);
check(/3 days further/.test(omg.cap), `OMG: ${omg.cap}`);

console.log('\n--- phone layout');
const of = await p.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(of <= 1, `no horizontal overflow at 412px (${of}px)`);
check(panels.every(x => x.bars.every(bb => bb.px > 8)),
      'every bar is wide enough to see');
check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);

await p.screenshot({ path: '/tmp/road-to-1b.png', fullPage: true }).catch(() => {});
await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
