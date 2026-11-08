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
//   · a post is a picture AND a caption. The caption is COPIED and the sheet
//     gets the FILE ONLY, because Instagram, X and TikTok silently drop the
//     share `text` when a file rides along. Passing both looks right and
//     posts an image with an empty caption box.
//   · the race card's button lives OUTSIDE the block it belongs to (#list),
//     so nothing hid it when the view switched: "Share standings" sat above
//     the Road to 1B board and drew the race card there. A share control in
//     the wrong section is worse than none — it answers a question nobody
//     asked and looks like the section's own summary.
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
await pg.addInitScript(() => {
  try { localStorage.setItem('bu_admin_key', 'test-key'); } catch {}
  // Stand in for the two APIs the share path uses, and RECORD what they were
  // given. Headless Chromium has neither, so without these the share branch
  // under test is never the one that runs.
  window.__copied = null; window.__shared = null;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: t => { window.__copied = t; return Promise.resolve(); } },
  });
  navigator.canShare = () => true;
  navigator.share = p => {
    window.__shared = { keys: Object.keys(p), files: (p.files || []).map(f => f.name),
                        text: p.text == null ? null : String(p.text) };
    return Promise.resolve();
  };
});
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
  // The caption, read through the copy path rather than off an internal — what
  // matters is that the clipboard is what actually receives it.
  const text = await pg.evaluate(() => {
    window.__copied = null;
    try { window.gcCopyText(); } catch (e) { return 'ERR: ' + e.message; }
    return window.__copied;
  });
  await pg.evaluate(() => gcClose());
  return { open:true, text, ...p };
};

console.log('\n--- each card opens, paints, and carries its own caption');
const sizes = {}, texts = {};
// Something only THIS card's numbers could produce. A caption that is merely
// non-empty passes while every card copies the first one built.
const MUST = {
  'Group race':  ['TWICE', 'BLACKPINK', '3.28B'],
  'Road to 1B':  ['Magnetic', 'Super Shy', 'days left'],
  'Catch-up':    ['chasing', '/day'],
};
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

  const t = typeof r.text === 'string' && !r.text.startsWith('ERR:') ? r.text : '';
  t ? ok('  and copies a caption', `${t.split('\n').length} lines`)
    : bad('  and copies a caption', typeof r.text === 'string' ? r.text : 'nothing reached the clipboard');
  if (t) {
    texts[label] = t;
    const missing = MUST[label].filter(s => !t.includes(s));
    missing.length === 0
      ? ok('    with this card\'s own numbers in it')
      : bad('    with this card\'s own numbers in it', `missing ${missing.join(', ')}`);
    t.includes('blinksunited.com/girlgroups.html')
      ? ok('    and the link back')
      : bad('    and the link back', 'a screenshot with no source is unattributable');
  }
}

const seen = Object.values(texts);
new Set(seen).size === seen.length
  ? ok('each caption is distinct', `${seen.length} cards`)
  : bad('each caption is distinct', 'two cards copied the same text — _gcText is not being rebuilt');

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

console.log('\n--- the share sheet gets the file, and only the file');
const sh = await pg.evaluate(async () => {
  const b = document.querySelector('.mode[data-view="race"]'); if (b) b.click();
  window.__copied = null; window.__shared = null;
  try { window.shareRaceCard(); } catch (e) { return 'ERR: ' + e.message; }
  try { await window.gcShare(); } catch (e) { return 'ERR: ' + e.message; }
  try { gcClose(); } catch {}
  return { shared: window.__shared, copied: window.__copied };
});
if (typeof sh === 'string' || !sh.shared) {
  bad('navigator.share was called', typeof sh === 'string' ? sh : 'the share branch never ran');
} else {
  ok('navigator.share was called', sh.shared.files.join(', ') || 'no files');
  sh.shared.files.length === 1
    ? ok('  with the card as a file')
    : bad('  with the card as a file', `${sh.shared.files.length} files`);
  // The whole point. `text` alongside `files` is dropped by Instagram, X and
  // TikTok without a word, so the caption must not be sent that way.
  sh.shared.text === null && !sh.shared.keys.includes('text')
    ? ok('  and NO text riding along with it')
    : bad('  and NO text riding along with it',
          'Instagram, X and TikTok drop share text when a file is present — the caption would vanish');
  sh.copied
    ? ok('  while the caption went to the clipboard instead', `${sh.copied.split('\n').length} lines`)
    : bad('  while the caption went to the clipboard instead',
          'nothing was copied, so the sharer has the picture and no words');
}

console.log('\n--- the share button belongs to the section showing');
const vis = async (v) => pg.evaluate((v) => {
  const b = document.querySelector(`.mode[data-view="${v}"]`); if (b) b.click();
  const g = document.getElementById('gc-race'), o = document.getElementById('gc-1b');
  return { race: g ? !g.hidden : null, b1: o ? !o.hidden : null };
}, v);
const vRace = await vis('race');
await pg.waitForTimeout(1200);
const v1b = await vis('1b');
await pg.waitForTimeout(1200);
const v1bSettled = await pg.evaluate(() => {
  const g = document.getElementById('gc-race'), o = document.getElementById('gc-1b');
  return { race: g ? !g.hidden : null, b1: o ? !o.hidden : null };
});
vRace.race === true
  ? ok('Share standings shows on the group race')
  : bad('Share standings shows on the group race', 'the race has rows and no way to post them');
v1bSettled.race === false
  ? ok('  and is gone on Road to 1B')
  : bad('  and is gone on Road to 1B',
        'the race button sits above the 1B board and draws the race card — the wrong section\'s share');
v1b.race === false
  ? ok('  immediately, not after the 1B fetch resolves')
  : bad('  immediately, not after the 1B fetch resolves',
        'it lingers through the load, which is exactly when it gets tapped');
v1bSettled.b1 === true
  ? ok('  and Share board took its place')
  : bad('  and Share board took its place', 'the 1B board has rows and no way to post them');

if (errs.length) { console.log('\n  page errors: ' + errs.slice(0, 3).join(' | ')); fails += errs.length; }
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll three cards draw.');
process.exit(fails ? 1 : 0);
