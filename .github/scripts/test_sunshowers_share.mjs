// What the Sun Showers share card PRINTS, in a real browser.
//
// Run: node .github/scripts/test_sunshowers_share.mjs
//
// WHY THIS IS NOT A GREP. Every other card on this site counts down to a known
// date, so `drawPresaveCard` was written assuming one exists:
//
//     let diff = Date.parse(d.releaseAt) - Date.now();
//     const isOut = !(diff > 0);
//
// `Date.parse(null)` is NaN, `NaN - Date.now()` is NaN, and `NaN > 0` is false
// — so with no date `isOut` came out TRUE and the card announced "OUT NOW" /
// "JUST RELEASED" for a song nobody has dated. That is the exact mistake the
// card on the page is guarded against (test_sunshowers_claims.mjs), arriving
// by a different route: not a sentence anyone wrote, but arithmetic on a null.
//
// A source check cannot see it. The strings live in six near-identical
// renderers, the guard is one `noDate ?` inside a ternary, and the question is
// what the FAN ENDS UP POSTING. So the test spies on fillText and reads back
// every word the canvas actually set — the card is a picture, and this is the
// only way to read a picture's text.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  // Withhold the service worker: index.html reloads once on `controllerchange`
  // and that reload lands mid-check, tearing down the execution context.
  if (p === '/sw.js') { res.writeHead(404); res.end(''); return; }
  const file = p === '/' ? '/index.html' : SPA.test(p) ? '/index.html' : p;
  try {
    const b = await readFile(ROOT + file); const e = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
      webp: 'image/webp', mp4: 'video/mp4' }[e] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
await page.addInitScript(() => { try {
  localStorage.setItem('bu_tutorial_seen', '1');
  localStorage.setItem('ltal_reminder_dismissed_v1', '1');
  localStorage.setItem('ext_update_dismissed_1.9.8', '1');
} catch (e) {} });
// The spy goes in before any script runs, so it catches the very first draw.
await page.addInitScript(() => {
  window.__cardText = [];
  const proto = CanvasRenderingContext2D.prototype;
  const orig = proto.fillText;
  // Only this canvas. The page has other canvases on timers, and a sparkline
  // redrawing mid-check would put its own axis labels — dates among them —
  // into a list the date assertions below then read as the card's words.
  proto.fillText = function (t, ...rest) {
    try { if (this.canvas && this.canvas.id === 'card-canvas') window.__cardText.push(String(t)); } catch (e) {}
    return orig.call(this, t, ...rest);
  };
});
const errs = [];
page.on('pageerror', e => errs.push(e.message));

await page.goto(base + '/countdowns/sunshowers', { waitUntil: 'domcontentloaded' });
await page.locator('.cd-card-sunshowers').waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);

// A real click on the real button: the wiring is half of what is being tested.
console.log('--- the share button on the card opens a card');
await page.evaluate(() => { window.__cardText = []; });
await page.locator('.cd-card-sunshowers button.cd-btn').click();
await page.waitForTimeout(3000);

const shown = await page.evaluate(() =>
  getComputedStyle(document.getElementById('card-overlay')).display !== 'none');
shown ? ok('the overlay is open') : bad('the overlay is open', 'the button did not open the card');

const thumbs = await page.evaluate(() =>
  [...document.querySelectorAll('#release-pic-picker .release-pic-thumb')].map(t => t.getAttribute('src')));
thumbs.length === 2
  ? ok('it offers both pictures', thumbs.join(', '))
  : bad('it offers both pictures', `${thumbs.length}: ${thumbs.join(', ')}`);

const canvasSize = await page.evaluate(() => {
  const c = document.getElementById('card-canvas');
  return { w: c.width, h: c.height };
});
canvasSize.w === 1200 && canvasSize.h === 675
  ? ok('on a landscape canvas', `${canvasSize.w}x${canvasSize.h}`)
  : bad('on a landscape canvas', `${canvasSize.w}x${canvasSize.h}`);

