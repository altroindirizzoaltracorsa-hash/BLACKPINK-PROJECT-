// The ADDICTED sky: the lightning, and the lockup that turns under a finger.
//
// Run: node .github/scripts/test_addicted_sky.mjs
//
// The card has TWO ways of drawing that lockup and both have to work:
//
//   * the real model (jisoo.io's own .glb, three.js, a WebGL canvas), which
//     is what almost everyone gets;
//   * the flat lockup it falls back to with no WebGL, a refused context, a
//     model that will not load, or Save-Data on.
//
// A test that only drove one of them would pass while half the audience saw
// a card nobody had looked at. So this runs both, in two browser contexts.
//
// The angles are jisoo.io's, not ours, read off that page:
//   logoRoot.rotation.y = x*0.42 + idle*0.6   → 24.06° at the edge
//   logoRoot.rotation.x = -y*0.3              → 17.19°
//   idle = reduce ? 0 : Math.sin(t*0.6)*0.05  → ±1.72° on a ~10.5s cycle
//   const ease = 1 - Math.exp(-dt*6)          → 63% of the way in 1/6 s
// They are pinned as RENDERED angles because a multiplier alone cannot be
// checked: an earlier version read a −0.5…0.5 pointer into a 26° multiplier,
// so its real maximum was 13° — half the reference — while the number in the
// source looked like a match.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const TYPE = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  webp: 'image/webp', glb: 'model/gltf-binary', woff2: 'font/woff2', ttf: 'font/ttf', mp4: 'video/mp4' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  // No service worker in tests. The page registers one and reloads once
  // when it takes control — by design, so a visitor swaps to the fresh
  // build — but inside a test that is a navigation landing in the middle
  // of sampling, and it destroys the execution context. It cost three
  // runs in ten before this.
  if (p === '/sw.js') { res.writeHead(404); return res.end(''); }
  const file = p === '/' ? '/index.html' : SPA.test(p) ? '/index.html' : p;
  try { const b = await readFile(ROOT + file);
    res.writeHead(200, { 'content-type': TYPE[file.split('.').pop()] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(r => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
// SwiftShader, so the model renders on a runner with no GPU.
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const JS_IO = { yaw: 24.06, pitch: 17.19, idle: 1.72 };

async function openCard(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 900 }, deviceScaleFactor: 1,
    hasTouch: true, isMobile: true, reducedMotion: opts.reducedMotion || 'no-preference',
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1');
    localStorage.setItem('ltal_reminder_dismissed_v1', '1'); localStorage.setItem('ext_update_dismissed_1.9.8', '1'); } catch (e) {} });
  if (opts.noWebGL) {
    // Exactly what an old phone or a blocked context gives the page.
    await page.addInitScript(() => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, ...r) {
        return /webgl/i.test(String(t)) ? null : real.call(this, t, ...r);
      };
    });
  }
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await page.goto(BASE + '/countdowns/addicted', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.locator('.cd-card-addicted').first().scrollIntoViewIfNeeded().catch(() => {});
  // The model arrives over a dynamic import plus ~930KB; wait for the mount
  // to resolve either way rather than for a fixed number of seconds.
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-addicted-sky]');
    return s && (s._adScene || s._adSceneTried === true || !('IntersectionObserver' in window));
  }, null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return { ctx, page, errs };
}

