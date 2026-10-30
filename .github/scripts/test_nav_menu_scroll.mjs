// Every item in the collapsed nav can actually be reached.
//
// Run: node .github/scripts/test_nav_menu_scroll.mjs
//
// WHY. The nav collapses to a hamburger below 1560px — which is most desktop
// windows, not just phones — and the panel it opens is `position: fixed`. A
// fixed panel does not scroll with the page, so anything past the bottom of
// the viewport is not merely offscreen, it is unreachable: no amount of
// scrolling the document brings it back. It had no max-height and no
// overflow-y, so on a 1363px-wide window with the usual tabs, bookmarks bar
// and taskbar the list ran out at "Achievements" and the last entries could
// not be clicked at all.
//
// REPORTED FROM A REAL DESKTOP AT 100% ZOOM, which is the part worth keeping:
// the window was 1363x768, and at a true 768px viewport the list fits. It only
// fails once browser chrome is taken off the top, so a test at the nominal
// screen size would have passed while the bug was live. These heights are the
// content area that is actually left.
//
// MEASURED, NOT READ OFF THE CSS: the check scrolls the panel to its end and
// asks whether the last item's box is inside the viewport. A rule that is
// present but defeated — by a parent's overflow, a stacking context, a height
// that does not resolve — still fails here.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const TY = { html:'text/html', js:'text/javascript', css:'text/css', json:'application/json',
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', svg:'image/svg+xml',
  woff2:'font/woff2', mp4:'video/mp4' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/sw.js') { res.writeHead(404); res.end(''); return; }
  const f = p === '/' ? '/index.html' : p;
  try { const b = await readFile(root + f);
    res.writeHead(200, { 'content-type': TY[f.split('.').pop()] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

// Short enough that the list overflows — a laptop window with chrome on it,
// and a small phone. Both are inside the hamburger's range.
const SIZES = [[1363, 592, 'laptop window, chrome deducted'],
               [1280, 560, 'smaller laptop'],
               [390, 560, 'phone, keyboard-ish']];

for (const [w, h, label] of SIZES) {
  console.log(`\n--- ${label} (${w}x${h})`);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1'); localStorage.setItem('ext_update_dismissed_1.9.8','1'); } catch (e) {} });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  const r = await page.evaluate(() => {
    const el = document.getElementById('mobile-nav');
    if (!el) return null;
    el.classList.add('open');
    const items = [...el.querySelectorAll('li')].filter((li) => li.offsetParent !== null);
    const last = items[items.length - 1];
    const overflows = el.scrollHeight > el.clientHeight + 1;
    el.scrollTop = el.scrollHeight;                       // go to the end
    const b = last.getBoundingClientRect();
    return {
      count: items.length,
      last: last.innerText.trim(),
      overflows,
      reachable: b.top >= 0 && b.bottom <= window.innerHeight + 1,
      panelBottom: el.getBoundingClientRect().bottom,
      viewportH: window.innerHeight,
    };
  });

  check(!!r, 'the nav panel is in the page');
  if (!r) { await page.close(); continue; }
  check(r.count >= 10, `${r.count} items are showing`);
  // The guard. If the list fits at this size the reachability check below is
  // vacuous — it would pass on a panel that cannot scroll at all, which is
  // exactly the bug. Fail loudly instead of passing for the wrong reason.
  check(r.overflows, 'the list is longer than the space, so this size tests something',
        r.overflows ? `${r.viewportH}px viewport` : 'it fits — pick a shorter viewport');
  check(r.reachable, `the last item "${r.last}" can be scrolled to`,
        r.reachable ? 'reached' : `panel ends at ${Math.round(r.panelBottom)}px, viewport is ${r.viewportH}px`);
  await page.close();
}

await browser.close();
server.close();
console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
