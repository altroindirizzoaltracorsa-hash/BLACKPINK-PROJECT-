// Every countdown card's share button sends THAT countdown's link.
//
// Run: node .github/scripts/test_share_links.mjs
//
// WHAT WENT WRONG. shareCard() picks the link from `_cardType`, and all four
// pre-save releases are drawn by one function and carry the same `_cardType`
// of 'presave'. So the campaign is read out of the card data through a lookup
// table — and that lookup ends in `|| PRESAVE_CARD_LINKS.fa`. A campaign
// missing from the table therefore does not fail. It shares JENNIE's Fallen
// Angel countdown instead, under the right picture, with the right caption.
// Sun Showers shipped that way; Someone to Hold was added the same way a day
// later. Nobody can see it without following the link.
//
// WHY THE EXISTING CHECK DID NOT CATCH IT. test_presave_wiring drives this
// path for ADDICTED only, and its one general assertion is that no two
// campaigns in the table share a link — which says nothing about a campaign
// that is not in the table at all. A check that walks the entries cannot see
// a missing entry. So this one walks the CARDS.
//
// The list comes off the page: every card with a share button is opened, its
// button is pressed, and the link that leaves is compared against the slug on
// that card. Nothing here knows the releases by name, so the next one is
// covered the day its card lands.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ix = await readFile(ROOT + '/index.html', 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

// The card's own element, by depth. A card's block cannot be "up to the next
// card": the last one on the page has no next, and its block would run to the
// end of the file and match any open*Card( in the JavaScript below it.
// Comments are stripped first — several of these cards carry long ones that
// contain markup, and a <div in a comment throws the depth off.
function cardMarkup(slug) {
  const at = ix.indexOf(`data-slug="${slug}"`);
  if (at < 0) return '';
  const open = ix.lastIndexOf('<div', at);
  const src = ix.slice(open).replace(/<!--[\s\S]*?-->/g, '');
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith('<div', i)) depth++;
    else if (src.startsWith('</div>', i)) { if (--depth === 0) return src.slice(0, i + 6); }
  }
  return src;
}

const slugs = [...ix.matchAll(/<div class="cd-card[^"]*"[^>]*data-slug="([^"]+)"/g)].map(m => m[1]);
const cards = [];
for (const slug of slugs) {
  const m = cardMarkup(slug).match(/onclick="(open[A-Za-z]*Card\([^"]*\))"/);
  if (m) cards.push({ slug, call: m[1] });
}
console.log(`    ${cards.length} share buttons on ${slugs.length} cards`);
cards.length >= 7
  ? ok('found the share buttons', cards.map(c => c.slug).join(', '))
  : bad('found the share buttons', `only ${cards.length} — the markup moved, fix this test`);

const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
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

for (const { slug, call } of cards) {
  const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
  await page.addInitScript(() => { try {
    localStorage.setItem('bu_tutorial_seen', '1');
    localStorage.setItem('ext_update_dismissed_1.9.8', '1');
    localStorage.setItem('ltal_reminder_dismissed_v1', '1');
  } catch (e) {} });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  try {
    await page.goto(`${base}/countdowns/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-slug="${slug}"]`).first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    // Open the card the button opens, then press share for real. Reading the
    // lookup table instead would only test this file's own arithmetic — and
    // the table is exactly where the answer was missing, so a check that asks
    // the table is a check that agrees with the bug.
    const sent = await page.evaluate(async (c) => {
      let caption = null, opened = null;
      const realOpen = window.open;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      try {
        await eval(c);
        await sleep(2500);
        // NOT EVERY SHARE BUTTON OPENS A CARD. PRESS PLAY's opens a MENU —
        // picture, video, poster, playlists, link — and the card is one
        // option inside it. Asserting "the button opens a card" would have
        // been a false finding about a feature that works; this follows the
        // menu to its picture instead, which is the option this test is about.
        //
        // Scoped to the sheet that just opened, and by REAL visibility.
        // Searching the whole document for a button saying "picture" found
        // "My login picture" in the settings panel first — present in the
        // markup, invisible on screen, and clicked instead of the menu. A
        // display check on the button itself cannot see that: the button says
        // display:block, it is an ancestor that is hidden. getClientRects()
        // asks whether the thing is actually laid out anywhere.
        const visible = (el) => !!el && el.getClientRects().length > 0;
        if (!visible(document.getElementById('card-overlay'))) {
          const sheet = [...document.querySelectorAll('body > div')]
            .filter(el => visible(el) && getComputedStyle(el).position === 'fixed')
            .pop();
          const pic = sheet && [...sheet.querySelectorAll('button')]
            .filter(visible).find(b => /picture/i.test(b.textContent || ''));
          if (pic) { pic.click(); await sleep(2800); }
        }
        Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { writeText: async (t) => { caption = t; } } });
        window.open = (u) => { opened = u; return null; };
        await window.shareCard();
        await new Promise(r => setTimeout(r, 900));
      } catch (e) { return { err: String((e && e.message) || e) }; }
      finally { window.open = realOpen; }
      return { caption, opened };
    }, call);

    if (sent.err) { bad(`${slug} shares its own countdown`, `${call} threw: ${sent.err}`); }
    else {
      const text = sent.caption || sent.opened || '';
      const url  = (text.match(/https?:\/\/[^\s]+/g) || []).pop() || text.trim().split('\n').pop();
      if (!text) bad(`${slug} shares its own countdown`, 'nothing was shared or copied');
      else if (url && url.includes(`/countdowns/${slug}`))
        ok(`${slug} shares its own countdown`, url);
      else
        bad(`${slug} shares its own countdown`,
            `it sent ${url || '(no link)'} — ${/\/countdowns\//.test(url || '')
              ? 'that is somebody else\'s release' : 'no countdown link at all'}`);
      // The link has to be the real host too. A bare "blinksunited.com" in a
      // caption is not a link on most platforms, and /countdowns/<slug> on its
      // own resolves against whatever the reader is looking at.
      if (url && /\/countdowns\//.test(url)) {
        /^https:\/\/www\.blinksunited\.com\/countdowns\//.test(url)
          ? ok(`  and as a full https link`)
          : bad(`  and as a full https link`, url);
      }
    }
    errs.length === 0 ? ok(`  and nothing threw`) : bad(`  and nothing threw`, errs.slice(0, 2).join(' | '));
  } catch (e) {
    bad(`${slug} shares its own countdown`, String(e.message || e).split('\n')[0]);
  }
  await page.close();
}

await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
