// The panels inside the countdown cards — each release's picture strip, and
// the PRESS PLAY playlists — in a real browser.
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
      oneUp: Math.abs(fr[0].getBoundingClientRect().width - st.clientWidth) < 3,
      videoPoster: (()=>{ const v=st.querySelector('video'); return v ? v.getAttribute('poster') : undefined; })() };
  });
  if (r.none) { bad(`${name}: has a strip`); await page.close(); continue; }
  r.shown ? ok(`${name}: the strip is shown`) : bad(`${name}: the strip is shown`);
  r.frames===n ? ok(`   ${n} pictures`) : bad(`   ${n} pictures`,`${r.frames}`);
  r.loaded===n ? ok('   all of them loaded') : bad('   all of them loaded',`${r.loaded}/${n}${miss.length?' missing: '+miss.join(', '):''}`);
  r.dots===n ? ok('   a dot each') : bad('   a dot each',`${r.dots}`);
  r.navShown ? ok('   dots visible') : bad('   dots visible');
  r.oneUp ? ok('   one picture at a time') : bad('   one picture at a time');
  if (r.videoPoster !== undefined) {
    // A video must show its OWN first frame. It once carried a poster that was
    // a different photograph, so the slide showed one picture and played
    // another — and nothing on this page could catch that, because the headless
    // browser cannot decode the clip to compare them.
    r.videoPoster === null ? ok('   the film shows its own first frame, not another photo')
                           : bad('   the film shows its own first frame, not another photo', r.videoPoster);
  }
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
             // :not(.cd-playlists) — the playlists panel is a .cd-times element
             // too, and it is shown here on purpose. Only the MV's worldwide
             // times keep to the release's own page.
             lisaTimes: [...document.querySelectorAll('#home-countdowns .cd-card-lisa .cd-times:not(.cd-playlists)')]
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
console.log('--- the PRESS PLAY community playlists');
{
  // Four hand-typed Spotify ids. A typo here does not throw and does not look
  // wrong: it quietly sends blinks to somebody else's playlist on release
  // night, which is the whole reason this is asserted id by id, in order.
  const WANT = [
    ['PRESS PLAY FOCUSED','6YZw8yGS7AeTgGAEHjDwU5'],
    ['TARANTINO FOCUSED', '4yLrtij2wkmmGjXJkxi7Ec'],
    ['TARANTINO x PINKS', '6r67sLT2Fr1dSb5sT4lGWN'],
    ['TARANTINO x BP',    '3sxqqL3OF3s7HeG14kwbyH'],
  ];
  for (const [path,label] of [['/','home card'],['/countdowns/lalisaofficial.com','release page']]) {
    const page=await browser.newPage({viewport:{width:390,height:900}});
    await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
      localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
    await page.goto(base+path,{waitUntil:'domcontentloaded'});
    await page.locator('.cd-card-lisa').waitFor({timeout:20000});
    await page.waitForTimeout(3000);
    const r=await page.evaluate(()=>{
      const c=document.querySelector('.cd-card-lisa');
      const pl=c.querySelector('.cd-playlists');
      const times=c.querySelector('.cd-times:not(.cd-playlists)');
      const vis=e=>!!e && getComputedStyle(e).display!=='none' && e.getBoundingClientRect().height>0;
      return { plShown:vis(pl), timesShown:vis(times),
        links: pl ? [...pl.querySelectorAll('.cd-times-body a')].map(a=>[a.textContent.replace(/\s*→\s*$/,'').trim(), a.getAttribute('href')]) : [] };
    });
    r.plShown ? ok(`${label}: the playlists are there`) : bad(`${label}: the playlists are there`);
    let wrong=0;
    WANT.forEach(([name,id],i)=>{
      const got=r.links[i]||[];
      if (got[0]!==name || got[1]!==`https://open.spotify.com/playlist/${id}`) {
        wrong++; bad(`   ${label}: ${name}`, `got ${got[0]} → ${got[1]}`);
      }
    });
    if(!wrong && r.links.length===4) ok(`   ${label}: all four ids, in order`);
    else if(!wrong) bad(`   ${label}: all four ids, in order`,`${r.links.length} links`);
    // The MV's worldwide times are reference and stay on the release page; the
    // playlists are something to go and do, so they follow the card everywhere.
    (path==='/' ? !r.timesShown : r.timesShown)
      ? ok(`   ${label}: the MV times are where they belong`)
      : bad(`   ${label}: the MV times are where they belong`);
    await page.close();
  }
}
await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll strips correct.');
process.exit(fails?1:0);
