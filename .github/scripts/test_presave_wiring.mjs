// Every pre-save campaign, end to end, in a real browser.
//
// Run: node .github/scripts/test_presave_wiring.mjs
//
// A pre-save campaign is seven things in five places, and the ways it half-
// works are all silent:
//
//   * the page fetches /api/proxy-image?<x>_save=count. If the API has no
//     branch for <x> it does not error — proxy-image falls through and the
//     bar sits at "0 / 50 pre-saved" for the whole campaign, which looks
//     exactly like a release nobody has pre-saved;
//   * the counter key is per campaign. Two releases pointing at one key show
//     the new one opening at the old one's total;
//   * the bar needs three element ids that nothing checks exist;
//   * the badge needs to be in refreshSupporterChips, or the chip never
//     appears for a blink who did pre-save;
//   * and it needs a SPECIAL_BADGES row, or the badge exists on the card and
//     is missing from My Badges.
//
// So this walks the campaigns found in the page and demands all of it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ix  = await readFile(ROOT + '/index.html', 'utf8');
const api = await readFile(ROOT + '/api/proxy-image.js', 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

// Every counter the PAGE asks for, taken from the fetches themselves.
const asked = [...new Set([...ix.matchAll(/proxy-image\?([a-z_]+)_save=(?:count|increment)/g)].map(m => m[1]))];
// countPresaveOnce builds its URL from an endpoint argument, so catch those too.
for (const m of ix.matchAll(/countPresaveOnce\([A-Z_]+,\s*'([a-z_]+)_save'/g)) {
  if (!asked.includes(m[1])) asked.push(m[1]);
}
console.log(`    campaigns in the page: ${asked.join(', ')}`);
asked.length >= 5 ? ok('the pre-save campaigns were found') : bad('the pre-save campaigns were found', asked.join(','));

// 1. The API answers each one, and with a key of its own.
const keys = {};
for (const c of asked) {
  const handled = new RegExp(`req\\.query\\.${c}_save\\s*===\\s*'count'`).test(api);
  handled ? ok(`  the API handles ${c}_save`)
          : bad(`  the API handles ${c}_save`, 'no branch — the bar will read 0 for the whole campaign');
  const km = api.match(new RegExp(`campaign === '${c}'\\s*\\?\\s*'([a-z_]+)'`));
  if (km) keys[c] = km[1];
}
const seen = {};
for (const [c, k] of Object.entries(keys)) { (seen[k] ||= []).push(c); }
const shared = Object.entries(seen).filter(([, cs]) => cs.length > 1);
shared.length
  ? bad('each campaign counts into its own key', shared.map(([k, cs]) => `${k}: ${cs.join(' + ')}`).join('; '))
  : ok('each campaign counts into its own key', Object.values(keys).length + ' keys');

// 2. ADDICTED specifically, in the browser: the bar, the ids, the button.
const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  // Stand in for the counter so the bar has a number to render.
  // No service worker in tests. The page registers one and reloads once
  // when it takes control — by design, so a visitor swaps to the fresh
  // build — but inside a test that is a navigation landing in the middle
  // of sampling, and it destroys the execution context. It cost three
  // runs in ten before this.
  if (p === '/sw.js') { res.writeHead(404); return res.end(''); }
  if (p === '/api/proxy-image' && /addicted_save=count/.test(req.url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ count: 37 }));
  }
  const file = p === '/' ? '/index.html' : SPA.test(p) ? '/index.html' : p;
  try { const b = await readFile(ROOT + file); const e = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html:'text/html', js:'text/javascript', css:'text/css',
      json:'application/json', svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg',
      webp:'image/webp', woff2:'font/woff2', ttf:'font/ttf', mp4:'video/mp4' }[e] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(r => server.listen(0, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 414, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen','1');
  localStorage.setItem('ltal_reminder_dismissed_v1','1'); localStorage.setItem('ext_update_dismissed_1.9.7','1'); } catch (e) {} });
