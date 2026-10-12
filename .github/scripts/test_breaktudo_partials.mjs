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
import { readFileSync } from 'node:fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const PAGE = new URL('../../breaktudo.html', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

// BreakTudo's 4th and FINAL partial (published 11 Oct, votes to 10 Oct). A
// special edition listing all eight places per category instead of five, so a
// nominee can be listed and still outside the top 5 — which is new, and is the
// thing most likely to be got wrong.
const FOURTH = {
  'International Female Group':     2,   // BINI · BLACKPINK · BABYMONSTER · ITZY · TWICE · ILLIT · KATSEYE · FLO
  'International Female Artist':    1,   // Jennie first
  'Asian Artist':                   2,   // BGYO · Lisa
  'International Collaboration':    3,   // Emoji · SPAGHETTI · Eyes Closed
  'International Hit of the Year':  2,   // SWIM · Dracula (JENNIE Remix)
  'International Fandom of the Year': 6, // FreenBecky · ARMYS · Blooms · A'TIN · ENGENE · Blinks
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
  depths: PARTIALS.map(x => x.depth),
  noms: NOMS.map(n => ({ key: n.key, cat: n.cat, who: n.who })),
}));
check(data.labels.join(',') === '1st,2nd,3rd,4th', `four partials, in order (${data.labels.join(', ')})`);
check(data.tos[3] === '10 Oct', `the newest covers votes to 10 Oct (${data.tos[3]})`);
check(data.depths.join(',') === '5,5,5,8',
      `the final one published eight places, the rest five (${data.depths.join(',')})`);
check(data.urls.filter(Boolean).every(u => /^https:\/\/www\.breaktudoawards\.com\//.test(u)),
      'every partial that carries a source link points at BreakTudo');

// By CATEGORY, so a key renamed in NOMS cannot quietly pass.
for (const [cat, want] of Object.entries(FOURTH)) {
  const keys = data.noms.filter(n => n.cat === cat).map(n => n.key);
  check(keys.length > 0, `NOMS still carries "${cat}"`);
  for (const k of keys) {
    const got = data.places[k];
    // Int. Music Video holds two nominees and is asserted separately below.
    check(got === want, `${cat} → ${want === null ? 'not top 5' : want} (got ${got === null ? 'not top 5' : got})`);
  }
}
check(data.places['mv-go'] === 1, `Int. Music Video: GO is 1st (got ${data.places['mv-go']})`);
check(data.places['mv-dream'] === 5, `Int. Music Video: DREAM is 5th (got ${data.places['mv-dream']})`);
check(data.prev['mv-go'] === 3 && data.places['mv-go'] === 1, 'GO climbed 3rd → 1st');
check(data.prev['group'] === 3 && data.places['group'] === 2, 'BLACKPINK climbed 3rd → 2nd');
// The one that is NOT a climb, and the whole reason depth exists.
check(data.prev['fandom'] === null && data.places['fandom'] === 6,
      'BLINKs were off the top 5 and are 6th of 8 — more detail, not movement');

// The closing time, in the three places breaktudo.html states it and against
// the one index.html gates the award tab on. They disagreed by six minutes —
// the campaign card's countdown hit zero while the tab was still open — and a
// deadline is the one number on this page that costs a vote when it is wrong.
console.log('\n--- the deadline agrees with itself');
const when = await p.evaluate(() => ({
  deadline: DEADLINE,
  rule: RULES.find(r => /Voting runs to/.test(r)),
  reset: document.getElementById('reset-note') ? document.getElementById('reset-note').textContent : document.body.innerText,
}));
// 2026-10-17 23:59 BRT (UTC-3) = 2026-10-18 02:59 UTC.
check(when.deadline === Date.parse('2026-10-18T02:59:00Z'),
      `the countdown ends 17 Oct 23:59 Brasília (${new Date(when.deadline).toISOString()})`);
check(/23:59 BRT/.test(when.rule || ''), `the rules say the same time (${when.rule})`);
check(/23:59/.test(when.reset) && !/23:53/.test(when.reset),
      'and so does the line under the countdown');
// And the OTHER file. index.html carries the same deadline twice — the campaign
// card's countdown and the gate that closes the award tab — and that is where
// the six minutes came from: one said 02:53Z, the other 02:59Z, in the same
// document, with nothing comparing them.
const idx = readFileSync(new URL('../../index.html', import.meta.url).pathname, 'utf8');
const stamps = [...idx.matchAll(/2026-10-18T02:\d\d:00Z/g)].map(m => m[0]);
check(stamps.length >= 2 && stamps.every(x => x === '2026-10-18T02:59:00Z'),
      `index.html states the BreakTudo close once and once only: ${[...new Set(stamps)].join(', ')}`);
check(!/23:53/.test(idx), 'and no 23:53 survives anywhere in it');

console.log('\n--- the table');
// <b> is the CATEGORY and <small> is the nominee, not the other way round.
const rows = await p.evaluate(() => [...document.querySelectorAll('#pr-table .pr-row')].map(r => ({
  cat: r.querySelector('.pr-who b')?.textContent.trim(),
  who: r.querySelector('.pr-who small')?.textContent.trim(),
  pos: [...r.querySelectorAll('.pr-pos')].map(x => x.textContent.trim()),
  trend: r.querySelector('.pr-trend')?.textContent.trim(),
  need: r.querySelector('.pr-need')?.textContent.trim(),
  alert: r.classList.contains('alert'),
})));
check(rows.length === 9, `nine nominee rows (${rows.length})`);
check(rows.every(r => r.pos.length === 4), 'every row shows all four partials');
const head = await p.evaluate(() =>
  [...document.querySelectorAll('#pr-table .pr-col')].map(x => x.textContent.trim()));
check(head.length === 4, `four column headers (${head.join(' | ')})`);
check(head[3].startsWith('4th'), `the newest is headed 4th (${head[3]})`);

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
      'every row puts its four placements on the same four x positions');
