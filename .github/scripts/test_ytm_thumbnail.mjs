// Prove the thumbnail fallback survives the way i.ytimg.com actually fails.
//
// Run: node .github/scripts/test_ytm_thumbnail.mjs
//
// The bug this locks down: a missing maxresdefault.jpg comes back as HTTP 404
// whose BODY is the 120x90 grey "no thumbnail" JPEG. A browser decodes that
// body and shows it — `load` fires, `error` does not — so the card's onerror
// fallback never ran and a 120px grey square was stretched across the slot.
//
// That is why the test serves a 404 WITH an image body rather than a bare 404:
// a bare 404 passes against the old broken code, so a test written that way
// would have been green while the page was visibly wrong. The three cases
// below are exactly the three the live page produces.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const INDEX = new URL('../../index.html', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

// Build the three JPEGs in the browser so there are no binary fixtures to keep.
const scratch = await b.newPage();
const JPEG = await scratch.evaluate(() => {
  const mk = (w, h, paint) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    return c.toDataURL('image/jpeg', 0.6).split(',')[1];
  };
  return {
    // What a 404 carries: flat grey with a rounded rect, 120x90.
    grey: mk(120, 90, (x, w, h) => {
      x.fillStyle = '#f0f0f0'; x.fillRect(0, 0, w, h);
      x.strokeStyle = '#c8c8c8'; x.lineWidth = 3; x.strokeRect(20, 22, 80, 46);
    }),
    // A real hqdefault: 4:3 with letterbox bars.
    hq: mk(480, 360, (x, w, h) => {
      x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#c81e5a'; x.fillRect(0, 45, w, 270);
    }),
    max: mk(1280, 720, (x, w, h) => { x.fillStyle = '#1478c8'; x.fillRect(0, 0, w, h); }),
  };
});
await scratch.close();

// Three videos, one per failure mode the live page shows.
const V = [
  { videoId: 'okokokokok1', title: 'A video with a real maxres',       mode: 'fine' },
  { videoId: 'grey404grey', title: 'BLACKPINK - BOOMBAYAH M/V',         mode: 'grey404' },
  { videoId: 'hardfail404', title: 'A video with nothing at all',       mode: 'nothing' },
];
const MODE = Object.fromEntries(V.map(v => [v.videoId, v.mode]));
const mk = v => ({ ...v, artist: 'BLACKPINK', kind: 'mv', views: 1e9, next: 11e8,
                   gap: 1e8, pct: 0, rate: null, days: null, eta: null });
const BOARD = {
  asOf: '2026-10-05', sortedBy: 'gap', hasRates: false,
  counts: { total: V.length, shown: V.length },
  blackpink: V.map(mk), members: [],
};

const p = await b.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
const served = [];
await p.route('**/*', async route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/youtube' || u.pathname === '/')
    return route.fulfill({ path: INDEX, contentType: 'text/html' });
  if (u.pathname === '/api/youtube-milestones')
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(BOARD) });

  if (u.hostname === 'i.ytimg.com') {
    const [, , id, file] = u.pathname.split('/');
    const mode = MODE[id];
    // The premise check below fetches one of these by hand; ?probe=1 keeps it
    // out of the count of what the CARD asked for.
    if (!u.searchParams.has('probe')) served.push(`${id}/${file}`);
    const jpeg = body => ({ contentType: 'image/jpeg', body: Buffer.from(JPEG[body], 'base64') });
    if (file.startsWith('maxresdefault')) {
      if (mode === 'fine') return route.fulfill({ status: 200, ...jpeg('max') });
      // THE CASE THAT BROKE IT: a 404 that still decodes as an image.
      return route.fulfill({ status: 404, ...jpeg('grey') });
    }
    if (mode === 'grey404') return route.fulfill({ status: 200, ...jpeg('hq') });
    return route.fulfill({ status: 404, ...jpeg('grey') });   // nothing anywhere
  }
  if (u.hostname.includes('fonts.g')) return route.continue();
  return route.fulfill({ status: 204, body: '' });
});

