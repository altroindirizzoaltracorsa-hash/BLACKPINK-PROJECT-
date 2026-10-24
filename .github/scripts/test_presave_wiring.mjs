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