await page.goto(`http://127.0.0.1:${server.address().port}/countdowns/addicted`, { waitUntil: 'load' });
// Wait for the page to have FILLED IN, not for a number of seconds. The bar
// arrives over a fetch, and the card now also pulls three.js and a 933KB
// model alongside it; a fixed sleep that was comfortable before that went in
// started losing a race about one run in three, and read an empty bar as a
// broken one.
await page.waitForFunction(() => {
  const el = document.getElementById('addicted-goal-nums');
  return typeof window.openAddictedCard === 'function' && el && /\d/.test(el.textContent || '');
}, null, { timeout: 30000 }).catch(() => {});

const r = await page.evaluate(() => {
  const el = id => document.getElementById(id);
  const card = document.querySelector('.cd-card-addicted');
  const clock = card && card.querySelector('.cd-timer-plain span');
  return {
    goal: !!el('addicted-goal'), nums: el('addicted-goal-nums')?.textContent || '',
    fill: el('addicted-goal-fill')?.style.width || '', badge: !!el('addicted-badge'),
    goalShown: el('addicted-goal')?.style.display,
    // The badge chip must be hidden for someone who has not pre-saved.
    badgeShown: el('addicted-badge')?.style.display,
    clockFont: clock ? getComputedStyle(clock).fontFamily : '',
    fns: ['saveAddicted','openAddictedCard','renderAddictedBadge','loadAddictedSaveCount','addictedEarlySupporterEarned']
      .filter(n => typeof window[n] !== 'function'),
    buttons: [...(card ? card.querySelectorAll('.cd-btn') : [])].map(b => b.textContent.trim()),
    onclicks: [...(card ? card.querySelectorAll('[onclick]') : [])].map(b => b.getAttribute('onclick')),
  };
});
r.goal && r.badge ? ok('the bar and the chip are both in the page')
                  : bad('the bar and the chip are both in the page', JSON.stringify({ goal: r.goal, badge: r.badge }));
r.fns.length ? bad('every function the card calls exists', r.fns.join(', '))
             : ok('every function the card calls exists');
// The ids have to be the ones the renderer writes to, which only shows up as
// a number actually arriving on screen.
r.nums.includes('37') && r.goalShown === 'flex'
  ? ok('a served count reaches the bar', `"${r.nums.replace(/\s+/g,' ').trim()}" · fill ${r.fill}`)
  : bad('a served count reaches the bar', JSON.stringify({ nums: r.nums, shown: r.goalShown }));
r.fill && parseFloat(r.fill) > 0 && parseFloat(r.fill) <= 100
  ? ok('and moves the bar', r.fill) : bad('and moves the bar', r.fill || '(unset)');
r.badgeShown === 'none'
  ? ok('the Early Supporter chip stays hidden until it is earned')
  : bad('the Early Supporter chip stays hidden until it is earned', r.badgeShown);
/Cinzel/i.test(r.clockFont)
  ? ok("the clock is in jisoo.io's own face", r.clockFont)
  : bad("the clock is in jisoo.io's own face", r.clockFont);
r.buttons.some(b => /share/i.test(b)) ? ok('the share button is on the card')
                                      : bad('the share button is on the card', r.buttons.join(' | '));
r.onclicks.some(a => /saveAddicted/.test(a))
  ? ok('the pre-save link is counted') : bad('the pre-save link is counted', r.onclicks.join(' | '));

// 3. The share card actually draws — not a blank canvas, which is what a
// failed image load or a thrown draw leaves behind.
const drew = await page.evaluate(async () => {
  await window.openAddictedCard();
  await new Promise(r2 => setTimeout(r2, 1500));
  const c = document.getElementById('card-canvas');
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < px.length; i += 4 * 97) if (px[i] + px[i+1] + px[i+2] > 60) lit++;
  return { w: c.width, h: c.height, litFraction: lit / (px.length / (4 * 97)) };
});
drew.w === 1200 && drew.h === 675 ? ok('the share card is the right size', `${drew.w}×${drew.h}`)
                                  : bad('the share card is the right size', JSON.stringify(drew));
