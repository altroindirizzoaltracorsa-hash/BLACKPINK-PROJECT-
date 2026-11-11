// "Leave With Me" is counted down WITHOUT a pre-save link and WITHOUT an hour.
//
// Run: node .github/scripts/test_leave_with_me.mjs
//
// NEITHER ABSENCE IS A RULE. Both are just facts about Nov 2026 — nothing
// official has been published for either — and the day one is announced, put
// it on the card and delete the check for it here. That edit is expected.
// What this guards against is the OTHER way those gaps get filled: a plausible
// value written in because every neighbouring card has one.
//
//   · NO LINK. Every other card on this page carries one, so the pattern
//     pulls hard toward lalisaofficial.lnk.to/leavewithme — which either 404s
//     or, worse, lands somewhere real and wrong. This card is the thing
//     people screenshot.
//
//   · NO HOUR. The card counts to MIDNIGHT ON THE READER'S OWN CLOCK
//     (data-target-local), and says so. Writing "1PM KST / 12AM EST" in the
//     sub, the way the dated cards do, would be making a time up — and a
//     countdown that reaches zero before the song exists is the one failure a
//     countdown cannot survive.
//
// THE ART IS THE FILM'S POSTER, because the song is her song for ALWAYS
// LALISA. Checked here for one reason: the poster prints "IN CINEMAS … /
// OCTOBER 12" across its top, and the shipped file is CROPPED above her hair
// to remove it. Restore the full-height original and the card carries two
// dates — the film's cinema date inches above the song's — with nothing
// saying which is which. The check is on the file's proportions, because
// that is the only thing here that can tell a cropped poster from an uncropped
// one.
//
// The timezone sweep is the half that static text cannot prove. "Midnight
// where you are" is a claim PRINTED ON THE CARD, so it is read from five
// places at one fixed instant and each must get a different answer: a card
// counting to a single worldwide instant hands them all the same number and
// passes every eyeball test. Date.parse('2026-11-18') is the specific trap —
// that is UTC midnight, and it makes Los Angeles sixteen hours early.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ix = await readFile(ROOT + '/index.html', 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

// ── the card's own element ───────────────────────────────────────────────────
// Bounded by DIV DEPTH, not by the next card: the cards that follow carry long
// comments full of markup, and a window that ran to the next <div class="cd-card
// would sweep a neighbour's pre-save link in and call it this card's.
// Comments are stripped first — this card's own comment explains the missing
// link by naming the link that is missing, and matching your own explanation of
// an absence as the thing being absent is its own kind of false positive.
function cardMarkup() {
  const at = ix.indexOf('data-slug="leavewithme"');
  if (at < 0) return '';
  const open = ix.lastIndexOf('<div', at);
  const src = ix.slice(open).replace(/<!--[\s\S]*?-->/g, '');
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith('<div', i)) depth++;
    else if (src.startsWith('</div>', i)) { if (--depth === 0) return src.slice(0, i + 6); }
  }
  return '';
}

// WebP dimensions straight out of the header — no image library, because the
// only thing needed is two numbers and this test should not acquire a
// dependency to read them. Handles the three container shapes: VP8 (lossy),
// VP8L (lossless), VP8X (extended).
async function posterSize(path) {
  let b;
  try { b = await readFile(path); } catch { return null; }
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const tag = b.toString('ascii', 12, 16);
  if (tag === 'VP8 ')  return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (tag === 'VP8L') {
    const n = b.readUInt32LE(21);
    return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 };
  }
  if (tag === 'VP8X') {
    const u24 = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    return { w: u24(24) + 1, h: u24(27) + 1 };
  }
  return null;
}

console.log('--- the card on the page');
const card = cardMarkup();
card ? ok('found the card', `${card.length} chars`)
     : bad('found the card', 'nothing below means anything');

