// Every countdown card tells the reader the time in THEIR zone.
//
// Run: node .github/scripts/test_local_times.mjs
//
// The cards name one or two foreign zones each — 1PM KST, 12AM EDT, 12AM PT —
// which answer the question for two countries and leave everyone else doing
// arithmetic badly. Each card now also prints the same instant on the reader's
// own clock.
//
// What makes this worth running rather than eyeballing: the computed line is
// checked AGAINST THE CARD'S OWN HAND-TYPED LABEL. Read from Seoul, the line
// must say what the card already claims for KST; from Los Angeles, what it
// claims for PT. Either a broken mechanism or a mistyped label breaks the
// agreement, and no single-timezone look at the page can see either.
// Every countdown, read from several places. The cross-check that makes this
// worth running: in Seoul the computed line must agree with the KST the card
// already prints, and in New York with its EDT. If the mechanism is wrong the
// two disagree; if a hand-typed label is wrong, likewise.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA=/^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server=createServer(async(req,res)=>{const p=decodeURIComponent(req.url.split('?')[0]);
  // Withhold the service worker. index.html reloads once on
  // `controllerchange`, and that reload lands mid-check and tears down the
  // execution context — the run dies on an element the locator had just
  // waited for. Nothing here tests caching.
  if(p==='/sw.js'){res.writeHead(404);res.end('');return;}
  const file=p==='/'?'/index.html':SPA.test(p)?'/index.html':p;
  try{const b=await readFile(ROOT+file);const e=file.split('.').pop();
    res.writeHead(200,{'content-type':{html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',
      svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',webp:'image/webp',mp4:'video/mp4'}[e]||'application/octet-stream'});
    res.end(b);}catch{res.writeHead(404);res.end('');}});
await new Promise(r=>server.listen(0,r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
let fails=0;
const ok=(m,d)=>console.log(`  ok   ${m}${d?` (${d})`:''}`);
const bad=(m,d)=>{fails++;console.log(`  FAIL ${m}${d?` (${d})`:''}`);};

async function readAll(tz){
  const page=await browser.newPage({viewport:{width:390,height:900}, timezoneId:tz});
  await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.8','1');}catch(e){}});
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator('#home-countdowns > .cd-wrap').waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  // Every card in the section, the #cd-past block included. A card's printed
  // local time is its own business wherever the card sits, and a countdown
  // that finishes moves into that block — CLICK did on 2026-10-24, which read
  // here as the card having vanished.
  const r=await page.evaluate(()=>Object.fromEntries(
    [...document.querySelectorAll('#home-countdowns .cd-card')].map(c=>[
      c.dataset.slug,
      { line: (c.querySelector('.cd-sub-local')||{}).textContent || '',
        sub: (c.querySelector('.cd-sub')||{}).textContent.replace(/\s+/g,' ').trim() }])));
  await page.close(); return r;
}
// Each card's own hand-typed claim, and the zone it is a claim about.
const CLAIMS = [
  // BOTH of the Steps card's clocks, because it prints two and they are a
  // cross-check on each other: "12AM EST / 2PM KST" is one instant only if the
  // New York offset is -5, and it is -5 only because US clocks went back on
  // Nov 1. Read as EDT the card would be an hour early, and a single-zone
  // check could not tell the difference.
  //
  // It used to count to the FILM (Nov 20, 12AM PT) because the song's own date
  // was unannounced. The song was then announced for Nov 6 — two weeks AHEAD
  // of the premiere — so the countdown follows the song and these claims moved
  // with it. The film's date is asserted separately, below.
  ['steps',             'America/New_York',    '12:00 AM', 'Nov 6'],   // "12AM EST"
  ['steps',             'Asia/Seoul',          '2:00 PM',  'Nov 6'],   // "2PM KST"
  ['newtrick',          'Asia/Seoul',          '8:00 AM',  'Sep 18'],  // "Thu, Sep 18 · 8AM KST"
  ['jisoo.io',          'Asia/Seoul',          '1:00 PM',  'Sep 4'],   // "1PM KST"
  ['hellosawadika.com', 'Asia/Seoul',          '9:00 AM',  'Sep 4'],   // "9AM KST"
];
console.log('--- the computed line agrees with the label each card already prints');
const cache={};
for (const [slug,tz,time,day] of CLAIMS){
  cache[tz] = cache[tz] || await readAll(tz);
  const line = cache[tz][slug].line;
  (line.includes(time) && line.includes(day))
    ? ok(`${slug} in ${tz}`, line)
    : bad(`${slug} in ${tz}`, `wanted ${day} ${time}, got "${line}"`);
}
console.log('--- and every card answers, from anywhere');
// Named rather than "whatever is in the track". This used to be every card in
// the live row minus PRESS PLAY, which meant moving a card out of that row
// quietly dropped it from the check instead of failing — and the whole point
// of this file is that a clock can be hours wrong while looking healthy.
const MUST_ANSWER = ['addicted','steps','newtrick','jisoo.io','hellosawadika.com'];
for (const tz of ['Europe/Rome','America/New_York','Asia/Kolkata']){
  const r = await readAll(tz);
  const missing = MUST_ANSWER.filter(k => !/your time/.test((r[k]||{}).line||''));
  missing.length===0 ? ok(`${tz}: all ${MUST_ANSWER.length} carry a local line`,
                          (r['jisoo.io']||{}).line)
                     : bad(`${tz}: all ${MUST_ANSWER.length} carry a local line`,
                           `missing on ${missing.join(', ')}`);
  // PRESS PLAY says "Midnight local time" instead, which IS the local answer.
  /Midnight local time/.test(r['lalisaofficial.com'].sub)
    ? ok('   and PRESS PLAY still says midnight local time')
    : bad('   and PRESS PLAY still says midnight local time', r['lalisaofficial.com'].sub);
}

console.log('--- Steps: the song and the film are two dates, and stay two dates');
// The card counted to the film while telling readers the song arrived "the
// same day as the film". It does not — the single is 14 days earlier — and
// both halves were wrong together, which is how it read as consistent. So:
// the countdown is the SONG, the film's own date is still on the card, and
// nothing claims they coincide.
{
  const pg = await browser.newPage({ timezoneId: 'Europe/Rome' });
  await pg.goto(base, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(2200);
  const s = await pg.evaluate(() => {
    const c = document.querySelector('#home-countdowns .cd-card[data-slug="steps"]')
           || document.querySelector('.cd-card[data-slug="steps"]');
    return c ? { target: c.dataset.target,
                 times: (c.querySelector('[data-times-for]') || {}).dataset?.timesFor || '',
                 text: c.innerText.replace(/\s+/g, ' ') } : null;
  });
  await pg.close();
  if (!s) bad('the Steps card is on the page');
  else {
    s.target === '2026-11-06T05:00:00Z'
      ? ok('the countdown targets the song', s.target)
      : bad('the countdown targets the song', `got ${s.target}`);
    // The worldwide-times list has to move with the target, or the card counts
    // to one instant and lists another.
    s.times === s.target
      ? ok('and the worldwide times list the same instant', s.times)
      : bad('and the worldwide times list the same instant', `times-for ${s.times} vs target ${s.target}`);
    /Nov 20/.test(s.text)
      ? ok("and the film's own date is still on the card", 'Nov 20')
      : bad("and the film's own date is still on the card", 'Nov 20 is gone');
    /same day as the film/i.test(s.text)
      ? bad('and nothing says the song lands with the film', 'that claim is back')
      : ok('and nothing says the song lands with the film');
  }
}

await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll correct.');
process.exit(fails?1:0);
