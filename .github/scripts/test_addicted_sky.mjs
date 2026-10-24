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
  let peak = 0, low = 1;
  for (let i = 0; i < 60; i++) {           // ~1s at 60fps, the strike is 900ms
    const o = parseFloat(getComputedStyle(bolt).opacity) || 0;
    peak = Math.max(peak, o); low = Math.min(low, o);
    await new Promise(r2 => requestAnimationFrame(r2));
  }
  if (doAct) at(0.5, 0.5, 'pointerup');
  return { peak, low };
}, act);

// NOT "it never lights while untouched" — it does, on its own, every few
// seconds, and the first version of this check went red the moment one of
// those idle strikes landed inside the sample. What must be true is that it
// comes back to dark, which is what a bolt stuck at opacity 1 would fail.
const quiet = await peakOpacity(false);
quiet.low < 0.05 ? ok('untouched, the bolt returns to dark', `down to ${quiet.low.toFixed(2)}`)
                 : bad('untouched, the bolt returns to dark', `never below ${quiet.low.toFixed(2)} — it is stuck lit`);
const struck = await peakOpacity(true);
struck.peak > 0.7 ? ok('touching the sky fires the lightning', `peak opacity ${struck.peak.toFixed(2)}`)
                  : bad('touching the sky fires the lightning', `peak opacity ${struck.peak.toFixed(2)}`);

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
  // The pointerup that ended the strike check above was a tap, so it set the
  // lockup swinging — 640ms of it. Reading "rest" at 500ms caught the swing
  // and then compared everything against a tilted baseline.
  await wait(1500);
  const rest = t();
  at(0.04, 0.5, 'pointerdown'); at(0.04, 0.5, 'pointermove'); await wait(700);
  const left = t();
  at(0.96, 0.5, 'pointermove'); await wait(700);
  const right = t();
  // pointercancel is what a phone sends when the browser takes the drag over
  // for a carousel swipe; the logo must fall back to rest, not stay cranked.
  at(0.96, 0.5, 'pointercancel'); await wait(1300);   // the chase has to get home
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

// ── The angles are jisoo.io's, not ours ────────────────────────────────────
// Read off that page: logoRoot.rotation.y = x*0.42 + idle*0.6, rotation.x =
// -y*0.3, with the pointer normalised to −1…1. That is 24.06° of yaw and
// 17.19° of pitch at the edges, and an idle drift of ±1.72° on a ~10.5s
// cycle. They are pinned here because the first version was tuned by feel:
// it read −0.5…0.5 into a 26° multiplier, so its real maximum was 13° — half
// the reference — while the number in the source looked like a match. A
// multiplier alone cannot be checked; the rendered angle can.
const JS_IO = { yaw: 24.06, pitch: 17.19, idle: 1.72 };
const angles = await page.evaluate(async () => {
  const sky = document.querySelector('[data-addicted-sky]');
  const logo = sky.querySelector('.ad-logo');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const read = () => {
    const m = new DOMMatrix(getComputedStyle(logo).transform);
    const c = v => Math.max(-1, Math.min(1, v));
    return { yaw: +(Math.asin(c(-m.m13)) * 180 / Math.PI).toFixed(2),
             pitch: +(Math.asin(c(m.m23)) * 180 / Math.PI).toFixed(2) };
  };
  const at = (fx, fy) => { const r = sky.getBoundingClientRect();
    const ev = t => sky.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'mouse', clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
    ev('pointerdown'); ev('pointermove'); };
  // It CHASES the pointer — ease = 1 - exp(-dt*6), a 1/6s time constant — so
  // a sample taken too early reads a number still on its way. One sample at
  // roughly one time constant and one after it has settled, which also pins
  // the chase itself: a version that snapped would show the full angle at
  // both, and a version with no easing at all would be indistinguishable
  // from a correct one if we only ever looked at the end.
  at(1, 0.5); await wait(170); const partial = read();
  await wait(900);             const right = read();
  at(0.5, 0);  await wait(1000); const top = read();
  const orbit = sky.querySelector('.ad-logo-orbit');
  const anim = orbit ? getComputedStyle(orbit).animationName : '(no orbit)';
  const dur  = orbit ? getComputedStyle(orbit).animationDuration : '';
  return { right, top, partial, anim, dur,
           persp: getComputedStyle(sky).perspective,
           skyH: Math.round(sky.getBoundingClientRect().height) };
});
const near = (got, want, tol = 0.6) => Math.abs(got - want) <= tol;
near(angles.right.yaw, JS_IO.yaw)
  ? ok("the yaw at the edge is jisoo.io's", `${angles.right.yaw}° vs ${JS_IO.yaw}°`)
  : bad("the yaw at the edge is jisoo.io's", `${angles.right.yaw}° — that site turns ${JS_IO.yaw}°`);
near(angles.top.pitch, JS_IO.pitch)
  ? ok("and the pitch is too", `${angles.top.pitch}° vs ${JS_IO.pitch}°`)
  : bad("and the pitch is too", `${angles.top.pitch}° — that site tips ${JS_IO.pitch}°`);
