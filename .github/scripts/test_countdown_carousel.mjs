// Drive the countdown carousel and the MV-frame carousel in a real browser.
//
// Run: node .github/scripts/test_countdown_carousel.mjs
//
// Everything worth checking here is invisible in a screenshot:
//
//   * the dots are read from the real scroll position, so a flick that crosses
//     two cards still lights the right one — count them by hand and they drift;
//   * /countdowns/<slug> hides every card but one, and the controls have to go
//     with them rather than leave dots pointing at nothing;
//   * the MV frames are display:none everywhere but the release page, and a
//     child of a hidden parent still reports a display of its own — so their
//     dots will happily appear on a home card with no strip behind them;
//   * autoplay has to stop for good the first time somebody touches it;
//   * and a swipe across the cards must not open the countdown underneath.
//     That last one is TOUCH only: a mouse drag over a scroll container fires
//     no click at all in Chromium, so a mouse "swipe" would pass this test
//     whether or not the guard exists. Measured, not assumed.
// Drive the real carousels. The failures that matter are all invisible on a
// screenshot: dots that stop matching the slide you are on, a filter that
// leaves stale dots, a swipe that navigates away, and autoplay that keeps
// moving a card somebody is reading.
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

async function newPage(w=390,h=900){
  const page=await browser.newPage({viewport:{width:w,height:h}});
  await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
  return page;
}
const TRACK='#home-countdowns > .cd-wrap';
const state=(page)=>page.evaluate(()=>{
  const t=document.querySelector('#home-countdowns > .cd-wrap');
  const nav=document.querySelector('#home-countdowns > [data-carousel-nav]');
  const slides=[...t.children].filter(c=>getComputedStyle(c).display!=='none');
  const mid=t.scrollLeft+t.clientWidth/2;
  let at=0,g=Infinity;
  slides.forEach((s,i)=>{const d=Math.abs((s.offsetLeft+s.offsetWidth/2)-mid); if(d<g){g=d;at=i;}});
  const dots=nav?[...nav.querySelectorAll('.cd-dot')]:[];
  return {slides:slides.length, dots:dots.length, lit:dots.findIndex(d=>d.classList.contains('is-on')),
    navHidden: nav?nav.hidden:null, at, horiz: t.scrollWidth>t.clientWidth+2,
    cardW: slides[0]?Math.round(slides[0].getBoundingClientRect().width):0,
    trackW: Math.round(t.clientWidth), trackH: Math.round(t.getBoundingClientRect().height),
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    active: slides[at]?.className.split(' ').find(c=>c.startsWith('cd-card-'))||slides[at]?.dataset.slug};
});

