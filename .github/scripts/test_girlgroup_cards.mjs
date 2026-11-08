// The Girl Group Race share cards draw, and draw the right shape.
//
// Run: node .github/scripts/test_girlgroup_cards.mjs
//
// Three sections of girlgroups.html can be posted as a picture. They are
// REDRAWN rather than screenshotted, because the page is a dense table whose
// bars and right-hand numbers run off a phone's width — a crop loses exactly
// the part that makes it a race.
//
// What this pins, each of which was wrong at some point while building it:
//
//   · the page is ADMIN-GATED. It reads bu_admin_key from localStorage and
//     only fetches when one is there. Without it nothing loads, every card
//     returns early, and a test that only asked "did the function throw"
//     would call that a pass.
//   · a card must actually PAINT. An overlay that opens over a blank canvas
//     looks like a working feature and posts an empty rectangle.
//   · the height ADAPTS. Three tracks and seven groups are different amounts
//     of content; a fixed height left half the board empty, which reads as
//     missing data rather than as a short list.
//   · the catch-up card has THREE verdicts and only one is a date. A card
//     that only knew how to say "overtakes on DATE" would have to invent one
//     for the two cases that have no date, so all three are driven here.
//
// Nothing asserts a pixel colour or an exact height: those are design, and a
// test that pins them turns every visual change into a failure. What is
// pinned is that something was drawn, and that the card grew with its rows.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const T = { html:'text/html', js:'text/javascript', css:'text/css', json:'application/json',
            svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg', webp:'image/webp' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const b = await readFile(ROOT + (p === '/' ? '/index.html' : p));
    res.writeHead(200, { 'content-type': T[p.split('.').pop()] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const RACE = { asOf: '2026-11-07', groups: [
  { name:'TWICE',       ytd:3280000000, total:13051924359, gain:11200000, spanDays:1, exact:true },
  { name:'BLACKPINK',   ytd:3010000000, total:42310000000, gain:10400000, spanDays:1, exact:true,  gapToAbove:270000000 },
  { name:'ILLIT',       ytd:1420000000, total: 4120000000, daily:4900000,             exact:false, gapToAbove:1590000000 },
  { name:'NewJeans',    ytd:1180000000, total: 9880000000, gain:7600000, spanDays:2,  exact:true,  gapToAbove:240000000 },
  { name:'LE SSERAFIM', ytd: 980000000, total: 6210000000, daily:3300000,             exact:true,  gapToAbove:200000000 },
  { name:'aespa',       ytd: 910000000, total: 7440000000, daily:3100000,             exact:true,  gapToAbove: 70000000 },
  { name:'BABYMONSTER', ytd: 540000000, total: 1980000000, daily:2200000,             exact:true,  gapToAbove:370000000 }]};
const BOARD = { floor:500000000, done:[], tracks: [
  { trackId:'a', name:'Magnetic',  group:'ILLIT',       streams:889906032, toGo:110093968, daysLeft:190, elapsed:580, totalDays:770,  rate:580462, mergedWith:0, stale:false },
  { trackId:'b', name:'Super Shy', group:'NewJeans',    streams:940120000, toGo: 59880000, daysLeft: 96, elapsed:860, totalDays:956,  rate:622000, mergedWith:0, stale:false },
  { trackId:'c', name:'Smart',     group:'LE SSERAFIM', streams:812400000, toGo:187600000, daysLeft:410, elapsed:700, totalDays:1110, rate:457000, mergedWith:4, stale:true }]};

const browser = await chromium.launch();
const pg = await browser.newPage({ viewport:{ width:430, height:950 }, serviceWorkers:'block' });
const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.addInitScript(() => { try { localStorage.setItem('bu_admin_key', 'test-key'); } catch {} });
await pg.route('**/api/girlgroups**', r => r.fulfill({ status:200, contentType:'application/json',
  body: JSON.stringify(/view=1b/.test(r.request().url()) ? BOARD : RACE) }));

await pg.goto(base + '/girlgroups.html', { waitUntil:'load' });
await pg.waitForTimeout(2000);

console.log('--- the page loaded behind the gate');
const rows = await pg.evaluate(() => document.querySelectorAll('#list .row').length);
rows === RACE.groups.length
  ? ok('the race list rendered', `${rows} rows`)
  : bad('the race list rendered', `${rows} rows — without data every card returns early and proves nothing`);

// Did anything reach the canvas? Sampled rather than exhaustive: a blank card
// is uniformly the background, a drawn one is not.
const painted = () => pg.evaluate(() => {
  const c = document.getElementById('gc-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4 * 977) seen.add(`${d[i]},${d[i+1]},${d[i+2]}`);
  return { colours: seen.size, h: c.height, w: c.width };
});
const openCard = async (fn) => {
  const r = await pg.evaluate((f) => {
    try { window[f](); } catch (e) { return 'ERR: ' + e.message; }
    return document.getElementById('gc-ov').classList.contains('on');
  }, fn);
  if (r !== true) return { open:false, why:r };
  const p = await painted();
  await pg.evaluate(() => gcClose());
  return { open:true, ...p };
};

console.log('\n--- each card opens and paints');
const sizes = {};
for (const [fn, label, tab] of [
  ['shareRaceCard',    'Group race',  'race'],
  ['share1BCard',      'Road to 1B',  '1b'],
  ['shareCatchupCard', 'Catch-up',    'race'],
]) {
  await pg.evaluate((v) => { const b = document.querySelector(`.mode[data-view="${v}"]`); if (b) b.click(); }, tab);
  await pg.waitForTimeout(1200);
  const r = await openCard(fn);
  if (!r.open) { bad(`${label} opens`, typeof r.why === 'string' ? r.why : 'overlay never shown'); continue; }
  ok(`${label} opens`);
  r.colours > 6
    ? ok(`  and paints`, `${r.colours} distinct sampled colours, ${r.w}x${r.h}`)
    : bad(`  and paints`, `only ${r.colours} colours — the overlay opened over a blank canvas`);
  sizes[label] = r.h;
}

console.log('\n--- the card grows with its content');
sizes['Group race'] && sizes['Road to 1B'] && sizes['Group race'] > sizes['Road to 1B']
  ? ok('7 groups make a taller card than 3 tracks',
       `${sizes['Group race']}px vs ${sizes['Road to 1B']}px`)
  : bad('7 groups make a taller card than 3 tracks',
        `${sizes['Group race']}px vs ${sizes['Road to 1B']}px — a fixed height leaves the short card half empty`);

console.log('\n--- all three catch-up verdicts, not just the one with a date');
await pg.evaluate(() => { const b = document.querySelector('.mode[data-view="race"]'); if (b) b.click(); });
await pg.waitForTimeout(800);
for (const [ci, ti, label] of [[1, 0, 'overtakes on a date'], [1, 6, 'already ahead'], [6, 1, 'never closes']]) {
  const r = await pg.evaluate(([ci, ti]) => {
    const c = document.getElementById('cu-chaser'), t = document.getElementById('cu-target');
    if (!c.options[ci] || !t.options[ti]) return 'no such option';
    c.value = String(ci); t.value = String(ti);
    c.dispatchEvent(new Event('change')); t.dispatchEvent(new Event('change'));
    try { window.shareCatchupCard(); } catch (e) { return 'ERR: ' + e.message; }
    return document.getElementById('gc-ov').classList.contains('on');
  }, [ci, ti]);
  if (r !== true) { bad(`  ${label}`, typeof r === 'string' ? r : 'overlay never shown'); continue; }
  const p = await painted();
  await pg.evaluate(() => gcClose());
  p.colours > 6 ? ok(`  ${label}`, `${p.w}x${p.h}`)
                : bad(`  ${label}`, 'blank canvas');
}

if (errs.length) { console.log('\n  page errors: ' + errs.slice(0, 3).join(' | ')); fails += errs.length; }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll three cards draw.');
process.exit(fails ? 1 : 0);