await p.goto('https://www.blinksunited.com/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.ytm-card img');
await p.evaluate(() => {
  try { closeTutorial(); } catch {}
  document.getElementById('tutorial-overlay')?.remove();
  document.getElementById('ext-update-overlay')?.remove();
});
await p.waitForTimeout(1500);

const got = await p.$$eval('.ytm-card img', els => els.map(e => ({
  vid: e.closest('.ytm-card')?.dataset.vid,
  src: (e.getAttribute('src') || '').split('/').pop(),
  natural: e.naturalWidth,
  fb: e.dataset.fb || '',
  display: getComputedStyle(e).display,
})));
const by = Object.fromEntries(got.map(g => [g.vid, g]));

console.log('--- the browser really does render a 404 that decodes');
// If this stops being true the bug is gone for a different reason and the rest
// of the test is measuring nothing, so assert the premise itself.
const premise = await p.evaluate(() => new Promise(res => {
  const i = new Image();
  i.onload = () => res({ ev: 'load', w: i.naturalWidth });
  i.onerror = () => res({ ev: 'error', w: i.naturalWidth });
  i.src = 'https://i.ytimg.com/vi/grey404grey/maxresdefault.jpg?probe=1';
}));
check(premise.ev === 'load' && premise.w === 120,
      `a 404 carrying a 120x90 JPEG fires "${premise.ev}" at ${premise.w}px wide — `
      + 'onerror alone cannot see this');

console.log('\n--- what each card ended up showing');
check(by.okokokokok1?.natural === 1280 && by.okokokokok1.src.startsWith('maxresdefault'),
      `a real maxres is kept as-is (${by.okokokokok1?.natural}px, ${by.okokokokok1?.src})`);
check(by.okokokokok1?.fb === '', 'and no fallback was spent on it');

check(by.grey404grey?.natural === 480 && by.grey404grey.src.startsWith('hqdefault'),
      `the 404-with-a-grey-body falls through to hq (${by.grey404grey?.natural}px, ${by.grey404grey?.src})`);
check(by.grey404grey?.fb === '1', 'and is flagged as having used its fallback');
check(by.grey404grey?.display !== 'none', 'and is still visible — it has a real picture now');

check(by.hardfail404?.fb === '1' && by.hardfail404?.display === 'none',
      `with nothing usable anywhere the img is hidden, not left grey (display:${by.hardfail404?.display})`);

console.log('\n--- the requests that were made');
check(served.includes('grey404grey/maxresdefault.jpg') && served.includes('grey404grey/hqdefault.jpg'),
      'maxres was tried first, then hq — not hq for everything');
check(!served.includes('okokokokok1/hqdefault.jpg'),
      'the good card never asked for hq, so the fix costs no extra requests');
check(served.filter(s => s.startsWith('grey404grey')).length === 2,
      `and the fallback runs once, not in a loop (${served.filter(s => s.startsWith('grey404grey')).length} requests)`);

console.log('\n--- hover is not left stuck on a touchscreen');
const stuck = await p.evaluate(() => {
  // Any rule that paints on :hover must sit behind (hover: hover): a tap on a
  // phone leaves :hover applied to what was tapped until something else is.
  const bad = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const walk = (list, guarded) => {
      for (const r of list) {
        if (r.media) walk(r.cssRules, guarded || /hover:\s*hover/.test(r.conditionText || r.media.mediaText));
        else if (r.selectorText && /\.ytm-[\w-]*(:hover|\s[^,{]*:hover)/.test(r.selectorText) && !guarded)
          bad.push(r.selectorText);
      }
    };
    walk(rules, false);
  }
  return bad;
});
check(stuck.length === 0, `no unguarded :hover on a card element (${stuck.join(' | ') || 'none'})`);

check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);

await p.screenshot({ path: '/tmp/ytm-thumbs.png', fullPage: true }).catch(() => {});
await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