if (card) {
  /data-target-local="2026-11-18"/.test(card)
    ? ok('  counts to the reader\'s own midnight on Nov 18')
    : bad('  counts to the reader\'s own midnight on Nov 18',
          'without data-target-local the clock runs to one worldwide instant nobody announced');

  // The floor the countdown falls back on. It must still be the 18th: a
  // fallback on the wrong day is worse than none, because nothing reports it.
  /data-target="2026-11-18T\d\d:\d\d:\d\dZ"/.test(card)
    ? ok('  with a same-day floor for readers of data-target')
    : bad('  with a same-day floor for readers of data-target',
          'liveCountdownFor ranks on data-target and the card is skipped without one');

  !/<a\b/.test(card)
    ? ok('  and carries no link at all')
    : bad('  and carries no link at all',
          `${(card.match(/href="([^"]*)"/g) || []).join(', ')} — nothing official has been published to link to`);

  // Any clock time in the visible copy. Deliberately broad: KST/EST were the
  // shapes used on the other cards, "12AM"/"9:00" are what a hand edit writes.
  const text = card.replace(/<[^>]+>/g, ' ');
  const hour = text.match(/\b\d{1,2}\s*(?:AM|PM)\b|\b\d{1,2}:\d{2}\b|\b(?:KST|EST|EDT|PST|PDT|CET|UTC|GMT)\b/i);
  !hour ? ok('  and names no hour')
        : bad('  and names no hour', `"${hour[0]}" — no release time has been announced`);

  // The clock is counting to something the reader cannot see named, so the
  // card has to say what. Without this line it silently asserts a time.
  /midnight where you are/i.test(text)
    ? ok('  but does say what it is counting to')
    : bad('  but does say what it is counting to',
          'an unexplained clock is a time claim with no source');

  /onclick="openLeaveWithMeCard\(\)"/.test(card)
    ? ok('  and can be posted')
    : bad('  and can be posted', 'every release card offers a share card');

  const poster = /src="(\/leavewithme\/[^"]+)"/.exec(card);
  poster ? ok('  shows the ALWAYS LALISA poster', poster[1])
         : bad('  shows the ALWAYS LALISA poster', 'the song is her song for the film');
  if (poster) {
    // The width/height attributes have to match the file, or the card
    // reserves the wrong box and everything under it jumps when the image
    // arrives. They are also how the crop is pinned, below.
    const wh = /class="lwm-poster"[^>]*?width="(\d+)"[^>]*?height="(\d+)"/.exec(card);
    const dim = await posterSize(ROOT + poster[1]);
    wh && dim && Number(wh[1]) === dim.w && Number(wh[2]) === dim.h
      ? ok('    with width/height matching the file', `${dim.w}x${dim.h}`)
      : bad('    with width/height matching the file',
            `markup says ${wh ? wh[1] + 'x' + wh[2] : 'nothing'}, file is ${dim ? dim.w + 'x' + dim.h : 'unreadable'}`);

    // THE CROP. The original is 1400x2068 — 1.477 tall per wide. The shipped
    // file has 180px taken off the top, which is 1.349. Anything at or above
    // the original's ratio means the "IN CINEMAS … OCTOBER 12" band is back.
    // Bounded below as well: a crop that kept going would start eating her.
    const ratio = dim ? dim.h / dim.w : 0;
    ratio > 1.24 && ratio < 1.41
      ? ok('    cropped above the film\'s "OCTOBER 12" line', `${ratio.toFixed(3)} tall per wide`)
      : bad('    cropped above the film\'s "OCTOBER 12" line',
            `${ratio.toFixed(3)} — the uncropped poster is 1.477 and carries the film's cinema date`);

    /ALWAYS LALISA/.test(text)
      ? ok('    and the card names the documentary')
      : bad('    and the card names the documentary',
            'the art says ALWAYS LALISA and nothing on the card says what that is');

    // Nothing but the song's own date on the card, now that the poster
    // carries none: "Oct 12" written back into the copy is the same confusion
    // arriving by the other door.
    !/\boct(ober)?\s*12\b/i.test(text)
      ? ok('    and no date on the card but the song\'s')
      : bad('    and no date on the card but the song\'s',
            'the film\'s cinema date is back in the copy, inches from "Out Nov 18"');
  }
}

console.log('\n--- the share card');
const fn = (ix.match(/async function openLeaveWithMeCard\(\)[\s\S]*?\n}\n/) || [''])[0];
fn ? ok('found openLeaveWithMeCard()', `${fn.split('\n').length} lines`)
   : bad('found openLeaveWithMeCard()');

