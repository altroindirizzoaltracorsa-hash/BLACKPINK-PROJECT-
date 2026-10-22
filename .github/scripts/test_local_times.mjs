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
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator('#home-countdowns > .cd-wrap').waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  const r=await page.evaluate(()=>Object.fromEntries(
    [...document.querySelectorAll('#home-countdowns > .cd-wrap > .cd-card')].map(c=>[
      c.dataset.slug,
      { line: (c.querySelector('.cd-sub-local')||{}).textContent || '',
        sub: (c.querySelector('.cd-sub')||{}).textContent.replace(/\s+/g,' ').trim() }])));
  await page.close(); return r;
}
// Each card's own hand-typed claim, and the zone it is a claim about.
const CLAIMS = [
  ['steps',             'America/Los_Angeles', '12:00 AM', 'Nov 20'],  // "12AM PT"
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
for (const tz of ['Europe/Rome','America/New_York','Asia/Kolkata']){
  const r = await readAll(tz);
  const missing = Object.entries(r).filter(([k,v])=> k!=='lalisaofficial.com' && !/your time/.test(v.line)).map(([k])=>k);
  missing.length===0 ? ok(`${tz}: all four carry a local line`,
                          Object.entries(r).filter(([k])=>k==='jisoo.io').map(([,v])=>v.line)[0])
                     : bad(`${tz}: all four carry a local line`, `missing on ${missing.join(', ')}`);
  // PRESS PLAY says "Midnight local time" instead, which IS the local answer.
  /Midnight local time/.test(r['lalisaofficial.com'].sub)
    ? ok('   and PRESS PLAY still says midnight local time')
    : bad('   and PRESS PLAY still says midnight local time', r['lalisaofficial.com'].sub);
}
await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll correct.');
process.exit(fails?1:0);