check(align.head.every((x, i) => Math.abs(x - align.perRow[0][i]) <= 1),
      `and the column headers sit over them (${align.head.join(', ')} vs ${align.perRow[0].join(', ')})`);
check(align.trend.every(x => Math.abs(x - align.trend[0]) <= 1), 'the Move column lines up too');

// BLINKs: listed at last, and still outside the five. The row has to stay
// pinned and flagged — a 6th place is not good news just because it is a
// number — and the flag has to stop saying "Not ranking", which is now false.
const blinks = rows.find(r => /BLINK/i.test(r.who || ''));
check(blinks && blinks.alert, 'the BLINKs row is still pinned and flagged');
check(blinks && blinks.pos.slice(0, 3).every(x => /Not top 5/i.test(x)) && blinks.pos[3] === '6',
      `three "Not top 5" then a 6 (${blinks && blinks.pos.join(' · ')})`);
check(blinks && /6th of 8/i.test(blinks.need || '') && !/not ranking/i.test(blinks.need || ''),
      `and it reads as 6th of 8, not "not ranking" (${blinks && blinks.need})`);
// The claim this whole change exists to avoid.
check(blinks && !/▲/.test(blinks.trend || ''),
      `BLINKs show no climb — a deeper list is not movement (${blinks && blinks.trend})`);

const go = rows.find(r => /“GO”/.test(r.who || ''));
check(go && go.trend.includes('▲'), `GO's row shows a climb (${go && go.trend})`);
check(go && go.pos[3] === '1', `GO is 1st in the final partial (${go && go.pos[3]})`);
const grp = rows.find(r => /^BLACKPINK$/.test(r.who || ''));
check(grp && grp.trend.includes('▲'), `BLACKPINK's row shows a climb (${grp && grp.trend})`);
check(rows.filter(r => r.trend && r.trend.includes('▲')).length === 2,
      'two climbs on the table, and only two');

const scored = await p.evaluate(() => document.getElementById('pr-score').textContent.trim());
// "Top 5 in 7/8": we are listed in all eight now, so a badge counting "ranking"
// would read ✓ and call a 6th place good news.
check(/Top 5 in 7\/8/.test(scored) && /⚠/.test(scored),
      `the badge counts top-5 placements, not listings (${scored})`);
