// Two different kinds of release time on one card, in a real browser.
//
// Run: node .github/scripts/test_release_timing.mjs
//
// PRESS PLAY arrives at midnight in each country. "Tarantino" is a world
// premiere: one instant everywhere. Both live on the same card, and getting
// either wrong is silent — a countdown that looks perfectly healthy and is
// thirteen hours out for Seoul, or an "out now" on a video nobody can watch
// yet.
//
// The clock is read from seven timezones at one fixed moment, so each one has
// a different, known answer; a card counting to a single instant would give
// them all the same number. The specific trap is Date.parse("2026-10-23"),
// which is UTC midnight rather than the reader's — it passes every eyeball
// test and every zone check here goes red on it.
// The EP lands at midnight in each country; the MV premieres at one instant
// worldwide. The card has to do BOTH at once, and the failure is silent: a
// countdown that looks fine and is thirteen hours wrong for Seoul.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA=/^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server=createServer(async(req,res)=>{const p=req.url.split('?')[0];
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

async function read(tz, nowISO){
  const page=await browser.newPage({viewport:{width:390,height:900}, timezoneId:tz});
  await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
  await page.addInitScript(`(()=>{const t=Date.parse(${JSON.stringify(nowISO)});const R=Date;
    const D=function(...a){return a.length?new R(...a):new R(t)};
    D.prototype=R.prototype;D.now=()=>t;D.parse=R.parse;D.UTC=R.UTC;globalThis.Date=D;})()`);
  await page.goto(base+'/countdowns/lalisaofficial.com',{waitUntil:'domcontentloaded'});
  await page.locator('.cd-card-lisa').waitFor({timeout:20000});
  await page.waitForTimeout(2200);
  const r=await page.locator('.cd-card-lisa').evaluate(el=>({
    timer: el.querySelector('[data-timer]').textContent.replace(/\s+/g,' ').trim(),
    mv: el.querySelector('.cd-mv-note span[data-pre]').textContent.trim(),
    when: el.querySelector('.cd-mv-when').textContent.trim(),
    sub: el.querySelector('.cd-sub').textContent.replace(/\s+/g,' ').trim(),
    hero: !!el.querySelector('img.lisa-hero')?.complete,
  }));
  await page.close(); return r;
}
// hours each zone still has to wait, from 2026-10-22T13:00Z, to ITS OWN midnight
const NOW='2026-10-22T13:00:00Z';
const ZONES=[
  ['Pacific/Auckland', 'OUT',  'Fri, Oct 23, 5:00 PM'],   // +13: midnight already gone
  ['Asia/Seoul',        2,     'Fri, Oct 23, 1:00 PM'],   // +9
  ['Europe/Rome',       9,     'Fri, Oct 23, 6:00 AM'],   // +2
  ['Europe/London',    10,     'Fri, Oct 23, 5:00 AM'],   // +1
  ['America/New_York', 15,     'Fri, Oct 23, 12:00 AM'],  // -4
  ['America/Los_Angeles',18,   'Thu, Oct 22, 9:00 PM'],   // -7
  ['Pacific/Honolulu', 21,     'Thu, Oct 22, 6:00 PM'],   // -10
];
console.log(`--- the EP clock, read at ${NOW} from seven places`);
for (const [tz, wantH, wantWhen] of ZONES) {
  const r=await read(tz, NOW);
  if (wantH==='OUT') {
    /OUT NOW/.test(r.timer) ? ok(`${tz}: already out`,'its midnight has passed')
                            : bad(`${tz}: already out`,r.timer);
  } else {
    const m=r.timer.match(/^(\d+)Days(\d+)Hrs/);
    const h=m?Number(m[1])*24+Number(m[2]):-1;
    h===wantH ? ok(`${tz}: ${h}h to its own midnight`)
              : bad(`${tz}: ${wantH}h to its own midnight`,`clock says ${r.timer}`);
  }
  r.when===`${wantWhen} your time`
    ? ok(`   ...and the MV premiere reads ${r.when}`)
    : bad(`   ...and the MV premiere reads right`,`got "${r.when}", wanted "${wantWhen} your time"`);
}

console.log('--- the EP being out does not make the MV out');
{
  // Seoul, three hours after its own midnight: EP out, MV still to come.
  const r=await read('Asia/Seoul','2026-10-22T18:00:00Z');
  /OUT NOW/.test(r.timer) ? ok('Seoul: the EP is out') : bad('Seoul: the EP is out',r.timer);
  /world premiere/i.test(r.mv) ? ok('but the MV still says world premiere',r.mv)
                               : bad('but the MV still says world premiere',r.mv);
  const r2=await read('Asia/Seoul','2026-10-23T05:00:00Z');   // after 04:00Z
  /is out/i.test(r2.mv) ? ok('and flips once the premiere happens',r2.mv)
                        : bad('and flips once the premiere happens',r2.mv);
}
console.log('--- the copy and the hero');
{
  const r=await read('Europe/Rome',NOW);
  /Midnight local time/.test(r.sub) ? ok('the card says midnight local',r.sub)
                                           : bad('the card says midnight local',r.sub);
  !/KST|EDT/.test(r.sub) ? ok('and names nobody else’s timezone as the time')
                         : bad('and names nobody else’s timezone as the time',r.sub);
  r.hero ? ok('the new hero photo loaded') : bad('the new hero photo loaded');
}
await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll correct.');
process.exit(fails?1:0);
