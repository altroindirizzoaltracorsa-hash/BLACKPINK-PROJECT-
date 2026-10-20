// Render the link-preview image for /collabs.
//
// Run: node .github/scripts/render_collab_card.mjs [--out collab-card.jpg]
//
// WHY THIS IS NOT AN API ROUTE. og:image has to be a real PNG at a URL: X does
// not run our JavaScript, and it does not take SVG. Rendering one per request
// would mean a second drawing of the same card — in a different language, with
// a different layout engine — and two cards that are meant to agree are two
// cards that will not. So the card is drawn by the PAGE'S OWN drawCollabCard,
// in a real browser, and the result is committed as a static file. One
// implementation, and the preview cannot disagree with the download.
//
// It is also free: no image library, no serverless rendering, no new runtime
// dependency on a deploy that serves a million other things.
//
// The numbers come from production's own endpoint, because the point is a
// preview that reflects what the board actually says. If that fetch fails the
// card still renders — as the invitation, which is what the page shows with no
// votes in it — rather than failing the job and leaving a stale image.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const API = 'https://www.blinksunited.com/api/collabs?id=bvp-kca-2026';
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : `${ROOT}/collab-card.jpg`;

// 1200x630 is the size X and Facebook crop to. The in-page "wide" card is
// 1200x675, and the 45px difference is taken off the bottom — which is where
// the URL and the four handles sit, so the preview is drawn at the exact
// preview size rather than cropped from a bigger one.
const W = 1200, H = 630;

let tally = null;
try {
  const r = await fetch(API, { headers: { accept: 'application/json' } });
  if (r.ok) tally = await r.json();
  console.log(`api: HTTP ${r.status}`);
} catch (e) {
  console.log(`api: unreachable (${e.message}) — drawing the invitation card`);
}
if (tally && tally.periods && tally.periods.all) {
  const n = Object.values(tally.periods.all.byCat || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  console.log(`api: ${n} votes across ${Object.keys(tally.periods.all.byCat || {}).length} categories`);
  // An endpoint answering with an empty board is a collab nobody has voted in
  // yet, and the card says so by drawing the invitation — the same rule the
  // page follows rather than a 0-0 preview.
  if (!n) tally = null;
}

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = p === '/collabs' ? '/collabs.html' : p;
  try {
    const buf = await readFile(ROOT + file);
    const ext = file.split('.').pop();
    res.writeHead(200, {
      'content-type': { html: 'text/html', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        png: 'image/png', webp: 'image/webp', js: 'text/javascript', css: 'text/css' }[ext]
        || 'application/octet-stream',
    });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
// The page fetches the endpoint itself on load; the numbers are injected
// instead, so the render does not depend on the sandbox reaching the network.
await page.route('**/api/collabs*', (r) => r.abort());
await page.goto(`${base}/collabs`, { waitUntil: 'domcontentloaded' });
// The fonts are the card: drawn before they load it comes out in Times.
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);

const meta = await page.evaluate(async ({ w, h, data }) => {
  const c = COLLABS.filter((x) => x.status === 'live')[0];
  if (!c) return null;
  if (data) c.tally = data;
  PERIOD = 'all';
  // The page's own logo loader, so the preview carries what the download does.
  await cardLogo();
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const m = drawCollabCard(cv, c, { coarseLeft: true });
  return { png: cv.toDataURL('image/jpeg', 0.92), bodyBottom: m.bodyBottom, footTop: m.footTop,
           rows: (m.rows || []).map((r) => `${r.label} ${r.shown}`) };
}, { w: W, h: H, data: tally });

if (!meta) { console.error('::error::no live collab to draw'); process.exit(1); }
if (errs.length) { console.error(`::error::page errors: ${errs.join(' | ')}`); process.exit(1); }
// The same invariant the page tests assert: the body must not reach the
// footer. A preview is the one card nobody looks at before it goes out.
if (meta.bodyBottom > meta.footTop) {
  console.error(`::error::the card overflows at ${W}x${H}: `
    + `body ends at ${Math.round(meta.bodyBottom)}, footer starts at ${Math.round(meta.footTop)}`);
  process.exit(1);
}

await writeFile(OUT, Buffer.from(meta.png.split(',')[1], 'base64'));
console.log(`wrote ${OUT}`);
console.log(meta.rows.length ? `rows: ${meta.rows.join(' · ')}` : 'rows: none — invitation card');
console.log(`::notice title=collab-card::${meta.rows.length ? meta.rows.join(' · ') : 'invitation card (no votes logged yet)'}`);

await browser.close();
server.close();