// One time constant in, an exponential chase has covered 1-1/e = 63% of the
// distance. Allowing 40-85% for frame timing: anything at ~100% has snapped,
// anything near 0 is not moving at all.
{
  const frac = angles.partial.yaw / JS_IO.yaw;
  (frac > 0.40 && frac < 0.85)
    ? ok('it chases the pointer rather than snapping to it',
         `${Math.round(frac * 100)}% of the way after one time constant`)
    : bad('it chases the pointer rather than snapping to it',
          `${Math.round(frac * 100)}% after 170ms — jisoo.io eases at 1-exp(-dt*6), which is 63%`);
}
angles.anim === 'ad-idle'
  ? ok('the lockup drifts on its own, as theirs does', `${angles.anim} ${angles.dur}`)
  : bad('the lockup drifts on its own, as theirs does', angles.anim);
// Their camera is PerspectiveCamera(38°); the CSS equal of that is
// (height/2)/tan(19°), which depends on the sky's height and so cannot be one
// fixed px value. Checked as the relationship, not as a number.
{
  const want = Math.round((angles.skyH / 2) / Math.tan(19 * Math.PI / 180));
  const got = parseFloat(angles.persp);
  Math.abs(got - want) <= 6
    ? ok('the perspective matches a 38° camera at this height', `${got}px for a ${angles.skyH}px sky`)
    : bad('the perspective matches a 38° camera at this height', `${got}px, want ~${want}px`);
}

// ── And now with a REAL finger ─────────────────────────────────────────────
// Everything above dispatches PointerEvents straight at the element, and
// those are never cancelled — so they pass on a logo that does not move at
// all in a hand. That is not a hypothetical: it is what shipped. Chromium
// claimed the drag for a scroll after two pointermoves, sent pointercancel,
// and the logo rendered a rotation of 6.7e-08 degrees while this file
// reported three different transforms and called it green.
// So: drive the touch through CDP, let the browser decide what to do with
// the gesture, and measure the rotation the way an eye would — a rotated
// element projects NARROWER than it is laid out.
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
const tp = await ctx.newPage();
await tp.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1');
  localStorage.setItem('ltal_reminder_dismissed_v1', '1'); localStorage.setItem('ext_update_dismissed_1.9.7', '1'); } catch (e) {} });
await tp.goto(`http://127.0.0.1:${server.address().port}/countdowns/addicted`, { waitUntil: 'load' });
await tp.waitForTimeout(2500);
// How far the lockup is actually turned, in degrees, read off the matrix the
// browser composited. NOT the projected width, which was the first attempt
// and is useless here: under perspective the near edge is magnified by about
// as much as the far edge shrinks, so a real 4.7° turn moved the bounding box
// by 0.19% and the check called it motionless.
// The first column of the matrix is where the element's local X axis ended up,
// so its out-of-screen component is the sine of the turn; same for Y with the
// second column. One number, zero when flat on, whichever way it is tipped.
const turnDeg = () => tp.evaluate(() => {
  const l = document.querySelector('.ad-logo');
  if (!l) return 0;
  const t = getComputedStyle(l).transform;
  if (!t || t === 'none') return 0;
  const m = new DOMMatrix(t);
  const out = Math.min(1, Math.hypot(m.m13, m.m23));
  return Math.asin(out) * 180 / Math.PI;
});
const lbox = await tp.locator('[data-addicted-sky]').first().boundingBox();
if (!lbox) { bad('the sky is reachable on a phone'); }
else {
  const cdp = await ctx.newCDPSession(tp);
  const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent',
    { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const cx = lbox.x + lbox.width / 2, cy = lbox.y + lbox.height / 2;
  const reach = lbox.width * 0.36;                 // centre out towards the edge
  await tp.waitForTimeout(1200);                   // let any idle strike pass
  const flat = await turnDeg();
  await send('touchStart', cx, cy);
  let peak = 0;
  for (let i = 1; i <= 8; i++) {
    await send('touchMove', cx + (reach * i) / 8, cy + 2);
    await tp.waitForTimeout(45);
    peak = Math.max(peak, await turnDeg());
  }
  await send('touchEnd', cx + reach, cy + 2);
  flat < 1 ? ok('at rest the lockup is square on', `${flat.toFixed(2)}°`)
           : bad('at rest the lockup is square on', `${flat.toFixed(2)}°`);
  peak > 2 ? ok('a real finger turns it', `${peak.toFixed(1)}° at the furthest point`)
           : bad('a real finger turns it',
                 `only ${peak.toFixed(2)}° — the browser took the gesture and it never moved`);

  // A poke that never drags has to move it too, or tapping the card does
  // nothing at all and "touch the logo" is a lie on the commonest gesture.
  await tp.waitForTimeout(1200);
  await send('touchStart', cx - lbox.width * 0.2, cy);
  await tp.waitForTimeout(30);
  await send('touchEnd', cx - lbox.width * 0.2, cy);
  let knock = 0;
  for (let i = 0; i < 28; i++) { knock = Math.max(knock, await turnDeg()); await tp.waitForTimeout(25); }
  knock > 4 ? ok('and a tap with no drag swings it', `${knock.toFixed(1)}° at the peak`)
            : bad('and a tap with no drag swings it', `only ${knock.toFixed(2)}°`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
