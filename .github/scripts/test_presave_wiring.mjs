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
  localStorage.setItem('ltal_reminder_dismissed_v1','1'); localStorage.setItem('ext_update_dismissed_1.9.8','1'); } catch (e) {} });

// THE CLOCK IS PINNED AN HOUR BEFORE RELEASE for everything below.
//
// This section is about the PRE-SAVE card: a goal bar filling, a countdown in
// jisoo.io's face, a chip that stays hidden until earned. All three stop
// existing when the single lands — renderAddictedSaveCount hides the bar past
// ADDICTED_RELEASE_AT and the timer becomes "OUT NOW ✨" — so against the real
// clock these checks passed for weeks and then went red at 23:00 UTC on the
// 29th, for a page doing exactly what it should.
//
// Same rollover the MAMA round checks hit: a test that encodes one side of a
// deadline is a test with an expiry date on it. The pre-release behaviour is
// tested before the deadline, the released behaviour after it, and neither
// depends on when the suite happens to run.
//
// Taken from the page's own constant, never typed here, so moving the release
// moves both halves of this test with it.
const RELEASE_AT = Date.parse(
  (await readFile(ROOT + '/index.html', 'utf8')
    .then(t => (t.match(/const ADDICTED_RELEASE_AT = '([^']+)'/) || [])[1])) || '');
if (!RELEASE_AT) { fails++; console.log('  FAIL could not read ADDICTED_RELEASE_AT from the page'); }
const pinClock = (pg, at) => pg.addInitScript((t) => {
  const Real = Date;
  // Only now() is frozen. new Date(...) with arguments must keep working, or
  // every date the page parses becomes this instant.
  Date.now = () => t;
}, at);
await pinClock(page, RELEASE_AT - 3600e3);
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

// 3b. The heart and the name are ONE piece of artwork. On the official art
// the lettering crosses the heart's middle; they share a centre. Both ways
// that has broken here were silent and both still drew a handsome card:
// sizing the heart off the card's width alone put 672px of it on a 675px
// canvas, with the top lobes sliced off the edge, and placing it at a
// fraction of the card's height left it floating above the name — a different
// distance above it on each format, because the layouts differ.
//
// So this measures the two rectangles the card really draws, from a real
// draw in both formats. Pixels cannot answer it: the clouds behind are
// bright too, and nothing sampled tells heart from sky.
const art = await page.evaluate(async () => {
  const proto = CanvasRenderingContext2D.prototype;
  const real = proto.drawImage;
  let seen = [];
  proto.drawImage = function (img, x, y, w, h) {
    const src = (img && (img.currentSrc || img.src)) || '';
    if (arguments.length >= 5) seen.push({ src, x, y, w, h });
    return real.apply(this, arguments);
  };
  // Cleared BEFORE the draw it is meant to catch, not after: the first
  // version of this reset the log once the card had already been drawn and
  // then reported, with a straight face, that no heart was ever drawn.
  const shot = async (label, trigger) => {
    seen = [];
    await trigger();
    await new Promise(r2 => setTimeout(r2, 900));
    const c = document.getElementById('card-canvas');
    const pick = (re) => seen.filter(s => re.test(s.src)).pop() || null;
    return { label, w: c.width, h: c.height, heart: pick(/heart-lightning/), title: pick(/logo-full/) };
  };
  const out = [];
  try {
    out.push(await shot('landscape', () => window.openAddictedCard()));
    out.push(await shot('square', async () => document.getElementById('fmt-square').click()));
    document.getElementById('fmt-landscape').click();
    await new Promise(r2 => setTimeout(r2, 900));
  } finally { proto.drawImage = real; }
  return out;
});
// Where ADDICTED itself sits inside the art file, read off the file. The
// lockup is two words — ADDICTED over JISOO — so the image's own centre falls
// in the gap between them, and a heart centred there hangs low enough that
// its lobes vanish behind the letters. Deliberately NOT the fraction the page
// uses: that would only check the number against itself. This finds the blank
// band separating the two words and derives the word's centre from it, so if
// the artwork is ever replaced the expectation follows the new art.
const band = await page.evaluate(async () => {
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej;
    i.src = '/addicted/addicted-logo-full-v2.png';
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const rows = [];
  for (let y = 0; y < c.height; y++) {
    let n = 0;
    for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i + 3] > 24 && d[i] + d[i + 1] + d[i + 2] > 40) n++; }
    rows.push(n);
  }
  const first = rows.findIndex(n => n > 1);
  if (first < 0) return null;
  let last = c.height - 1; while (last > first && rows[last] <= 1) last--;
  let best = null, run = null;
  for (let y = first; y <= last; y++) {
    if (rows[y] <= 1) { run = run || { a: y, b: y }; run.b = y; }
    else if (run) { if (!best || run.b - run.a > best.b - best.a) best = run; run = null; }
  }
  if (run && (!best || run.b - run.a > best.b - best.a)) best = run;
  if (!best) return null;
  return { frac: ((first + best.a) / 2) / c.height, top: first, split: best.a, h: c.height };
});
if (!band) bad('the ADDICTED wordmark can be found in its art file', 'no blank band between the two words');
else ok('ADDICTED sits at this much of its art file', `${Math.round(band.frac * 100)}% down (rows ${band.top}-${band.split} of ${band.h})`);

