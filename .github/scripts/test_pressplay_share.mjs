// The PRESS PLAY share card's picture picker, in a real browser.
//
// Run: node .github/scripts/test_pressplay_share.mjs
//
// The picker is one shared element that every release rebuilds for itself, so
// the two ways it goes wrong are both silent: a thumbnail that selects but does
// not actually redraw the card, and one release's pictures left sitting in
// another's picker.
//
// Each pick is checked by digesting the CANVAS PIXELS, not by reading back the
// state we just set — the question is whether the card the fan would post
// actually changed, and only the pixels answer that.
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
const page=await browser.newPage({viewport:{width:430,height:950}});
await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
  localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.8','1');}catch(e){}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto(base+'/countdowns/lalisaofficial.com',{waitUntil:'domcontentloaded'});
await page.locator('.cd-card-lisa').waitFor({timeout:20000});
await page.waitForTimeout(2500);

console.log('--- the share card offers every picture');
await page.evaluate(()=>openPressPlayCard());
await page.waitForTimeout(2500);
const start=await page.evaluate(()=>({
  thumbs:[...document.querySelectorAll('#release-pic-picker .release-pic-thumb')].map(t=>t.getAttribute('src')),
  shown:getComputedStyle(document.getElementById('release-pic-picker')).display!=='none',
  active:[...document.querySelectorAll('#release-pic-picker .release-pic-thumb')].findIndex(t=>t.classList.contains('active')),
  pics: PRESS_PLAY_CARD_PICS.length,
}));
start.shown ? ok('the picker is shown') : bad('the picker is shown');
start.thumbs.length===6 ? ok('a thumbnail for each picture',`${start.thumbs.length}`)
                        : bad('a thumbnail for each picture',`${start.thumbs.length}`);
start.active===0 ? ok('the one on the card is the one marked') : bad('the one on the card is the one marked',`${start.active}`);

// The real question: does picking REDRAW? Compare the canvas pixels.
const snap=()=>page.evaluate(()=>{
  const c=document.getElementById('card-canvas');
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let h=0; for(let i=0;i<d.length;i+=997) h=(h*31+d[i])>>>0;   // cheap digest
  return h;
});
const seen=new Map();
for (let i=0;i<6;i++){
  await page.evaluate((n)=>{const t=document.querySelectorAll('#release-pic-picker .release-pic-thumb')[n]; t.click();}, i);
  await page.waitForTimeout(1400);
  const h=await snap();
  const st=await page.evaluate(()=>({src:_ppCardData.photo&&_ppCardData.photo.src.replace(location.origin,''),
                                     fit:!!_ppCardData.fit, focal:_ppCardData.focal}));
  const dup=[...seen.entries()].find(([,v])=>v===h);
  if (dup) bad(`picture ${i+1} draws something of its own`,`identical to picture ${dup[0]+1}`);
  else ok(`picture ${i+1} draws something of its own`, `${st.src}${st.fit?' · fitted whole':''}`);
  seen.set(i,h);
}
console.log('--- and it does not leak into another release');
await page.evaluate(()=>{ try{ document.getElementById('card-overlay').style.display='none'; }catch(e){} });
await page.goto(base+'/countdowns/hellosawadika.com',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(2500);
await page.evaluate(()=>openLisaCard());
await page.waitForTimeout(2500);
const sw=await page.evaluate(()=>[...document.querySelectorAll('#release-pic-picker .release-pic-thumb')].map(t=>t.getAttribute('src')));
sw.length && sw.every(u=>u.includes('sawadika'))
  ? ok('SaWaDiKa still gets its own thumbnails',`${sw.length}`)
  : bad('SaWaDiKa still gets its own thumbnails',sw.join(', '));
errs.length ? bad('no page errors',errs.join(' | ')) : ok('no page errors');
await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll picker checks passed.');
process.exit(fails?1:0);
