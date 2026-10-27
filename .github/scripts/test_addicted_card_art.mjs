// The ADDICTED share card's background, and the two shapes it is drawn in.
//
// Run: node .github/scripts/test_addicted_card_art.mjs
//
// One of the pictures comes in two cuts: a 3:4 portrait and the official 16:9
// wide. The card picks between them by the shape it is drawing, because
// cropping either one into the other frame throws away something the picture
// is for — the portrait cropped to 16:9 loses her face, and the wide cropped
// to a square loses the lockup. They share ONE thumbnail, so nothing on the
// page tells a reader which file they are looking at.
//
// That is why this is measured rather than read off the state. Every way it
// breaks leaves a card that looks finished:
//
//   * The wide cut never reaching the canvas — landscape silently falls back
//     to the portrait, which crops to her shoulder.
//   * The wide cut STAYING after the reader picks a different background. The
//     previous pick's photograph under the new one's lockup setting is the
//     worst of the three, and the only clue is that the card looks wrong to
//     somebody who knows the photographs.
//   * The format switch redrawing before the file it needs has loaded, which
//     shows the old shape until something else happens to redraw.
//
// So the two files are REPLACED with flat colours for the duration, and the
// canvas is sampled. That tests which file reached the picture rather than
// which URL was assigned to a variable, and it cannot be fooled by the two
// photographs looking alike.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
  woff2: 'font/woff2', mp4: 'video/mp4' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/sw.js') { res.writeHead(404); res.end(''); return; }
  const f = p === '/' ? '/index.html' : p;
  try {
    const b = await readFile(ROOT + f);
    res.writeHead(200, { 'content-type': TYPES[f.split('.').pop()] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// A flat image of a given size and colour, made here rather than kept as a
// fixture file — a fixture would be one more thing to keep in step.
const solid = (w, h, rgb) => {
  const png = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = solid._t || (solid._t = (() => { const t = [];
      for (let n = 0; n < 256; n++) { let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
      return t; })());
    let c = 0xFFFFFFFF;
    for (const b of body) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xFFFFFFFF) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const zlib = require('node:zlib');
  png.push(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  png.push(chunk('IHDR', ihdr));
  png.push(chunk('IDAT', zlib.deflateSync(raw)));
  png.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(png);
};
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

const WIDE = [255, 0, 255];   // what the landscape card must be made of
const TALL = [0, 255, 0];     // and the square one

const browser = await chromium.launch();
const errs = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => { try {
  localStorage.setItem('bu_tutorial_seen', '1');
  localStorage.setItem('ext_update_dismissed_1.9.8', '1');
} catch (e) {} });

console.log('--- the picker declares its files, and they are all there');
let PICS = [];
{
  const src = await readFile(ROOT + '/index.html', 'utf8');
  const block = (src.match(/const ADDICTED_CARD_PICS = \[([\s\S]*?)\];/) || [])[1] || '';
  check(!!block, 'found ADDICTED_CARD_PICS');
  PICS = [...block.matchAll(/\{\s*url:\s*'([^']+)'[^}]*?hasLockup:\s*(true|false)[^}]*?\}/g)]
    .map((m, i) => ({ url: m[1], hasLockup: m[2] === 'true',
                      wide: (m[0].match(/wide:\s*'([^']+)'/) || [])[1] || null }));
  check(PICS.length >= 4, `${PICS.length} backgrounds offered`);
  for (const p of PICS) {
    for (const f of [p.url, p.wide].filter(Boolean)) {
      let size = 0;
      try { size = (await stat(ROOT + f)).size; } catch {}
      check(size > 1000, `${f} exists`, `${Math.round(size / 1024)}KB`);
    }
  }
  const wides = PICS.filter((p) => p.wide);
  check(wides.length >= 1, 'at least one has a wide cut, so the rest of this means something',
        wides.map((p) => p.url).join(', '));
}
const WITH = PICS.find((p) => p.wide);
const WITHOUT = PICS.find((p) => !p.wide && p.url !== WITH.url);

// Both files replaced by flat colour. Everything below samples the canvas.
await page.route('**' + WITH.wide, (r) => r.fulfill({ contentType: 'image/png', body: solid(1920, 1080, WIDE) }));
await page.route('**' + WITH.url,  (r) => r.fulfill({ contentType: 'image/png', body: solid(1088, 1440, TALL) }));

await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.evaluate(() => openAddictedCard());
await page.waitForTimeout(2500);

// The share of a canvas made of one flat colour. Sampled off the left edge,
// which no card draws type over, and down the middle of the height.
const share = (rgb) => page.evaluate((want) => {
  const c = document.getElementById('card-canvas');
  const g = c.getContext('2d');
  const x0 = Math.round(c.width * 0.02), w = Math.round(c.width * 0.16);
  const y0 = Math.round(c.height * 0.3), h = Math.round(c.height * 0.2);
  const d = g.getImageData(x0, y0, w, h).data;
  let hit = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - want[0]) < 60 && Math.abs(d[i+1] - want[1]) < 60 && Math.abs(d[i+2] - want[2]) < 60) hit++;
  }
  return Math.round(hit / (d.length / 4) * 100);
}, rgb);

console.log('\n--- landscape is drawn from the wide cut');
await page.evaluate((u) => setCardFormat('landscape', document.getElementById('fmt-landscape')) , null);
await page.evaluate((u) => selectAddictedCardArt(u), WITH.url);
await page.waitForTimeout(2000);
{
  const size = await page.evaluate(() => { const c = document.getElementById('card-canvas'); return [c.width, c.height]; });
  check(size[0] > size[1], 'the canvas really is landscape', size.join('x'));
  const w = await share(WIDE), t = await share(TALL);
  check(w > 80, 'and the picture on it is the wide file', `${w}% wide, ${t}% tall`);
}

console.log('\n--- the square is drawn from the portrait, after only a format switch');
// No reselect: the switch redraws synchronously, so both files have to be in
// hand already. Fetching on the switch would redraw before the file arrived.
await page.evaluate(() => setCardFormat('square', document.getElementById('fmt-square')));
await page.waitForTimeout(900);
{
  const size = await page.evaluate(() => { const c = document.getElementById('card-canvas'); return [c.width, c.height]; });
  check(size[0] === size[1], 'the canvas really is square', size.join('x'));
  const w = await share(WIDE), t = await share(TALL);
  check(t > 80, 'and the picture on it is the portrait', `${t}% tall, ${w}% wide`);
}

console.log('\n--- and the wide cut does not survive a different background');
// The leak. photoWide has to be CLEARED by a pick that has no wide cut, not
// left behind — otherwise the next landscape card shows the previous
// photograph, which is the one failure here with no visible symptom at all.
await page.evaluate(() => setCardFormat('landscape', document.getElementById('fmt-landscape')));
await page.waitForTimeout(400);
await page.evaluate((u) => selectAddictedCardArt(u), WITHOUT.url);
await page.waitForTimeout(2000);
{
  const w = await share(WIDE), t = await share(TALL);
  check(w < 20 && t < 20, `picking ${WITHOUT.url} leaves neither cut on the canvas`,
        `${w}% wide, ${t}% tall`);
  const state = await page.evaluate(() => ({
    wide: !!(_presaveCardData && _presaveCardData.photoWide),
    lockup: !!(_presaveCardData && _presaveCardData.artHasLockup),
    title: !!(_presaveCardData && _presaveCardData.titleImg),
  }));
  check(state.wide === false, 'and the card is holding no wide cut at all');
  // The rule this picker was built for, still true: a background that already
  // has the wordmark printed on it must not get another drawn over it, and one
  // that does not must.
  check(state.lockup === WITHOUT.hasLockup, 'the lockup flag follows the pick');
  check(state.title === !WITHOUT.hasLockup, 'and the drawn wordmark follows the flag');
}

console.log('\n--- the Early Supporter pill keeps off a picture that says so');
// It is drawn top-right. On the star-dress portrait that corner is her face,
// and the pill landed across her mouth — a card that is correct, legible and
// ruined, with nothing in the code able to know, because nothing here can see
// a face. The picture declares the corner instead.
//
// Found by looking at a real card on a phone, not by anything here, so what
// this holds is the rule that came out of it: a background that asks for the
// corner to be left alone gets the pill stacked under the wordmark on the
// left, and every other background keeps it exactly where it was.
{
  const PILL = [182, 163, 255];                       // ADDICTED's stampPill
  // Where the pill actually landed, found by its own colour on the canvas.
  // Reading the coordinates back out of the drawing code would only agree
  // with itself.
  // Scanned over the TOP BAND only. The card's own type — "I PRE-SAVED", the
  // pre-save line — is drawn in the same purple, so a scan of the whole canvas
  // returns a box spanning the pill and the text under it, and reports the
  // pill as reaching three quarters of the way across when it does not. The
  // question here is only where the pill sits in the top band.
  const box = () => page.evaluate((want) => {
    const c = document.getElementById('card-canvas');
    const band = Math.round(c.height * 0.3);
    const d = c.getContext('2d').getImageData(0, 0, c.width, band).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i]-want[0]) < 18 && Math.abs(d[i+1]-want[1]) < 18 && Math.abs(d[i+2]-want[2]) < 18) {
        const p = (i / 4) | 0, x = p % c.width, y = (p / c.width) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; n++;
      }
    }
    return n < 200 ? null : { x0: x0/c.width, x1: x1/c.width, y0: y0/c.height, y1: y1/c.height, n };
  }, PILL);

  for (const [url, fmt, stacked] of [
    [WITH.url,    'square',    true],
    [WITH.url,    'landscape', true],
    [WITHOUT.url, 'square',    false],
  ]) {
    await page.unroute('**' + WITH.url).catch(() => {});
    await page.unroute('**' + WITH.wide).catch(() => {});
    await page.evaluate((f) => setCardFormat(f, document.getElementById('fmt-' + f)), fmt);
    await page.evaluate((u) => selectAddictedCardArt(u), url);
    await page.waitForTimeout(1500);
    // The card only draws the pill once the viewer has actually earned it.
    await page.evaluate(() => { _presaveCardData.earned = true;
      drawPresaveCard(document.getElementById('card-canvas'), _presaveCardData); });
    await page.waitForTimeout(400);
    const b = await box();
    const name = `${url.split('/').pop()} ${fmt}`;
    check(!!b, `${name}: the pill is on the card`, b ? `${b.n}px` : 'not found');
    if (!b) continue;
    check(b.x0 >= 0 && b.x1 <= 1 && b.y0 >= 0 && b.y1 <= 1, `${name}: and wholly inside it`);
    if (stacked) {
      // The corner it was asked to leave alone, and the row it was asked to
      // take instead. Checked as geometry rather than as a flag, because the
      // flag being read is not the thing that was wrong.
      check(b.x1 < 0.55, `${name}: it stays out of the right half`, `right edge ${Math.round(b.x1*100)}%`);
      check(b.y0 > 0.09, `${name}: and sits below the wordmark row`, `top ${Math.round(b.y0*100)}%`);
    } else {
      check(b.x1 > 0.8, `${name}: it is still in the top-right`, `right edge ${Math.round(b.x1*100)}%`);
    }
  }
}

console.log('\n--- nothing threw');
check(errs.length === 0, 'no page errors', errs.join(' | '));

await browser.close();
server.close();
console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