for (const f of art) {
  if (!f.heart || !f.title) {
    bad(`the heart frames the name on the ${f.label} card`,
        `${!f.heart ? 'no heart' : 'no wordmark'} drawn — ${f.w}x${f.h}`);
    continue;
  }
  const hc = f.heart.y + f.heart.h / 2;
  // The WORD's centre inside the drawn lockup, not the drawn image's.
  const tc = f.title.y + f.title.h * (band ? band.frac : 0.5);
  const gap = Math.abs(hc - tc);
  // Inside the canvas, sharing the wordmark's centre line, and narrower than
  // the wordmark — the name reads ACROSS the heart, it does not sit under it.
  const inside = f.heart.x >= -0.5 && f.heart.y >= -0.5 &&
                 f.heart.x + f.heart.w <= f.w + 0.5 && f.heart.y + f.heart.h <= f.h + 0.5;
  const onCentre = gap <= Math.max(6, f.h * 0.012);
  const across = f.heart.w < f.title.w && f.heart.w > f.title.w * 0.4;
  (inside && onCentre && across)
    ? ok(`the heart frames the name on the ${f.label} card`,
         `heart ${Math.round(f.heart.w)}x${Math.round(f.heart.h)}, centres ${Math.round(gap)}px apart`)
    : bad(`the heart frames the name on the ${f.label} card`,
          !inside   ? `heart runs off the canvas: ${Math.round(f.heart.w)}x${Math.round(f.heart.h)} at ${Math.round(f.heart.x)},${Math.round(f.heart.y)} in ${f.w}x${f.h}`
          : !onCentre ? `heart centre is ${Math.round(gap)}px from ADDICTED's own centre — the lettering is meant to cross the heart's middle`
                      : `heart is ${Math.round(f.heart.w)}px wide against a ${Math.round(f.title.w)}px wordmark`);
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
// ── ADDICTED, ONCE IT IS OUT ────────────────────────────────────────────────
// The other side of the deadline the section above is pinned before. Nothing
// covered this, which is why the release turned three green checks red with
// no code change: the suite only knew the campaign while it was counting down.
console.log('\n--- ADDICTED after release');
{
  const pg = await browser.newPage({ viewport: { width: 414, height: 900 } });
  await pg.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1'); localStorage.setItem('ext_update_dismissed_1.9.8','1'); } catch (e) {} });
  await pinClock(pg, RELEASE_AT + 3600e3);
  await pg.goto(`http://127.0.0.1:${server.address().port}/countdowns/addicted`, { waitUntil: 'load' });
  await pg.waitForFunction(() => typeof window.saveAddicted === 'function', null, { timeout: 30000 }).catch(() => {});

  const after = await pg.evaluate(() => {
    const card = document.querySelector('.cd-card-addicted');
    const btn = [...(card ? card.querySelectorAll('.cd-btn') : [])]
      .find(b => /saveAddicted/.test(b.getAttribute('onclick') || ''));
    // THE KEY COMES FROM THE PAGE. The first version typed 'bu_addicted_saved'
    // and the real constant is 'bu_jisoo_addicted_saved', so it cleared and
    // read a key nothing ever writes: the badge check passed whatever the
    // handler did, and removing the guard it exists to test went green.
    const LS = ADDICTED_SAVE_LS;
    // Clear it first so what we read back is this click's doing, not a leftover.
    try { localStorage.removeItem(LS); } catch (e) {}
    let before = null, got = null;
    try { before = localStorage.getItem(LS); } catch (e) {}
    try { window.saveAddicted(); } catch (e) {}
    try { got = localStorage.getItem(LS); } catch (e) {}
    return {
      goalShown: document.getElementById('addicted-goal')?.style.display,
      label: btn ? btn.textContent.trim() : '(no button)',
      href: btn ? btn.getAttribute('href') : '',
      before, got, key: LS,
    };
  });

  // The bar is a pre-save goal. There is nothing left to pre-save.
  after.goalShown === 'none'
    ? ok('the pre-save goal bar is gone', after.goalShown)
    : bad('the pre-save goal bar is gone', JSON.stringify(after.goalShown));
  // "Pre-save" past the release is an instruction that cannot be followed.
  !/pre-?save/i.test(after.label)
    ? ok('and the button no longer says pre-save', after.label)
    : bad('and the button no longer says pre-save', after.label);
  after.href && /lnk\.to/i.test(after.href)
    ? ok('and still goes to the release link', after.href)
    : bad('and still goes to the release link', after.href || '(none)');
  // THE ONE THAT MATTERS. Early Supporter reads "Pre-saved before release".
  // Renaming the button without this would mean: tap Listen, receive a badge
  // that claims you did something you did not do.
  after.got === null
    ? ok('and clicking it no longer grants Early Supporter')
    : bad('and clicking it no longer grants Early Supporter',
          `${after.key} became ${after.got}`);
  await pg.close();
}

// ── new trick, out since 17 September ───────────────────────────────────────
// The same bug ADDICTED had, six weeks older: the button still said Pre-save
// and the handler still granted "ROSÉ Early Supporter" to anyone who tapped
// it. Gated on newtrickLive(), which the badges grid already uses, so there
// is one source for "is it out" rather than a second copy of the date.
console.log('\n--- new trick after release');
{
  const pg = await browser.newPage({ viewport: { width: 414, height: 900 } });
  await pg.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1'); localStorage.setItem('ext_update_dismissed_1.9.8','1'); } catch (e) {} });
  await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await pg.waitForFunction(() => typeof window.saveNewTrick === 'function', null, { timeout: 30000 }).catch(() => {});

  const r2 = await pg.evaluate(() => {
    const btn = [...document.querySelectorAll('[onclick]')]
      .find(b => /saveNewTrick/.test(b.getAttribute('onclick') || ''));
    const LS = NEWTRICK_SAVE_LS;   // from the page, never typed here
    try { localStorage.removeItem(LS); } catch (e) {}
    try { window.saveNewTrick(); } catch (e) {}
    let got = null; try { got = localStorage.getItem(LS); } catch (e) {}
    return { live: newtrickLive(), label: btn ? btn.textContent.trim() : '(no button)',
             href: btn ? btn.getAttribute('href') : '', got, key: LS };
  });

  r2.live ? ok('new trick reads as released', 'newtrickLive() is true')
          : bad('new trick reads as released', 'newtrickLive() is false — the rest of this means nothing');
  !/pre-?save/i.test(r2.label)
    ? ok('and the button no longer says pre-save', r2.label)
    : bad('and the button no longer says pre-save', r2.label);
  r2.href && /lnk\.to/i.test(r2.href)
    ? ok('and still goes to the release link', r2.href)
    : bad('and still goes to the release link', r2.href || '(none)');
  r2.got === null
    ? ok('and clicking it no longer grants ROSÉ Early Supporter')
    : bad('and clicking it no longer grants ROSÉ Early Supporter', `${r2.key} became ${r2.got}`);
  await pg.close();
}

await browser.close(); server.close();

console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
