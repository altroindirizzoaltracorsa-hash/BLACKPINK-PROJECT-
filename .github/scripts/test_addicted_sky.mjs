// The ADDICTED card's sky, measured rather than read off the source.
//
// Run: node .github/scripts/test_addicted_sky.mjs
//
// Every way this breaks is a card that still looks finished in a screenshot:
// a renamed handler and the sky is a photograph, a bolt that never leaves
// opacity 0 and the touch does nothing, a logo whose transform never moves
// and the "push it around" is gone. So nothing here reads the markup or the
// script — it dispatches pointer events at the sky and samples what the
// browser actually renders.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = p === '/' ? '/index.html' : SPA.test(p) ? '/index.html' : p;
  try {
    const b = await readFile(ROOT + file); const e = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
      webp: 'image/webp', glb: 'model/gltf-binary', mp4: 'video/mp4' }[e] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(r => server.listen(0, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1');
  localStorage.setItem('ltal_reminder_dismissed_v1', '1'); localStorage.setItem('ext_update_dismissed_1.9.7', '1'); } catch (e) {} });
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForTimeout(1500);

// Helper, run in the page: every measurement needs the sky's rect, and a
// sky that is not laid out would make every assertion below vacuously true.
const geom = await page.evaluate(() => {
  const sky = document.querySelector('[data-addicted-sky]');
  if (!sky) return null;
  const r = sky.getBoundingClientRect();
  return { w: r.width, h: r.height };
});
if (!geom) { bad('the ADDICTED sky is in the page'); console.log('\n1 failure(s)'); await browser.close(); server.close(); process.exit(1); }
geom.w > 100 && geom.h > 100
  ? ok('the sky is laid out', `${Math.round(geom.w)}×${Math.round(geom.h)}`)
  : bad('the sky is laid out', JSON.stringify(geom));

// The art has to have actually downloaded. A 404 leaves the <img> in the DOM
// with every style intact and naturalWidth 0 — nothing else gives it away.
const loaded = await page.evaluate(async () => {
  const sky = document.querySelector('[data-addicted-sky]');
  const imgs = [...sky.querySelectorAll('img')];
  await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => {
    i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true });
  })));
  return imgs.map(i => ({ cls: i.className, src: i.getAttribute('src'), w: i.naturalWidth }));
});
for (const i of loaded) {
  i.w > 0 ? ok(`  ${i.src} loaded`, `${i.w}px wide`)
          : bad(`  ${i.src} loaded`, 'naturalWidth 0 — it 404d or is not an image');
}
loaded.length >= 3 ? ok('all three plates are there') : bad('all three plates are there', `${loaded.length}`);

// ── The strike ─────────────────────────────────────────────────────────────
// Sampled across the animation and reduced to a peak, because a single read
// can land in either trough of the double pulse and report nothing happened.
const peakOpacity = async (act) => page.evaluate(async (doAct) => {
  const sky = document.querySelector('[data-addicted-sky]');
  const bolt = sky.querySelector('.ad-bolt');
  const r = sky.getBoundingClientRect();
  const at = (x, y, type) => sky.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
    clientX: r.left + r.width * x, clientY: r.top + r.height * y }));
  if (doAct) at(0.5, 0.5, 'pointerdown');
  let peak = 0;
  for (let i = 0; i < 60; i++) {           // ~1s at 60fps, the strike is 900ms
    peak = Math.max(peak, parseFloat(getComputedStyle(bolt).opacity) || 0);
    await new Promise(r2 => requestAnimationFrame(r2));
  }
  if (doAct) at(0.5, 0.5, 'pointerup');
  return peak;
}, act);

const quiet = await peakOpacity(false);
quiet < 0.2 ? ok('untouched, the bolt is dark', `peak opacity ${quiet.toFixed(2)}`)
            : bad('untouched, the bolt is dark', `peak opacity ${quiet.toFixed(2)} — it should be waiting`);
const struck = await peakOpacity(true);
struck > 0.7 ? ok('touching the sky fires the lightning', `peak opacity ${struck.toFixed(2)}`)
             : bad('touching the sky fires the lightning', `peak opacity ${struck.toFixed(2)}`);

// ── The logo ───────────────────────────────────────────────────────────────
// Three rendered transforms: at rest, dragged left, dragged right. The point
// is that they are three DIFFERENT matrices — how the script expresses the
// tilt is its business, but if the browser paints the same thing at both
// edges then nothing moves when you touch it.
const tilt = await page.evaluate(async () => {
  const sky = document.querySelector('[data-addicted-sky]');
  const logo = sky.querySelector('.ad-logo');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const r = () => sky.getBoundingClientRect();
  const at = (x, y, type) => { const b = r(); sky.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
    clientX: b.left + b.width * x, clientY: b.top + b.height * y })); };
  const t = () => getComputedStyle(logo).transform;
  await wait(500);
  const rest = t();
  at(0.04, 0.5, 'pointerdown'); at(0.04, 0.5, 'pointermove'); await wait(260);
  const left = t();
  at(0.96, 0.5, 'pointermove'); await wait(260);
  const right = t();
  // pointercancel is what a phone sends when the browser takes the drag over
  // for a carousel swipe; the logo must fall back to rest, not stay cranked.
  at(0.96, 0.5, 'pointercancel'); await wait(700);
  const after = t();
  return { rest, left, right, after };
});
tilt.left !== tilt.right
  ? ok('the logo turns toward the finger', 'left and right render different transforms')
  : bad('the logo turns toward the finger', `both edges render ${tilt.right}`);
tilt.left !== tilt.rest
  ? ok('and it is not sitting at rest while dragged')
  : bad('and it is not sitting at rest while dragged', tilt.rest);
tilt.after === tilt.rest
  ? ok('a cancelled drag — a carousel swipe — puts it back')
  : bad('a cancelled drag — a carousel swipe — puts it back', `${tilt.after} vs rest ${tilt.rest}`);

await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