drew.litFraction > 0.5
  ? ok('and it actually drew something', `${Math.round(drew.litFraction * 100)}% of sampled pixels are not black`)
  : bad('and it actually drew something', `${Math.round(drew.litFraction * 100)}% — a blank card`);

// 3c. ADDICTED's type sits on the same middle line as its art. The lockup is
// inside a centred heart, so a block starting at the left margin reads as a
// mistake — the heart on one axis and the name under it on another. Checked
// by recording what the card actually asks the canvas to draw, because the
// alignment is gone by the time the pixels exist and no pixel test tells
// "centred" from "nearly centred" on a photographic background.
const align = await page.evaluate(async () => {
  const proto = CanvasRenderingContext2D.prototype;
  const real = proto.fillText;
  const seen = [];
  proto.fillText = function (txt, x, y) { seen.push({ txt: String(txt), x, a: this.textAlign }); return real.apply(this, arguments); };
  try {
    await window.openAddictedCard();
    await new Promise(r2 => setTimeout(r2, 1500));
  } finally { proto.fillText = real; }
  const c = document.getElementById('card-canvas');
  return { w: c.width, seen };
});
{
  // The lines of the block itself — not BLINKS UNITED or the site mark, which
  // are corner marks and belong in their corners.
  const body = align.seen.filter(s => /PRE-SAVED|PRE-SAVE|Oct 30|OUT IN|COUNTDOWN TO RELEASE|JUST RELEASED/i.test(s.txt));
  const off = body.filter(s => s.a !== 'center' || Math.abs(s.x - align.w / 2) > 2);
  body.length >= 3 && off.length === 0
    ? ok('the ADDICTED card centres its type under the art', `${body.length} lines on the middle line`)
    : bad('the ADDICTED card centres its type under the art',
          body.length < 3 ? `only found ${body.length} lines of the block`
                          : off.map(s => `"${s.txt.slice(0, 22)}" ${s.a}@${Math.round(s.x)}`).join(', ') + ` (centre is ${align.w / 2})`);
}

// 3a. What the SHARE button sends. Every campaign drawn by drawPresaveCard
// carries _cardType 'presave', so a single hardcoded link in shareCard stood
// in for all of them and ADDICTED's card shared JENNIE's countdown — the
// right picture under the wrong link, which looks perfectly fine until
// somebody follows it. Read through the same table shareCard reads.
// Driven through shareCard itself, with the share sheet and the clipboard
// stubbed to record. Asking the lookup table what it holds would only test
// this file's own arithmetic — the first version of this check did exactly
// that and stayed green with the bug put back.
const links = await page.evaluate(async () => {
  let caption = null, opened = null;
  const realOpen = window.open;
  try {
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { caption = t; } } });
    window.open = (u) => { opened = u; return null; };
    await window.shareCard();
    await new Promise(r2 => setTimeout(r2, 800));
  } catch (e) { return { err: String(e && e.message || e) }; }
  finally { window.open = realOpen; }
  const t = (typeof PRESAVE_CARD_LINKS !== 'undefined') ? PRESAVE_CARD_LINKS : {};
  return { caption, opened, table: t };
});
{
  // The card open at this point is ADDICTED's, drawn above.
  const sent = links.caption || links.opened || '';
  if (links.err) bad('the ADDICTED card shares the ADDICTED countdown', `shareCard threw: ${links.err}`);
  else if (!sent) bad('the ADDICTED card shares the ADDICTED countdown', 'nothing was shared or copied');
  else /\/countdowns\/addicted(\s|$)/.test(sent)
    ? ok('the ADDICTED card shares the ADDICTED countdown', sent.split('\n').pop())
    : bad('the ADDICTED card shares the ADDICTED countdown',
          `it sent ${sent.split('\n').pop()} — that is somebody else's release`);
  const vals = Object.values(links.table || {});
  vals.length >= 2 && new Set(vals).size === vals.length
    ? ok('and no two campaigns share one link', `${vals.length} campaigns`)
    : bad('and no two campaigns share one link', vals.join(' | ') || 'no table');
}