const srcs = await p.evaluate(() =>
  [...document.querySelectorAll('#pr-sources .pr-src')].map(a => a.textContent.trim()));
check(srcs.length === 3, `a source link for each partial that has one (${srcs.length})`);

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
check(xs.length === 4, `four distinct placement columns, none stacked (${xs.join(', ')})`);
check(xs.join(',') === '548,658,768,878', `and they are where the layout puts them (${xs.join(' / ')})`);
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

// THE CARD AND THE PAGE MUST SAY THE SAME THING. They each used to compute the
// headline badge from the data, and the card's copy was left behind when the
// rule changed: it drew "✓ RANKING IN ALL 8" — a tick, in green — above a row
// reading "6th of 8 — votes needed here". The card is the thing that gets
// screenshotted into a group chat, so it is the worse of the two to be wrong.
const cardBadge = card.find(c => /TOP 5 IN|RANKING IN/.test(c.t));
const pageBadge = await p.evaluate(() => document.getElementById('pr-score').textContent.trim());
check(cardBadge && /TOP 5 IN 7\/8/.test(cardBadge.t),
      `the card's badge counts top-5 placements (${cardBadge && cardBadge.t})`);
check(cardBadge && cardBadge.t.replace(/\s+/g, ' ').toUpperCase().replace('⚠ ', '')
        === pageBadge.replace(/\s+/g, ' ').toUpperCase().replace('⚠ ', ''),
      `and it is the same sentence the page shows (${cardBadge && cardBadge.t} vs ${pageBadge})`);
// BLINKs on the card: the number, flagged, and no invented climb.
const six = card.filter(c => c.t === '6');
check(six.length === 1, `BLINKs' 6 is drawn once on the card (${six.length})`);
check(card.some(c => /6TH OF 8/.test(c.t)), 'with the 6th-of-8 warning under it');
check(!card.some(c => /\u25B2 IN/.test(c.t)), 'and no "▲ IN" anywhere — a deeper list is not movement');
check(worst < colLeft,
      `the widest label ends at ${Math.round(worst)}, clear of the column at ${Math.round(colLeft)}`);

// 360px was the only width this checked, and 360px was never the problem: a
// fourth column collapsed the category name to 6px at 430 and 76px at 500,
// where no narrow rule applied at all. Every width the table is read at now has
// to leave the name room.
console.log('\n--- and every width in between');
await p.close();
for (const w of [320, 430, 500, 560, 700, 900]) {
  const q = await open(w);
  const m = await q.p.evaluate(() => {
    const t = document.getElementById('pr-table');
    const rows = [...t.querySelectorAll('.pr-row')];
    return {
      over: Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth,
                     t.scrollWidth - t.clientWidth),
      min: Math.round(Math.min(...rows.map(r => r.querySelector('.pr-who').getBoundingClientRect().width))),
    };
  });
  // 320px is the floor: four columns and a Move leave it tight whatever we do,
  // and it was 75px with three.
  const want = w <= 320 ? 65 : 95;
  check(m.over <= 1 && m.min >= want,
        `at ${w}px the category name keeps ${m.min}px and nothing overflows (${m.over}px)`);
  await q.p.close();
}

console.log('\n--- it still fits a 360px phone');
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
    cells: rows.every(r => r.querySelectorAll('.pr-pos').length === 4),
  };
});
check(fit.docOverflow <= 1, `no horizontal page scroll at 360px (${fit.docOverflow}px)`);
check(fit.tableOverflow <= 1, `the table itself does not overflow (${fit.tableOverflow}px)`);
check(fit.cells, 'all four columns are present on the phone too');
check(fit.minLabel >= 90, `the narrowest category label still has room (${Math.round(fit.minLabel)}px)`);

check(errs.length === 0 && narrow.errs.length === 0,
      `no page errors (${[...errs, ...narrow.errs].join(' | ') || 'none'})`);

await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
