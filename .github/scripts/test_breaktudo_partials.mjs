// Drive the real breaktudo.html and check the partial-rankings table and the
// shareable standings card against BreakTudo's published placements.
//
// Run: node .github/scripts/test_breaktudo_partials.mjs
//
// Two things here are easy to get wrong and invisible once shipped:
//
//  1. A placement typed into the wrong row. The table and the share card both
//     read PARTIALS, so a wrong number is wrong in both places and looks
//     perfectly plausible. Every cell of the latest partial is asserted against
//     the top 5s BreakTudo actually published.
//
//  2. The card falling behind the table. The table derives its columns from
//     PARTIALS.length and grew a third column on its own; the card's x's were
//     hard-coded for two and drew the 2nd and 3rd on top of each other. So the
//     card is rendered and its columns are read back off the canvas rather than
//     trusted.
//
// page.route() serves the real file at the real hostname so absolute /api and
// image paths resolve without DNS.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const PAGE = new URL('../../breaktudo.html', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

// BreakTudo's 3rd partial (published 5 Oct, votes to 4 Oct), by category, as
// positions among the five it listed. null = not in the top 5.
const THIRD = {
  'International Female Group':     3,   // BINI · BABYMONSTER · BLACKPINK · ITZY · TWICE
  'International Female Artist':    1,   // Jennie first
  'Asian Artist':                   2,   // BGYO · Lisa
  'International Collaboration':    3,   // Emoji · SPAGHETTI · Eyes Closed
  'International Hit of the Year':  2,   // SWIM · Dracula (JENNIE Remix)
  'International Fandom of the Year': null, // FreenBecky · ARMYS · Blooms · A'TIN · ENGENE
  'International Series':           1,   // Boyfriend on Demand first
};

const open = async (width) => {
  const p = await b.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/breaktudo' || u.pathname === '/breaktudo.html')
      return route.fulfill({ path: PAGE, contentType: 'text/html' });
    if (u.hostname.includes('fonts.g')) return route.continue();
    return route.fulfill({ status: 204, body: '' });
  });
  await p.goto('https://www.blinksunited.com/breaktudo', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#pr-table .pr-row');
  return { p, errs };
};

const { p, errs } = await open(1280);

console.log('--- the data');
const data = await p.evaluate(() => ({
  labels: PARTIALS.map(x => x.label),
  tos: PARTIALS.map(x => x.to),
  urls: PARTIALS.map(x => x.url),
  places: PARTIALS[PARTIALS.length - 1].places,
  prev: PARTIALS[PARTIALS.length - 2].places,
  noms: NOMS.map(n => ({ key: n.key, cat: n.cat, who: n.who })),
}));
check(data.labels.join(',') === '1st,2nd,3rd', `three partials, in order (${data.labels.join(', ')})`);
check(data.tos[2] === '4 Oct', `the newest covers votes to 4 Oct (${data.tos[2]})`);
check(data.urls.every(u => /^https:\/\/www\.breaktudoawards\.com\//.test(u)),
      'each partial links to the BreakTudo post it was read from');

// By CATEGORY, so a key renamed in NOMS cannot quietly pass.
for (const [cat, want] of Object.entries(THIRD)) {
  const keys = data.noms.filter(n => n.cat === cat).map(n => n.key);
  check(keys.length > 0, `NOMS still carries "${cat}"`);
  for (const k of keys) {
    const got = data.places[k];
    // Int. Music Video holds two nominees and is asserted separately below.
    check(got === want, `${cat} → ${want === null ? 'not top 5' : want} (got ${got === null ? 'not top 5' : got})`);
  }
}
check(data.places['mv-go'] === 3, `Int. Music Video: GO is 3rd (got ${data.places['mv-go']})`);
check(data.places['mv-dream'] === 5, `Int. Music Video: DREAM is 5th (got ${data.places['mv-dream']})`);
check(data.prev['mv-go'] === 4 && data.places['mv-go'] === 3,
      'GO climbed 4th → 3rd, the only movement in this partial');

console.log('\n--- the table');
// <b> is the CATEGORY and <small> is the nominee, not the other way round.
const rows = await p.evaluate(() => [...document.querySelectorAll('#pr-table .pr-row')].map(r => ({
  cat: r.querySelector('.pr-who b')?.textContent.trim(),
  who: r.querySelector('.pr-who small')?.textContent.trim(),
  pos: [...r.querySelectorAll('.pr-pos')].map(x => x.textContent.trim()),
  trend: r.querySelector('.pr-trend')?.textContent.trim(),
  alert: r.classList.contains('alert'),
})));
check(rows.length === 9, `nine nominee rows (${rows.length})`);
check(rows.every(r => r.pos.length === 3), 'every row shows all three partials');
const head = await p.evaluate(() =>
  [...document.querySelectorAll('#pr-table .pr-col')].map(x => x.textContent.trim()));
check(head.length === 3, `three column headers (${head.join(' | ')})`);
check(head[2].startsWith('3rd'), `the newest is headed 3rd (${head[2]})`);

// The header and every row are independent grids. With `auto` tracks each one
// sized itself to its own content, so the digit rows, the "Not top 5" row and
// the headers all put their columns in different places.
const align = await p.evaluate(() => {
  const mid = el => { const r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2); };
  const head = [...document.querySelectorAll('#pr-table .pr-col')].map(mid);
  const perRow = [...document.querySelectorAll('#pr-table .pr-row')]
    .map(r => [...r.querySelectorAll('.pr-pos')].map(mid));
  return { head, perRow, trend: [...document.querySelectorAll('#pr-table .pr-trend')].map(mid) };
});
check(align.perRow.every(r => r.every((x, i) => Math.abs(x - align.perRow[0][i]) <= 1)),
      'every row puts its three placements on the same three x positions');