// What the renderer actually set. Everything below reads this.
const JUST_OUT = /just released|out now|out in \d|available now|streaming now/i;
const DATEY = /\b(20\d\d|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

async function texts() { return page.evaluate(() => window.__cardText.slice()); }

async function checkNoDate(what) {
  const t = await texts();
  t.length ? ok(`${what}: the card printed something`, `${t.length} strings`)
           : bad(`${what}: the card printed something`, 'fillText was never called — nothing was drawn');

  const says = t.find(s => /release date not announced/i.test(s));
  says ? ok(`${what}: it says the date is not announced`, `"${says}"`)
       : bad(`${what}: it says the date is not announced`, `printed: ${JSON.stringify(t.slice(0, 12))}`);

  const tba = t.find(s => /date tba/i.test(s));
  tba ? ok(`${what}: and the countdown slot reads TBA`, `"${tba}"`)
      : bad(`${what}: and the countdown slot reads TBA`, `printed: ${JSON.stringify(t.slice(0, 12))}`);

  // The bug, named: NaN arithmetic reading as "already out".
  const claimed = t.filter(s => JUST_OUT.test(s));
  claimed.length === 0
    ? ok(`${what}: and never claims the song is out`)
    : bad(`${what}: and never claims the song is out`, `printed ${JSON.stringify(claimed)} for a song with no announced date`);

  // A countdown would print digits-and-units; TBA must not be joined by one.
  const counting = t.filter(s => /\b\d+\s*D\s+\d+H/i.test(s));
  counting.length === 0
    ? ok(`${what}: and counts down to nothing`)
    : bad(`${what}: and counts down to nothing`, `printed ${JSON.stringify(counting)}`);

  // No month, no year — on a release card either reads as the release date,
  // whatever sentence it sits in. "ANGRY BIRDS MOVIE 3" has no date token.
  const dated = t.map(s => [s, s.replace(/sun ?showers/ig, ' ').match(DATEY)])
                 .filter(([, m]) => m);
  dated.length === 0
    ? ok(`${what}: and names no month or year`)
    : bad(`${what}: and names no month or year`, dated.map(([s, m]) => `"${m[0]}" in "${s}"`).join('; '));
}

console.log('\n--- the sleeve, which is the default');
await checkNoDate('sleeve');
{
  const t = await texts();
  const cta = t.find(s => /pre-?save/i.test(s));
  cta ? ok('it tells the reader to pre-save', `"${cta}"`)
      : bad('it tells the reader to pre-save', `printed: ${JSON.stringify(t.slice(0, 12))}`);
  if (cta) {
    /JISOO\.lnk\.to\/SunShowers/i.test(cta)
      ? ok('and prints the official link')
      : bad('and prints the official link', `"${cta}"`);
    /[?&](si|is|utm_|_r|_t|ref)=/i.test(cta)
      ? bad('and the link carries no tracking tail', cta)
      : ok('and the link carries no tracking tail');
  }
  // hasLockup: the sleeve already letters the title, so the renderer must NOT
  // set it a second time. The reverse of the cast strip below.
  const titled = t.filter(s => /^sun showers$/i.test(s.trim()));
  titled.length === 0
    ? ok('and does not set the title twice', 'the sleeve letters it already')
    : bad('and does not set the title twice', `printed ${JSON.stringify(titled)} over artwork that already says it`);
}

// The pixels answer whether picking actually redraws; the text answers whether
// the second picture is held to the same rule. Both are needed: the no-date
// guard lives in the renderer, and selectSunShowersCardArt re-enters it with a
// fresh photo and its own flags.
const snap = () => page.evaluate(() => {
  const c = document.getElementById('card-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0; for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) >>> 0;
  return h;
});
const sleeveHash = await snap();

console.log('\n--- the cast illustration, picked from the picker');
await page.evaluate(() => { window.__cardText = []; });
await page.evaluate(() => document.querySelectorAll('#release-pic-picker .release-pic-thumb')[1].click());
await page.waitForTimeout(2500);
const castHash = await snap();
castHash !== sleeveHash
  ? ok('picking it redraws the card')
  : bad('picking it redraws the card', 'the pixels are identical — the thumbnail selects but does not draw');
const castSrc = await page.evaluate(() => _presaveCardData?.photo?.src?.replace(location.origin, '') || null);
castSrc === '/sunshowers/sunshowers-cast.webp'
  ? ok('and the card is holding the cast strip', castSrc)
  : bad('and the card is holding the cast strip', String(castSrc));
await checkNoDate('cast');
{
  // The cast picture carries no lettering, so here the title MUST be drawn —
  // the mirror of the sleeve check above. Same flag, opposite expectation.
  const t = await texts();
  const titled = t.filter(s => /sun showers/i.test(s));
  titled.length
    ? ok('and this one does get a drawn title', `"${titled[0]}"`)
    : bad('and this one does get a drawn title', 'untitled artwork with no title set');
}

// THE FORMAT TOGGLE, which is where the picker used to change releases.
// setCardFormat rebuilds a pre-save card's picker, and it named ADDICTED's
// list and handler outright because ADDICTED was the only pre-save card that
// had one. On Sun Showers, one tap of □ Square rebuilt the picker from
// ADDICTED's pictures and then — no Sun Showers url being in that list — took
// the fallback and redrew the open card as ADDICTED. Checked on the card's own
// data rather than on the thumbnails, because the thumbnails looked plausible:
// they were real pictures of a real release, just not this one.
console.log('\n--- switching to square keeps it the same release');
await page.evaluate(() => { window.__cardText = []; });
await page.evaluate(() => setCardFormat('square', document.getElementById('fmt-square')));
await page.waitForTimeout(2500);
const sq = await page.evaluate(() => ({
  w: document.getElementById('card-canvas').width,
  h: document.getElementById('card-canvas').height,
  campaign: _presaveCardData?.campaign,
  release: _presaveCardData?.release,
  photo: _presaveCardData?.photo?.src?.replace(location.origin, '') || null,
  thumbs: [...document.querySelectorAll('#release-pic-picker .release-pic-thumb')].map(t => t.getAttribute('src')),
}));
sq.w === 1080 && sq.h === 1080
  ? ok('the canvas went square', `${sq.w}x${sq.h}`)
  : bad('the canvas went square', `${sq.w}x${sq.h}`);
sq.campaign === 'sunshowers'
  ? ok('and it is still the Sun Showers card', sq.campaign)
  : bad('and it is still the Sun Showers card', `the open card became "${sq.campaign}"`);
sq.thumbs.every(t => t.startsWith('/sunshowers/'))
  ? ok('and the picker still holds only its own pictures', sq.thumbs.join(', '))
  : bad('and the picker still holds only its own pictures', sq.thumbs.join(', '));
// The cast strip is 2.24:1 and landscape-only, so square must drop back to the
// sleeve rather than leave a pick the format cannot honour.
sq.thumbs.length === 1 && sq.photo === '/sunshowers/sun-showers-cover.webp'
  ? ok('and falls back to the sleeve, which is the square one', sq.photo)
  : bad('and falls back to the sleeve, which is the square one', `${sq.thumbs.length} thumbs, showing ${sq.photo}`);
await checkNoDate('square');

console.log('\n--- and nothing threw');
errs.length === 0 ? ok('no page errors') : bad('no page errors', errs.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
