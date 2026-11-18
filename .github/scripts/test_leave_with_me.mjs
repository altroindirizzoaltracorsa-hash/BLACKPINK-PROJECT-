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
//   · THE LINK. For three weeks there was none, because every other card on
//     this page carries one and the pattern pulled hard toward
//     lalisaofficial.lnk.to/leavewithme — which either 404s or, worse, lands
//     somewhere real and wrong on the thing people screenshot. The MV has
//     since been published, so the card links to THAT and to nothing else.
//     The rule did not change when the link arrived: link what was announced,
//     invent nothing. A lnk.to on this card still fails.
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
  // TWO INSTANTS, THREE HOURS APART, and the card must not confuse them. The
  // SONG dropped at 00:00 KST (15:00Z); the FILM premieres at 18:00Z, which is
  // what the poster's 28 countries time. This card is the song's, so its clock
  // is the song's — a card saying "out in 3h" about a track already on YouTube
  // is wrong in the way nobody reports, because it still looks like it works.
  //
  // cardTargetAt() also PREFERS data-target-local, so that attribute coming
  // back would quietly outrank whatever is set here.
  /data-target="2026-11-18T15:00:00Z"/.test(card)
    ? ok('  counts to the song\'s own release, 00:00 KST')
    : bad('  counts to the song\'s own release, 00:00 KST',
          `got ${(card.match(/data-target="[^"]*"/) || ['none'])[0]}`);
  /data-live-at="2026-11-18T18:00:00Z"/.test(card)
    ? ok('  and carries the film premiere as its own event')
    : bad('  and carries the film premiere as its own event',
          'the premiere is 3h after the song and has to be a separate instant');
  // The check that would have caught the few hours this card spent counting
  // the song down to the film's hour.
  (card.match(/data-target="([^"]*)"/) || [])[1] !== (card.match(/data-live-at="([^"]*)"/) || [])[1]
    ? ok('  and the two are not the same moment')
    : bad('  and the two are not the same moment', 'the song and the film have been collapsed into one instant');
  !/data-target-local=/.test(card)
    ? ok('  and nothing overrides it')
    : bad('  and nothing overrides it',
          'data-target-local wins in cardTargetAt, so the clock would ignore the time the card prints');

  // THE LINK RULE INVERTED, the same way the hour rule did. While nothing had
  // been published the card carried NO link, because every neighbour has a
  // pre-save URL and the pull was to invent one — a guess that either 404s or
  // lands somewhere real and wrong on the card people screenshot. The MV is
  // published, so it goes on; what has to stay true is that this is the ONLY
  // link, and that it is the one that was actually announced.
  const hrefs = [...card.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  hrefs.includes('https://youtu.be/M8fO5lQpfrc')
    ? ok('  links to the official MV')
    : bad('  links to the official MV', hrefs.length ? hrefs.join(', ') : 'no link at all');
  // Nothing else, and in particular nothing lnk.to-shaped: no pre-save has
  // been published for this release, and one invented here is the original
  // failure this card was written to avoid.
  const extra = hrefs.filter((h) => h !== 'https://youtu.be/M8fO5lQpfrc');
  extra.length === 0
    ? ok('  and to nothing that was never published')
    : bad('  and to nothing that was never published',
          `${extra.join(', ')} — only the MV has been announced for this release`);

  // EVERY HOUR PRINTED ON THE CARD IS A CONVERSION OF 18:00Z, computed here
  // rather than compared to a list typed twice. This is the check the old
  // "names no hour" rule turned into: the risk is no longer inventing a time,
  // it is printing a real time converted wrongly — which looks completely
  // normal and sends people to the wrong hour.
  const text = card.replace(/<[^>]+>/g, ' ');
  const PREMIERE = Date.parse('2026-11-18T18:00:00Z');
  const inZone = (tz) => new Intl.DateTimeFormat('en-US',
    { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(PREMIERE)).replace(/\s/g, '').replace(':00', '');
  for (const [label, tz] of [['ET', 'America/New_York'], ['UK', 'Europe/London'],
                             ['India', 'Asia/Kolkata'], ['KST', 'Asia/Seoul']]) {
    const want = inZone(tz);
    const re = new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*' + label, 'i');
    re.test(text.replace(/\s+/g, ' '))
      ? ok(`  ${label} reads ${want}`)
      : bad(`  ${label} reads ${want}`, `the card does not say "${want} ${label}" — 18:00Z is ${want} there`);
  }

  // And it still says which of the two each time belongs to. The hours above
  // are the FILM's; the song's own moment is 00:00 KST. A card carrying both
  // and labelling neither is four numbers a reader will attach to whichever
  // one they came for.
  /ALWAYS LALISA/.test(text) && /premiere/i.test(text)
    ? ok('  and names the film premiere as the film\'s')
    : bad('  and names the film premiere as the film\'s',
          'unlabelled times on a single\'s card read as the single\'s release hour');
  /00:00 KST/.test(text)
    ? ok('  and the song\'s own hour as the song\'s')
    : bad('  and the song\'s own hour as the song\'s', 'the release time it actually dropped at is not on the card');

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

  // The share card and the page card must count to the SAME moment. They are
  // two clocks on one release and nothing else keeps them together.
  /const LWM_RELEASE  = '2026-11-18T15:00:00Z'/.test(ix) && /lwmReleaseAt = \(\) => LWM_RELEASE/.test(ix)
    ? ok('  and the share card counts to the song, like the page does')
    : bad('  and the share card counts to the song, like the page does',
          'two clocks on one release that are set separately will disagree');

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

// ── The clock, read from five places at one instant ────────────────────────
// THIS CHECK IS NOW THE EXACT INVERSE OF WHAT IT USED TO BE, and that is the
// point of keeping it rather than deleting it. While no hour was announced the
// card counted to each reader's own midnight and the rule was "five places,
// five different answers". A worldwide premiere is the opposite rule: everyone
// is waiting for the same moment, so all five must agree to the second.
//
// Getting this backwards is silent either way — a countdown that is wrong by
// time zone still counts down, perfectly, to the wrong instant.
const NOW = '2026-11-17T13:00:00Z';
// 2026-11-17T13:00Z to 2026-11-18T15:00Z is 26 hours exactly, everywhere.
const WAIT_H = 26;
console.log(`\n--- the clock, read at ${NOW} from five places`);
const ZONES = ['Pacific/Auckland', 'Asia/Seoul', 'Europe/Rome',
               'America/New_York', 'America/Los_Angeles'];
const seen = new Set();
for (const tz of ZONES) {
  const r = await clockIn(tz, NOW);
  seen.add(r.timer);
  const m = r.timer.match(/^(\d+)Days(\d+)Hrs/);
  const h = m ? Number(m[1]) * 24 + Number(m[2]) : -1;
  h === WAIT_H
    ? ok(`${tz}: ${h}h to the drop`)
    : bad(`${tz}: ${WAIT_H}h to the drop`, `clock says ${r.timer}`);
}
seen.size === 1
  ? ok('five places, one answer', `all read ${[...seen][0]}`)
  : bad('five places, one answer',
        `${seen.size} distinct — the clock is still each reader's own, not the announced instant`);

// And it is out for EVERYONE at once, not zone by zone. Read a minute after.
console.log('\n--- and a minute after it starts');
const after = new Set();
for (const tz of ZONES) after.add((await clockIn(tz, '2026-11-18T15:01:00Z')).timer);
(after.size === 1 && /OUT NOW/.test([...after][0]))
  ? ok('every zone flips together', [...after][0])
  : bad('every zone flips together', [...after].join(' | '));

await browser.close();
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nThe song is out, the film is not, and the card knows which is which.');
process.exit(fails ? 1 : 0);