// 3b. The lightning heart has to FIT, on both shapes of card. It was sized off
// the width alone, which is fine at 1:1 and wrong at 16:9: 56% of 1200px is
// 672px of heart on a 675px canvas, so the landscape card drew a heart with
// its top lobes sliced off the edge and the lockup lying across its middle.
// Nothing threw and the card above still read as "drew something".
// Asked of the overlay itself, with a recording context, so the answer is the
// rectangle the card really draws rather than a guess from pixels — clouds
// are bright too, and no pixel test can tell heart from sky reliably.
const fit = await page.evaluate(() => {
  // Not window._presaveCardData: it is a top-level `let`, which makes a global
  // binding that is NOT a property of window, so that reads undefined.
  const data = (typeof _presaveCardData !== 'undefined') ? _presaveCardData : null;
  const ov = data && data.overlay;
  if (typeof ov !== 'function') return null;
  const out = [];
  for (const [w, h, name] of [[1200, 675, 'landscape'], [1080, 1080, 'square']]) {
    let box = null;
    const rec = { save(){}, restore(){}, set globalAlpha(v){}, get globalAlpha(){ return 1; },
                  drawImage(img, x, y, dw, dh) { box = { x, y, dw, dh }; } };
    ov(rec, w, h);
    out.push({ name, w, h, box });
  }
  return out;
});
if (!fit) { bad('the lightning heart fits the card', 'no overlay on the card data'); }
else for (const f of fit) {
  if (!f.box) { bad(`the lightning heart fits the ${f.name} card`, 'nothing drawn'); continue; }
  const { x, y, dw, dh } = f.box;
  const inside = x >= 0 && y >= 0 && x + dw <= f.w + 0.5 && y + dh <= f.h + 0.5;
  // And big enough to still read as the artwork rather than a sticker.
  const big = dw >= f.w * 0.25 && dh >= f.h * 0.25;
  (inside && big)
    ? ok(`the lightning heart fits the ${f.name} card`,
         `${Math.round(dw)}×${Math.round(dh)} at ${Math.round(x)},${Math.round(y)} in ${f.w}×${f.h}`)
    : bad(`the lightning heart fits the ${f.name} card`,
          !inside ? `drawn ${Math.round(dw)}×${Math.round(dh)} at ${Math.round(x)},${Math.round(y)} — ${
                      y < 0 ? `${Math.round(-y)}px off the top` :
                      x < 0 ? `${Math.round(-x)}px off the left` : 'past the bottom or right edge'}`
                  : `only ${Math.round(dw)}×${Math.round(dh)} on a ${f.w}×${f.h} card — too small to read`);
}

// 4. Each campaign's badge is wired into both places that show it.
for (const [ls, name] of [['ADDICTED_SAVE_LS', 'addicted'], ['JISOO_SAVE_LS', 'jisoo'],
                          ['NEWTRICK_SAVE_LS', 'newtrick'], ['FA_SAVE_LS', 'fa'], ['LISA_SAVE_LS', 'lisa']]) {
  if (!ix.includes(`const ${ls}`)) continue;
  const inChips = new RegExp(`render${name[0].toUpperCase()}`, 'i');
  const earned = new RegExp(`${name}EarlySupporterEarned\\(\\)`, 'i');
  const chips = ix.slice(ix.indexOf('async function refreshSupporterChips'), ix.indexOf('async function refreshSupporterChips') + 900);
  earned.test(chips) || inChips.test(chips)
    ? ok(`  ${name} is refreshed with the other chips`)
    : bad(`  ${name} is refreshed with the other chips`, 'the chip will never appear');
}
// ADDICTED must also be on My Badges, or it is a badge you cannot see.
/jisoo-addicted-presave/.test(ix) && /addictedEarlySupporterEarned\(\)/.test(ix)
  ? ok('ADDICTED has a row on My Badges')
  : bad('ADDICTED has a row on My Badges');

if (errs.length) { console.log('    page errors: ' + errs.slice(0,3).join(' | ')); fails += errs.length; }
await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
