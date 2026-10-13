// Render mama-guide.html to the shareable PNG.
//
//   node .github/scripts/render_mama_guide.mjs
//
// Writes mama-guide.png at 1080x1350 — the 4:5 X and Instagram show without
// cropping. deviceScaleFactor 2 so the small print survives being viewed on a
// phone at full width; the rules are the point of the poster and a soft one is
// a rule nobody reads.
//
// Fonts are fetched from Google, same as the site. It waits for them to load
// rather than screenshotting on a timer: Bebas Neue arriving late turns every
// heading into fallback sans-serif, and the render still "succeeds".
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const out = root + 'mama-guide.png';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 2 });

// Serve the page and its one local image off disk. Fonts are the only thing
// allowed out to the network.
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.hostname.includes('fonts.g')) return route.continue();
  const f = u.pathname === '/' ? 'mama-guide.html' : u.pathname.slice(1);
  if (existsSync(root + f)) return route.fulfill({ path: root + f });
  return route.fulfill({ status: 404, body: '' });
});

await page.goto('https://www.blinksunited.com/mama-guide.html', { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

// Prove the webfonts actually loaded. Without this the script's happy path
// includes "rendered the whole poster in Arial".
const fonts = await page.evaluate(() => ({
  display: document.fonts.check('100px "Bebas Neue"'),
  mono: document.fonts.check('16px "DM Mono"'),
  serif: document.fonts.check('italic 25px "Cormorant Garamond"'),
  sans: document.fonts.check('17px "IBM Plex Sans"'),
}));
for (const [k, ok] of Object.entries(fonts)) {
  if (!ok) { console.error(`FAILED: the ${k} webfont did not load — not writing a poster in a fallback face.`); process.exit(1); }
}

// The sky is a background image. Screenshotting before it decodes gives a
// poster on flat near-black with no error anywhere, which looks deliberate
// enough to ship by mistake.
// Awaited via decode() rather than polling `complete`: a freshly constructed
// Image is never complete in the same tick it is given a src, so a polling
// version of this check can only ever time out.
const skyW = await page.evaluate(async () => {
  const el = document.querySelector('.sky');
  const url = (getComputedStyle(el).backgroundImage.match(/url\("([^"]+)"\)/) || [])[1];
  if (!url) return 0;
  const im = new Image();
  im.src = url;
  try { await im.decode(); } catch (e) { return 0; }
  return im.naturalWidth;
});
if (!skyW) { console.error('FAILED: the sky image did not load — the poster would render on flat black.'); process.exit(1); }

// The page carries a download bar for anyone who opens it. It must not be
// inside the frame, or the image handed to people has a "Download the guide"
// button printed on it. Asked of the DOM, because nesting is not something you
// can check by looking at tags in the source.
const barInside = await page.evaluate(() => {
  const bar = document.querySelector('.dl-bar');
  return !!(bar && bar.closest('#poster'));
});
if (barInside) { console.error('FAILED: the download bar is inside #poster — it would be baked into the poster.'); process.exit(1); }

const el = await page.$('#poster');
const box = await el.boundingBox();
if (Math.round(box.width) !== 1080 || Math.round(box.height) !== 1350) {
  console.error(`FAILED: poster is ${Math.round(box.width)}x${Math.round(box.height)}, expected 1080x1350.`);
  process.exit(1);
}

// Nothing may be clipped. The poster is a fixed frame and the text inside it is
// not: one more rule, or a longer one, silently crops at the edge, and a
// half-sentence about what voids a vote is worse than no sentence.
const clipped = await page.evaluate(() => {
  const p = document.getElementById('poster');
  const r = p.getBoundingClientRect();
  const bad = [];
  for (const el of p.querySelectorAll('*')) {
    // The galaxy layers bleed past the frame ON PURPOSE — a nebula that stopped
    // at the edge would read as a rectangle pasted on, and the band has to run
    // off both sides to look like it continues. They are decoration and the
    // frame crops them, which is the whole point, so they are not "clipped
    // content" and the check skips them. Everything that carries a word is
    // still checked.
    if (el.closest('.sky')) continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    if (b.bottom > r.bottom - 1 || b.right > r.right - 1 || b.left < r.left - 1) {
      bad.push((el.className || el.tagName) + ': ' + (el.textContent || '').trim().slice(0, 40));
    }
  }
  return bad;
});
if (clipped.length) {
  console.error('FAILED: content is outside the poster frame:\n  ' + clipped.join('\n  '));
  process.exit(1);
}

await el.screenshot({ path: out });
await b.close();
console.log('wrote ' + out + ' (1080x1350 @2x, fonts loaded, nothing clipped)');