// ── 1. The real model ──────────────────────────────────────────────────────
console.log('--- the real model');
{
  const { ctx, page, errs } = await openCard();
  const st = await page.evaluate(() => {
    const sky = document.querySelector('[data-addicted-sky]');
    const orbit = sky && sky.querySelector('.ad-logo-orbit');
    return { mounted: !!(sky && sky._adScene), canvas: !!(sky && sky.querySelector('.ad-gl canvas')),
             flat: orbit ? getComputedStyle(orbit).display : '(none)',
             hasGl: !!(sky && sky.classList.contains('has-gl')) };
  });
  st.mounted && st.canvas ? ok('the model mounts and renders to a canvas')
                          : bad('the model mounts and renders to a canvas', JSON.stringify(st));
  // Both at once would be two ADDICTEDs on one card.
  st.flat === 'none' ? ok('and the flat lockup steps aside', st.hasGl ? 'has-gl set' : '')
                     : bad('and the flat lockup steps aside', `display: ${st.flat}`);

  // It drifts on its own, as theirs does — sampled untouched, so any movement
  // here is the idle term and nothing else.
  const drift = await page.evaluate(async () => {
    const s = document.querySelector('[data-addicted-sky]')._adScene;
    if (!s) return null;
    s.rest();
    await new Promise(r => setTimeout(r, 900));
    const a = [];
    for (let i = 0; i < 12; i++) { a.push(s.yawDeg()); await new Promise(r => setTimeout(r, 120)); }
    return { min: Math.min(...a), max: Math.max(...a) };
  });
  if (!drift) bad('it drifts while untouched');
  else {
    const span = drift.max - drift.min;
    (span > 0.05 && Math.abs(drift.max) < JS_IO.idle + 0.4)
      ? ok('it drifts while untouched, within their amplitude',
           `${drift.min.toFixed(2)}° … ${drift.max.toFixed(2)}° (theirs is ±${JS_IO.idle}°)`)
      : bad('it drifts while untouched, within their amplitude',
            `${drift.min.toFixed(2)}° … ${drift.max.toFixed(2)}°`);
  }
  if (errs.length) { console.log('    page errors: ' + errs.slice(0, 2).join(' | ')); fails += errs.length; }
  await ctx.close();
}

// ── 2. The angles, with the drift switched off ─────────────────────────────
// Under reduced motion their idle term is zero (`reduce ? 0 : …`), which is
// also the only way to read the pointer angles without ±1.72° of noise on top.
console.log('--- the angles are jisoo.io\'s');
{
  const { ctx, page } = await openCard({ reducedMotion: 'reduce' });
  const a = await page.evaluate(async () => {
    const s = document.querySelector('[data-addicted-sky]')._adScene;
    if (!s) return null;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    s.point(1, 0.5); await wait(170); const partial = s.yawDeg();
    await wait(1100);                 const right = s.yawDeg();
    s.point(0.5, 0); await wait(1200); const top = s.pitchDeg();
    s.rest();        await wait(1200); const back = s.yawDeg();
    return { partial, right, top, back };
  });
  if (!a) { bad('the model is up under reduced motion'); }
  else {
    Math.abs(a.right - JS_IO.yaw) <= 0.4
      ? ok('the yaw at the edge is theirs', `${a.right.toFixed(2)}° vs ${JS_IO.yaw}°`)
      : bad('the yaw at the edge is theirs', `${a.right.toFixed(2)}° — that site turns ${JS_IO.yaw}°`);
    Math.abs(a.top - JS_IO.pitch) <= 0.4
      ? ok('and the pitch is too', `${a.top.toFixed(2)}° vs ${JS_IO.pitch}°`)
      : bad('and the pitch is too', `${a.top.toFixed(2)}° — that site tips ${JS_IO.pitch}°`);
    // One time constant covers 1-1/e = 63%. A snap would read ~100% here and
    // the end sample alone could not tell the two apart.
    const frac = a.partial / JS_IO.yaw;
    (frac > 0.40 && frac < 0.85)
      ? ok('it chases rather than snapping', `${Math.round(frac * 100)}% after one time constant`)
      : bad('it chases rather than snapping', `${Math.round(frac * 100)}% after 170ms, want ~63%`);
    Math.abs(a.back) <= 0.4
      ? ok('and it comes back to square on', `${a.back.toFixed(2)}°`)
      : bad('and it comes back to square on', `${a.back.toFixed(2)}°`);
  }
  // The GEARING: how far it turns for a given amount of finger. This is what
  // was wrong while the angles were right — the pointer was normalised over
  // the CARD rather than the window, so the whole turn arrived in a drag a
  // third as long and it swung far more than that site does for the same
  // gesture. Their x is one unit per half a window of travel.
  const gear = await page.evaluate(() => new Promise(res => {
    const sky = document.querySelector('[data-addicted-sky]');
    const s = sky._adScene; if (!s) return res(null);
    const r = sky.getBoundingClientRect();
    const ev = (t, dx) => sky.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'mouse',
      clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2 }));
    ev('pointerdown', 0); ev('pointermove', 0);
    setTimeout(() => {
      const from = s.yawDeg();
      ev('pointermove', 100);                      // exactly 100px of travel
      setTimeout(() => res({ deg: s.yawDeg() - from, half: window.innerWidth / 2 }), 1500);
    }, 1500);
  }));
  if (!gear) bad('the pointer gearing is jisoo.io\'s');
  else {
    const want = (100 / gear.half) * JS_IO.yaw;
    Math.abs(gear.deg - want) <= 1.0
      ? ok('the pointer gearing is jisoo.io\'s', `${gear.deg.toFixed(1)}° per 100px, theirs ${want.toFixed(1)}°`)
      : bad('the pointer gearing is jisoo.io\'s', `${gear.deg.toFixed(1)}° per 100px, theirs ${want.toFixed(1)}°`);
  }
  await ctx.close();
}

