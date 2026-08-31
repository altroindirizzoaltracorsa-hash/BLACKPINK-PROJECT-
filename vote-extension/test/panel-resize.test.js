// Renders the real panel.js in Chromium against a stubbed chrome API and drives
// the resize grip with real pointer events.
//
//   node vote-extension/test/panel-resize.test.js vote-extension/panel.js
// Playwright may be installed locally or globally; and CI images often pin the
// browser outside the default download dir.
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright')); }
const fsx = require('fs');
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .filter(Boolean).find((p) => { try { return fsx.existsSync(p); } catch (_) { return false; } });
const fs = require('fs');
const SRC = fs.readFileSync(process.argv[2], 'utf8');

const STUB = `
window.__store = {};
window.chrome = {
  runtime: {
    getURL: (p) => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    sendMessage: (m, cb) => { if (cb) setTimeout(() => cb({ liveVoters: 3 }), 0); },
    lastError: null,
  },
  storage: {
    local: {
      get: (keys, cb) => { const k = Array.isArray(keys) ? keys : [keys]; const o = {};
        k.forEach(x => { if (x in window.__store) o[x] = window.__store[x]; }); setTimeout(() => cb(o), 0); },
      set: (obj, cb) => { Object.assign(window.__store, JSON.parse(JSON.stringify(obj)));
        if (cb) setTimeout(cb, 0); },
      remove: (k, cb) => { (Array.isArray(k) ? k : [k]).forEach(x => delete window.__store[x]);
        if (cb) setTimeout(cb, 0); },
    },
    onChanged: { addListener: () => {} },
  },
};
`;