console.log('--- the countdown cards, on the home page');
{
  const page=await newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator(TRACK).waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  let s=await state(page);
  s.slides>=5 ? ok('every card is a slide',`${s.slides}`) : bad('every card is a slide',`${s.slides}`);

  // The running order is a decision, not whatever order the cards were written
  // in, and it is invisible from any one card's markup. PRESS PLAY leads.
  const ORDER = ['lalisaofficial.com','steps','newtrick','jisoo.io','hellosawadika.com'];
  const got = await page.evaluate(()=>[...document.querySelectorAll('#home-countdowns > .cd-wrap > .cd-card')]
    .map(c=>c.dataset.slug));
  // Auto-discovered pre-releases are inserted ahead of everything on purpose,
  // so compare the hand-authored cards in the order they appear among them.
  const hand = got.filter(g=>ORDER.includes(g));
  JSON.stringify(hand)===JSON.stringify(ORDER)
    ? ok('they run in the order they are meant to', hand.join(' → '))
    : bad('they run in the order they are meant to', `got ${hand.join(' → ')}`);
  got[0]===ORDER[0] ? ok('and the carousel opens on PRESS PLAY')
                    : bad('and the carousel opens on PRESS PLAY',`opens on ${got[0]}`);
  s.dots===s.slides ? ok('one dot per slide',`${s.dots}`) : bad('one dot per slide',`${s.dots} dots / ${s.slides} slides`);
  s.navHidden===false ? ok('the controls are shown') : bad('the controls are shown',`hidden=${s.navHidden}`);
  s.cardW===s.trackW ? ok('one card fills the view',`${s.cardW}px`) : bad('one card fills the view',`card ${s.cardW} vs track ${s.trackW}`);
  s.horiz ? ok('the track scrolls sideways') : bad('the track scrolls sideways');
  !s.pageOverflow ? ok('and the PAGE does not') : bad('and the PAGE does not');
  s.lit===0 ? ok('the first dot is lit') : bad('the first dot is lit',`lit=${s.lit}`);

  // Scroll the track and watch the dots follow the real position.
  await page.evaluate(()=>{const t=document.querySelector('#home-countdowns > .cd-wrap');
    t.scrollBy({left:t.clientWidth*2, behavior:'auto'});});
  await page.waitForTimeout(600);
  s=await state(page);
  (s.lit===s.at && s.at===2) ? ok('the dots follow the scroll position',`slide ${s.at}, "${s.active}"`)
                             : bad('the dots follow the scroll position',`at ${s.at}, lit ${s.lit}`);

  // A dot is a destination, not a decoration.
  // Scoped to the countdown nav: the MV frames have dots of their own, inside
  // the LISA card, which come first in document order.
  await page.evaluate(()=>document.querySelectorAll('#home-countdowns > [data-carousel-nav] .cd-dot')[4].click());
  await page.waitForTimeout(900);
  s=await state(page);
  (s.at===4 && s.lit===4) ? ok('clicking a dot goes to that slide',`"${s.active}"`)
                          : bad('clicking a dot goes to that slide',`at ${s.at}, lit ${s.lit}`);
  // The track takes the height of the card you are on — otherwise a poster-
  // shaped card sits over a few hundred pixels of nothing, left by whichever
  // sibling happens to be tallest.
  const fit = await page.evaluate(async ()=>{
    const t=document.querySelector('#home-countdowns > .cd-wrap');
    const slides=[...t.children].filter(c=>getComputedStyle(c).display!=='none');
    const out=[];
    for (let i=0;i<slides.length;i++){
      const d=slides[i].getBoundingClientRect().left - t.getBoundingClientRect().left;
      t.scrollBy({left:d, behavior:'auto'});
      await new Promise(r=>setTimeout(r,320));
      out.push({card:Math.round(slides[i].offsetHeight), track:Math.round(t.clientHeight)});
    }
    return out;
  });
  const off = fit.filter(f=>Math.abs(f.card-f.track)>2);
  off.length===0 ? ok('the track takes the height of the card you are on',
                      fit.map(f=>f.track).join(', ')+'px')
                 : bad('the track takes the height of the card you are on',
                       off.map(f=>`card ${f.card} vs track ${f.track}`).join('; '));
  const spread = Math.max(...fit.map(f=>f.card)) - Math.min(...fit.map(f=>f.card));
  spread>100 ? ok('and the cards really do differ enough for that to matter',`${spread}px between tallest and shortest`)
             : bad('and the cards really do differ enough for that to matter',`only ${spread}px`);

  const strip = await page.evaluate(()=>{
    const st=document.querySelector('.cd-card-lisa .cd-strip');
    const n=document.querySelector('.cd-card-lisa .cd-strip-nav');
    return { strip: st ? getComputedStyle(st).display!=='none' : false,
             dots: n ? n.querySelectorAll('.cd-dot').length : 0,
             navShown: n ? !n.hidden && getComputedStyle(n).display!=='none' : false };
  });
  strip.strip && strip.navShown && strip.dots===4
    ? ok('the MV frames ride along on the home card',`${strip.dots} dots`)
    : bad('the MV frames ride along on the home card',JSON.stringify(strip));
  errs.length ? bad('no page errors',errs.join(' | ')) : ok('no page errors');
  await page.close();
}

console.log('--- the deep link shows one card, so there is nothing to page through');
{
  const page=await newPage();
  await page.goto(base+'/countdowns/lalisaofficial.com',{waitUntil:'domcontentloaded'});
  await page.locator('.cd-card-lisa').waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  const s=await page.evaluate(()=>{
    const t=document.querySelector('#home-countdowns > .cd-wrap');
    const nav=document.querySelector('#home-countdowns > [data-carousel-nav]');
    const vis=[...t.children].filter(c=>getComputedStyle(c).display!=='none');
    return {slides:vis.length, navHidden:nav.hidden, dots:nav.querySelectorAll('.cd-dot').length};
  });
  s.slides===1 ? ok('one slide') : bad('one slide',`${s.slides}`);
  s.navHidden===true ? ok('and the controls take themselves away') : bad('and the controls take themselves away');
  s.dots<=1 ? ok('no stale dots left over',`${s.dots}`) : bad('no stale dots left over',`${s.dots}`);
  await page.close();
}