// ── 3. No WebGL: the card must be exactly what it was before ───────────────
console.log('--- the fallback, with WebGL refused');
{
  const { ctx, page, errs } = await openCard({ noWebGL: true });
  const st = await page.evaluate(async () => {
    const sky = document.querySelector('[data-addicted-sky]');
    const logo = sky.querySelector('.ad-logo');
    const orbit = sky.querySelector('.ad-logo-orbit');
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const turn = () => { const m = new DOMMatrix(getComputedStyle(logo).transform);
      return Math.asin(Math.max(-1, Math.min(1, -m.m13))) * 180 / Math.PI; };
    const r = sky.getBoundingClientRect();
    const ev = (t, fx) => sky.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'mouse', clientX: r.left + r.width * fx, clientY: r.top + r.height * 0.5 }));
    ev('pointerdown', 1); ev('pointermove', 1);
    await wait(1100);
    // What the EDGE of this sky can reach. The pointer is geared to the
    // window, the way jisoo.io gears it to its own full-window canvas, so a
    // card narrower than the screen cannot reach the full angle — the same as
    // not being able to drag past the edge of their screen.
    const reach = Math.min(1, (r.width / 2) / (window.innerWidth / 2));
    return { scene: !!sky._adScene, canvas: !!sky.querySelector('.ad-gl canvas'),
             flat: getComputedStyle(orbit).display, logoLoaded: logo && logo.naturalWidth > 0,
             yaw: turn(), reach };
  });
  !st.scene && !st.canvas ? ok('no model is mounted') : bad('no model is mounted', JSON.stringify(st));
  st.flat !== 'none' && st.logoLoaded
    ? ok('the flat lockup is still there and loaded')
    : bad('the flat lockup is still there and loaded', JSON.stringify(st));
  {
    const want = JS_IO.yaw * st.reach;
    Math.abs(st.yaw - want) <= 0.8
      ? ok('and it still turns, on the same gearing', `${st.yaw.toFixed(2)}° at this sky's edge, want ${want.toFixed(2)}°`)
      : bad('and it still turns, on the same gearing', `${st.yaw.toFixed(2)}°, want ${want.toFixed(2)}°`);
  }
  if (errs.length) { console.log('    page errors: ' + errs.slice(0, 2).join(' | ')); fails += errs.length; }
  await ctx.close();
}

// ── 4. The lightning, which is the same either way ─────────────────────────
console.log('--- the strike');
{
  const { ctx, page } = await openCard();
  const sample = (act) => page.evaluate(async (doAct) => {
    const sky = document.querySelector('[data-addicted-sky]');
    const bolt = sky.querySelector('.ad-bolt');
    const r = sky.getBoundingClientRect();
    if (doAct) sky.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'touch', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    let peak = 0, low = 1;
    for (let i = 0; i < 60; i++) {
      const o = parseFloat(getComputedStyle(bolt).opacity) || 0;
      peak = Math.max(peak, o); low = Math.min(low, o);
      await new Promise(r2 => requestAnimationFrame(r2));
    }
    return { peak, low, loaded: bolt.naturalWidth > 0 };
  }, act);
  const quiet = await sample(false);
  quiet.loaded ? ok('the bolt plate is loaded') : bad('the bolt plate is loaded');
  // Not "it never lights" — it strikes on its own every few seconds, and the
  // first version of this went red whenever one landed inside the sample.
  quiet.low < 0.05 ? ok('untouched, it returns to dark', `down to ${quiet.low.toFixed(2)}`)
                   : bad('untouched, it returns to dark', `never below ${quiet.low.toFixed(2)}`);
  const struck = await sample(true);
  struck.peak > 0.7 ? ok('touching the sky fires it', `peak ${struck.peak.toFixed(2)}`)
                    : bad('touching the sky fires it', `peak ${struck.peak.toFixed(2)}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