const box = async (p) => p.evaluate(() => {
  const el = document.getElementById('bu-vote-panel-host').shadowRoot.getElementById('panel');
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top),
           sized: el.classList.contains('sized') };
});
const grip = async (p) => p.evaluate(() => {
  const r = document.getElementById('bu-vote-panel-host').shadowRoot.getElementById('grip').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const store = async (p) => p.evaluate(() => window.__store);

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    ok ? pass++ : fail++;
  };

  async function boot(seed = {}, viewport = { width: 1200, height: 900 }) {
    const page = await browser.newPage({ viewport });
    await page.setContent('<!doctype html><title>t</title><body style="height:3000px">');
    await page.evaluate(STUB);
    await page.evaluate(s => { window.__store = s; }, seed);
    await page.evaluate(SRC);
    await page.waitForTimeout(150);
    return page;
  }
  async function dragGrip(page, dx, dy) {
    const g = await grip(page);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await page.mouse.move(g.x + dx, g.y + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  }

  // 1. grip visible when open, and the panel starts unsized
  {
    const p = await boot({ buPanelMin: false });
    const b = await box(p);
    const vis = await p.evaluate(() => {
      const g = document.getElementById('bu-vote-panel-host').shadowRoot.getElementById('grip');
      return getComputedStyle(g).display;
    });
    check('grip shown on the open panel', vis === 'block', `display=${vis}`);
    check('panel starts unsized (content height)', b.sized === false && b.w === 290, `${b.w}x${b.h}`);
    await p.close();
  }

  // 2. dragging the grip resizes both axes
  {
    const p = await boot({ buPanelMin: false });
    const before = await box(p);
    await dragGrip(p, 160, 120);
    const after = await box(p);
    check('drag grows width + height',
      after.w > before.w + 120 && after.h > before.h + 80, `${before.w}x${before.h} -> ${after.w}x${after.h}`);
    check('right edge does not run away from the pointer',
      Math.abs(after.left - before.left) <= 2, `left ${before.left} -> ${after.left}`);
    const st = await store(p);
    check('size persisted', !!st.buPanelSize && st.buPanelSize.w === after.w, JSON.stringify(st.buPanelSize));
    await p.close();
  }

  // 3. a saved size is restored on next load
  {
    const p = await boot({ buPanelMin: false, buPanelSize: { w: 420, h: 560 }, buPanelPos: { left: 100, top: 80 } });
    const b = await box(p);
    check('saved size restored on load', b.w === 420 && b.h === 560 && b.sized, `${b.w}x${b.h}`);
    await p.close();
  }

  // 4. clamps - cannot be dragged below the minimum
  {
    const p = await boot({ buPanelMin: false, buPanelSize: { w: 420, h: 560 }, buPanelPos: { left: 100, top: 80 } });
    await dragGrip(p, -900, -900);
    const b = await box(p);
    check('clamped to minimum size', b.w === 232 && b.h === 200, `${b.w}x${b.h}`);
    await p.close();
  }

  // 5. clamps - cannot exceed the viewport
  {
    const p = await boot({ buPanelMin: false, buPanelPos: { left: 20, top: 20 } });
    await dragGrip(p, 4000, 4000);
    const b = await box(p);
    check('clamped to viewport', b.w <= 1192 && b.h <= 892, `${b.w}x${b.h} in 1200x900`);
    await p.close();
  }

  // 6. a size saved on desktop is re-clamped on a phone-sized screen
  {
    const p = await boot({ buPanelMin: false, buPanelSize: { w: 900, h: 800 }, buPanelPos: { left: 10, top: 10 } },
                         { width: 380, height: 700 });
    const b = await box(p);
    check('oversized saved size re-clamped on a small screen',
      b.w <= 372 && b.h <= 692, `${b.w}x${b.h} in 380x700`);
    await p.close();
  }

  // 7. the collapsed pill is never sized
  {
    const p = await boot({ buPanelMin: true, buPanelSize: { w: 500, h: 600 } });
    const b = await box(p);
    check('collapsed pill ignores the saved size', b.sized === false && b.w < 200, `${b.w}x${b.h} sized=${b.sized}`);
    await p.close();
  }

  // 8. double-click the grip resets
  {
    const p = await boot({ buPanelMin: false, buPanelSize: { w: 420, h: 560 }, buPanelPos: { left: 100, top: 80 } });
    const g = await grip(p);
    await p.mouse.dblclick(g.x, g.y);
    await p.waitForTimeout(150);
    const b = await box(p);
    const st = await store(p);
    check('double-click resets to default', b.sized === false && b.w === 290 && !st.buPanelSize, `${b.w}x${b.h}`);
    await p.close();
  }

  // 9. at a tall size the log absorbs the slack and all content stays reachable
  {
    const log = []; for (let i = 0; i < 30; i++) log.push({ n: 1, cat: 'Best Pop', who: 'LISA', ts: Date.now() });
    const p = await boot({ buPanelMin: false, buLog: log, buDay: 'x',
                           buPanelSize: { w: 340, h: 820 }, buPanelPos: { left: 40, top: 20 } });
    const m = await p.evaluate(() => {
      const sr = document.getElementById('bu-vote-panel-host').shadowRoot;
      const panel = sr.getElementById('panel'), body = sr.getElementById('body'), lg = sr.getElementById('log');
      return { logH: Math.round(lg.getBoundingClientRect().height),
               bodyOverflow: body.scrollHeight - body.clientHeight,
               footVisible: sr.getElementById('status').getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1 };
    });
    check('log expands into the extra height', m.logH > 168, `log height ${m.logH}px (was capped at 168)`);
    check('nothing clipped at a tall size', m.bodyOverflow <= 0 && m.footVisible, `body overflow ${m.bodyOverflow}px`);
    await p.close();
  }

  // 10. at the minimum size content is still reachable by scrolling
  {
    const p = await boot({ buPanelMin: false, buPanelSize: { w: 232, h: 200 }, buPanelPos: { left: 40, top: 20 } });
    const m = await p.evaluate(() => {
      const sr = document.getElementById('bu-vote-panel-host').shadowRoot;
      const body = sr.getElementById('body');
      return { scrollable: body.scrollHeight > body.clientHeight, canScroll: getComputedStyle(body).overflowY };
    });
    check('short panel scrolls instead of clipping', m.scrollable && m.canScroll === 'auto', `overflow-y=${m.canScroll}`);
    await p.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