console.log('--- the MV frames inside the card');
{
  const page=await newPage();
  await page.goto(base+'/countdowns/lalisaofficial.com',{waitUntil:'domcontentloaded'});
  await page.locator('.cd-card-lisa').waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  const read=()=>page.evaluate(()=>{
    const t=document.querySelector('.cd-card-lisa .cd-strip');
    const nav=document.querySelector('.cd-card-lisa .cd-strip-nav');
    const sl=[...t.children];
    const mid=t.scrollLeft+t.clientWidth/2;
    let at=0,g=Infinity; sl.forEach((s,i)=>{const d=Math.abs((s.offsetLeft+s.offsetWidth/2)-mid); if(d<g){g=d;at=i;}});
    return {at, dots:nav.querySelectorAll('.cd-dot').length, navHidden:nav.hidden,
      lit:[...nav.querySelectorAll('.cd-dot')].findIndex(d=>d.classList.contains('is-on')),
      frameW:Math.round(sl[0].getBoundingClientRect().width), trackW:Math.round(t.clientWidth)};
  });
  // Scroll to it first. Autoplay deliberately skips a strip that is off
  // screen, so testing it below the fold measures the guard, not the carousel.
  await page.locator('.cd-card-lisa .cd-strip').scrollIntoViewIfNeeded().catch(()=>{});
  await page.waitForTimeout(600);
  let f=await read();
  f.dots===4 ? ok('four dots for four frames') : bad('four dots for four frames',`${f.dots}`);
  f.navHidden===false ? ok('the dots are shown') : bad('the dots are shown');
  f.frameW===f.trackW ? ok('one frame at a time',`${f.frameW}px`) : bad('one frame at a time',`${f.frameW} vs ${f.trackW}`);
  const before=f.at;
  await page.waitForTimeout(6000);                       // autoplay is 4500ms
  f=await read();
  f.at!==before ? ok('it advances on its own',`${before} → ${f.at}`) : bad('it advances on its own',`stuck at ${f.at}`);
  f.lit===f.at ? ok('and the dot keeps up') : bad('and the dot keeps up',`at ${f.at}, lit ${f.lit}`);
  // Touch it, and it must stop for good.
  await page.locator('.cd-card-lisa .cd-strip').dispatchEvent('pointerdown');
  // Settle first. An autoplay tick fired just before the touch is still
  // scrolling smoothly, so reading the position now catches it mid-flight and
  // the comparison below fails on a carousel that did stop — which is how this
  // check went red once in four runs.
  await page.waitForTimeout(1200);
  const held=(await read()).at;
  await page.waitForTimeout(6000);
  const after=(await read()).at;
  after===held ? ok('and stops for good once you touch it',`held on ${held}`)
               : bad('and stops for good once you touch it',`${held} → ${after}`);
  await page.close();
}

console.log('--- swiping the hub must not navigate away');
{
  // It has to be touch. A mouse drag over a scroll container fires no click at
  // all in Chromium — measured — so a mouse "swipe" proves nothing here. A
  // touch drag that scrolls nothing (at either end of the track, or a mostly
  // vertical one) does end in a click, and that is the push that would open a
  // countdown the reader was only trying to scroll past.
  const ctx = await browser.newContext({viewport:{width:390,height:900}, hasTouch:true});
  const page = await ctx.newPage();
  await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
  await page.goto(base+'/countdowns',{waitUntil:'domcontentloaded'});
  await page.locator(TRACK).waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  const box=await page.locator('#home-countdowns .cd-card').first().boundingBox();
  const y=Math.round(box.y+120), x0=Math.round(box.x+60), x1=Math.round(box.x+180);
  await page.evaluate(([x0,x1,y])=>{
    const el=document.elementFromPoint(x0,y);
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x0,clientY:y,pointerType:'touch'}));
    el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x1,clientY:y,pointerType:'touch'}));
    el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x1,clientY:y}));
  },[x0,x1,y]);
  await page.waitForTimeout(900);
  page.url().endsWith('/countdowns') ? ok('a swipe across the cards stays on the hub')
                                     : bad('a swipe across the cards stays on the hub',page.url().replace(base,''));
  // ...and a tap in one place still opens that countdown.
  await page.evaluate(([x,y])=>{
    const el=document.elementFromPoint(x,y);
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y,pointerType:'touch'}));
    el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x+2,clientY:y+1,pointerType:'touch'}));
    el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x+2,clientY:y+1}));
  },[x0,y]);
  await page.waitForTimeout(900);
  page.url().includes('/countdowns/') ? ok('and a tap still opens that countdown',page.url().replace(base,''))
                                      : bad('and a tap still opens that countdown',page.url().replace(base,''));
  await ctx.close();
}
await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll carousel checks passed.');
process.exit(fails?1:0);