check(align.head.every((x, i) => Math.abs(x - align.perRow[0][i]) <= 1),
      `and the column headers sit over them (${align.head.join(', ')} vs ${align.perRow[0].join(', ')})`);
check(align.trend.every(x => Math.abs(x - align.trend[0]) <= 1), 'the Move column lines up too');

const blinks = rows.find(r => /BLINK/i.test(r.who || ''));
check(blinks && blinks.alert && blinks.pos.every(x => /Not top 5/i.test(x)),
      'BLINKs are outside the top 5 in all three and the row is still pinned/flagged');
const go = rows.find(r => /“GO”/.test(r.who || ''));
check(go && go.trend.includes('▲'), `GO's row shows a climb (${go && go.trend})`);
check(rows.filter(r => r.trend && r.trend.includes('▲')).length === 1,
      'and it is the only ▲ on the table');

const scored = await p.evaluate(() => document.getElementById('pr-score').textContent.trim());
check(/8\/9|Ranking in 8/.test(scored) || /⚠/.test(scored),
      `the badge still warns about the category we are outside (${scored})`);
const srcs = await p.evaluate(() =>
  [...document.querySelectorAll('#pr-sources .pr-src')].map(a => a.textContent.trim()));
check(srcs.length === 3, `one source link per partial (${srcs.length})`);

console.log('\n--- the share card keeps up with the table');
// Draw it, then read the pixels: three distinct column positions, nothing
// overlapping, and the category text clear of the leftmost one.
// Recorded off the draw calls rather than scanned out of the pixels. A pixel
// scan merged the label band into the first column — it reported "no overlap"
// because it could not tell them apart, which is the one answer a collision
// test must never be able to give.
const card = await p.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1350;
  try { await document.fonts.ready; } catch (_) {}
  const ctx = c.getContext('2d');          // same object every call
  const calls = [];
  const fillText = ctx.fillText.bind(ctx);
  ctx.fillText = function (t, x, y) {
    calls.push({ t: String(t), x, y, align: ctx.textAlign, w: ctx.measureText(t).width });
    return fillText(t, x, y);
  };
  drawStandingsCard(c);
  return calls;
});

// Everything inside the 9 rows: y from 336 to 336+9*94.
const inRows = card.filter(c => c.y >= 336 && c.y < 336 + 9 * 94);
const cells = inRows.filter(c => c.align === 'center' && /^(\d|NOT TOP 5$)/.test(c.t));
const xs = [...new Set(cells.map(c => c.x))].sort((a, b) => a - b);
// 1080 wide, pad 62: the three columns land on 658 / 768 / 878 and Move on 994.
// Hard-coded here on purpose — deriving them from the page's own formula would
// assert the formula against itself, and the bug this catches was the 2nd and
// 3rd partials both drawing at 878.
check(xs.length === 3, `three distinct placement columns, none stacked (${xs.join(', ')})`);
check(xs.join(',') === '658,768,878', `and they are where the layout puts them (${xs.join(' / ')})`);
check(xs.every(x => cells.filter(c => c.x === x).length === 9),
      'each column carries all nine rows');
const moveCalls = inRows.filter(c => c.align === 'center' && !cells.includes(c));
check(moveCalls.length === 9 && moveCalls.every(c => c.x === 994),
      `the Move column is still at 994 and drawn once per row (${moveCalls.length} calls)`);

// No label may reach the leftmost column's left edge. Both are measured from
// the same render, so this holds however many partials there are.
const colLeft = Math.min(...cells.filter(c => c.x === xs[0]).map(c => c.x - c.w / 2));
const labels = inRows.filter(c => c.align === 'left');
const worst = labels.reduce((a, c) => Math.max(a, c.x + c.w), 0);
check(labels.length >= 18, `every row drew its category and nominee (${labels.length} lines)`);
check(worst < colLeft,
      `the widest label ends at ${Math.round(worst)}, clear of the column at ${Math.round(colLeft)}`);

console.log('\n--- it still fits a 360px phone');
await p.close();
const narrow = await open(360);
const fit = await narrow.p.evaluate(() => {
  const t = document.getElementById('pr-table');
  const rows = [...t.querySelectorAll('.pr-row')];
  return {
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    tableOverflow: t.scrollWidth - t.clientWidth,
    // Every row must still show a readable category name, not two characters
    // per line squeezed against the numbers.
    minLabel: Math.min(...rows.map(r => r.querySelector('.pr-who').getBoundingClientRect().width)),
    cells: rows.every(r => r.querySelectorAll('.pr-pos').length === 3),
  };
});
check(fit.docOverflow <= 1, `no horizontal page scroll at 360px (${fit.docOverflow}px)`);
check(fit.tableOverflow <= 1, `the table itself does not overflow (${fit.tableOverflow}px)`);
check(fit.cells, 'all three columns are present on the phone too');
check(fit.minLabel >= 90, `the narrowest category label still has room (${Math.round(fit.minLabel)}px)`);

check(errs.length === 0 && narrow.errs.length === 0,
      `no page errors (${[...errs, ...narrow.errs].join(' | ') || 'none'})`);

await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
