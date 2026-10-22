// Each countdown's own picture strip, in a real browser.
//
// Run: node .github/scripts/test_countdown_strips.mjs
//
// Three cards carry one. What is worth checking is what a screenshot of one
// page cannot show: that every picture actually loads (they are separate files
// and a rename kills them silently), that the dots match the pictures rather
// than a number written by hand, that one picture fills the view, and that
// every frame is the same height — a strip whose frames differ in height jumps
// as it scrolls, which is why the frames fit the picture inside a fixed ratio
// instead of cropping it to fill.
//
// And the negative: these belong to /countdowns/<release>, not to the home
// carousel. The last check also guards the other cards' own "release times"
// panels, which are NOT hidden — only the LISA card's are, because only that
// card's times belong to its video rather than its release.
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
const CARDS=[['lalisaofficial.com','PRESS PLAY',7],['jisoo.io','CLICK',2],['hellosawadika.com','SaWaDiKa',5]];
console.log('--- each countdown page carries its own strip');
for (const [slug,name,n] of CARDS) {
  const page=await browser.newPage({viewport:{width:390,height:900}});
  await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  const miss=[]; page.on('response',r=>{ if(r.status()>=400 && /strips\/|tarantino\//.test(r.url())) miss.push(r.url()); });
  await page.goto(base+'/countdowns/'+slug,{waitUntil:'domcontentloaded'});
  await page.locator('.cd-card[data-slug]:visible').first().waitFor({timeout:20000});
  await page.waitForTimeout(3200);
  const r=await page.evaluate(()=>{
    const card=[...document.querySelectorAll('#home-countdowns .cd-card')].find(c=>getComputedStyle(c).display!=='none');
    const st=card.querySelector('.cd-strip'); if(!st) return {none:true};
    const nav=card.querySelector('.cd-strip-nav');
    const fr=[...st.querySelectorAll('.cd-frame img, .cd-frame video')];
    return { frames:fr.length, dots:nav?nav.querySelectorAll('.cd-dot').length:0,
      navShown: nav? !nav.hidden && getComputedStyle(nav).display!=='none' : false,
      shown: getComputedStyle(st).display!=='none',
      loaded: fr.filter(i=>i.tagName==='VIDEO' ? !!i.currentSrc||!!i.getAttribute('src') : (i.complete && i.naturalWidth>0)).length,
      heights: [...new Set(fr.map(i=>Math.round(i.getBoundingClientRect().height)))],
      oneUp: Math.abs(fr[0].getBoundingClientRect().width - st.clientWidth) < 3 };
  });
  if (r.none) { bad(`${name}: has a strip`); await page.close(); continue; }
  r.shown ? ok(`${name}: the strip is shown`) : bad(`${name}: the strip is shown`);
  r.frames===n ? ok(`   ${n} pictures`) : bad(`   ${n} pictures`,`${r.frames}`);
  r.loaded===n ? ok('   all of them loaded') : bad('   all of them loaded',`${r.loaded}/${n}${miss.length?' missing: '+miss.join(', '):''}`);
  r.dots===n ? ok('   a dot each') : bad('   a dot each',`${r.dots}`);
  r.navShown ? ok('   dots visible') : bad('   dots visible');
  r.oneUp ? ok('   one picture at a time') : bad('   one picture at a time');
  r.heights.length===1 ? ok('   every frame the same height, so it cannot jump',`${r.heights[0]}px`)
                       : bad('   every frame the same height, so it cannot jump',r.heights.join('/'));
  errs.length ? bad('   no page errors',errs.join(' | ')) : ok('   no page errors');
  await page.close();
}
console.log('--- and on the home carousel too, which is where people look');
{
  const page=await browser.newPage({viewport:{width:390,height:900}});
  await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator('#home-countdowns > .cd-wrap').waitFor({timeout:20000});
  await page.waitForTimeout(3500);
  const r=await page.evaluate(()=>{
    const strips=[...document.querySelectorAll('#home-countdowns .cd-strip')];
    const navs=[...document.querySelectorAll('#home-countdowns .cd-strip-nav')];
    return { strips: strips.length,
             shown: strips.filter(e=>getComputedStyle(e).display!=='none').length,
             withDots: navs.filter(n=>!n.hidden && n.querySelectorAll('.cd-dot').length>1).length,
             times: [...document.querySelectorAll('#home-countdowns .cd-card:not(.cd-card-lisa) .cd-times')]
                      .filter(e=>getComputedStyle(e).display!=='none').length,
             lisaTimes: [...document.querySelectorAll('#home-countdowns .cd-card-lisa .cd-times')]
                      .filter(e=>getComputedStyle(e).display!=='none').length };
  });
  r.shown===3 ? ok('all three strips are on the home page too',`${r.shown}/${r.strips}`)
              : bad('all three strips are on the home page too',`${r.shown}/${r.strips} shown`);
  r.withDots===3 ? ok('each with its dots') : bad('each with its dots',`${r.withDots}`);
  r.times>0 ? ok("the other cards' own release times are untouched",`${r.times} shown`)
            : bad("the other cards' own release times are untouched",'they were hidden');
  r.lisaTimes===0 ? ok("and the MV's worldwide times stay on the release's own page")
                  : bad("and the MV's worldwide times stay on the release's own page");
  await page.close();
}
await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll strips correct.');
process.exit(fails?1:0);