if (fn) {
  const body = fn.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  !/https?:\/\//.test(body) && !/lnk\.to|ffm\.to/.test(body)
    ? ok('  carries no link either')
    : bad('  carries no link either', 'a card outlives the moment it was made — a guessed link on one is worse than none');

  // The same trap as on the page, in the one place it is easy to reintroduce:
  // releaseAt is a STRING, so a plain date string here is UTC midnight.
  /new Date\(LWM_DAY\[0\], LWM_DAY\[1\] - 1, LWM_DAY\[2\]/.test(ix)
    ? ok('  and builds its release instant from parts, not Date.parse')
    : bad('  and builds its release instant from parts, not Date.parse',
          "Date.parse('2026-11-18') is UTC midnight — sixteen hours early in Los Angeles");

  // The poster is portrait and the card is landscape, so without fitWhole a
  // cover-crop shows a horizontal slice of her waist and nothing else.
  /fitWhole: true/.test(body)
    ? ok('  and shows the poster whole rather than cropping it to fill')
    : bad('  and shows the poster whole rather than cropping it to fill',
          'a portrait poster cover-cropped into a 16:9 card is a band across its middle');

  /campaign: 'leavewithme'/.test(body) && /d\.campaign === 'leavewithme'/.test(ix)
    ? ok('  and has its own caption, not the pre-save one')
    : bad('  and has its own caption, not the pre-save one',
          'the shared wording ends "every one counts", which is about pre-saves there are none of');
}

// ── the clock, from five places at one instant ───────────────────────────────
const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  // Withheld: index.html reloads once on controllerchange and that reload
  // lands mid-check, tearing down the context a locator is waiting in.
  if (p === '/sw.js') { res.writeHead(404); res.end(''); return; }
  const file = p === '/' ? '/index.html' : SPA.test(p) ? '/index.html' : p;
  try {
    const b = await readFile(ROOT + file);
    res.writeHead(200, { 'content-type': { html:'text/html', js:'text/javascript', css:'text/css',
      json:'application/json', svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg',
      webp:'image/webp', mp4:'video/mp4' }[file.split('.').pop()] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

async function clockIn(tz, nowISO) {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, timezoneId: tz });
  await page.addInitScript(() => { try {
    localStorage.setItem('bu_tutorial_seen', '1');
    localStorage.setItem('ltal_reminder_dismissed_v1', '1');
    localStorage.setItem('ext_update_dismissed_1.9.8', '1');
  } catch (e) {} });
  await page.addInitScript(`(()=>{const t=Date.parse(${JSON.stringify(nowISO)});const R=Date;
    const D=function(...a){return a.length?new R(...a):new R(t)};
    D.prototype=R.prototype;D.now=()=>t;D.parse=R.parse;D.UTC=R.UTC;globalThis.Date=D;})()`);
  await page.goto(base + '/countdowns/leavewithme', { waitUntil: 'domcontentloaded' });
  await page.locator('.cd-card-lwm').waitFor({ timeout: 20000 });
  await page.waitForTimeout(2200);
  const r = await page.locator('.cd-card-lwm').evaluate(el => ({
    timer: el.querySelector('[data-timer]').textContent.replace(/\s+/g, ' ').trim(),
    text:  el.textContent.replace(/\s+/g, ' ').trim(),
  }));
  await page.close();
  return r;
}

// Hours each zone still waits, from 2026-11-17T13:00Z, to ITS OWN midnight.
const NOW = '2026-11-17T13:00:00Z';
const ZONES = [
  ['Pacific/Auckland',    'OUT'],  // +13 — its 18th began hours ago
  ['Asia/Seoul',            2],    // +9
  ['Europe/Rome',           10],   // +1 (CET in November, not CEST)
  ['America/New_York',      16],   // -5 (EST in November)
  ['America/Los_Angeles',   19],   // -8
];
console.log(`\n--- the clock, read at ${NOW} from five places`);
for (const [tz, wantH] of ZONES) {
  const r = await clockIn(tz, NOW);
  if (wantH === 'OUT') {
    /OUT NOW/.test(r.timer)
      ? ok(`${tz}: already out`, 'its own midnight has passed')
      : bad(`${tz}: already out`, r.timer);
  } else {
    const m = r.timer.match(/^(\d+)Days(\d+)Hrs/);
    const h = m ? Number(m[1]) * 24 + Number(m[2]) : -1;
    h === wantH
      ? ok(`${tz}: ${h}h to its own midnight`)
      : bad(`${tz}: ${wantH}h to its own midnight`, `clock says ${r.timer}`);
  }
}

// If every zone agreed, the local rule is not running at all — and the five
// checks above would still pass on whichever single zone happened to match.
const spread = new Set();
for (const [tz] of ZONES) spread.add((await clockIn(tz, NOW)).timer);
spread.size === ZONES.length
  ? ok('five places, five different answers', 'the clock really is each reader\'s own')
  : bad('five places, five different answers',
        `${spread.size} distinct — a single worldwide instant gives everyone the same number`);

await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nNo link, no hour, and the clock is yours.');
process.exit(fails ? 1 : 0);
