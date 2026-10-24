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
//   * autoplay has to stop for good once somebody TAKES IT OVER — and a
//     finger landing on the track is not that. Binding it to touchstart meant
//     one finger scrolling the page past the card killed the looping for the
//     rest of the visit, which on a phone is every visit;
//   * the arrows have to exist on a phone, at a size a thumb can hit;
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
    // How many pixels of the NEXT card fall inside the track's own box. This
    // is the whole point of side-by-side, and it is measured off the rendered
    // rectangles rather than inferred from the widths.
    neighbourVisible: (()=>{
      const tb=t.getBoundingClientRect(), nx=slides[at+1]||slides[at-1];
      if(!nx) return 0;
      const b=nx.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(b.right,tb.right)-Math.max(b.left,tb.left)));
    })(),
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
  // Side by side: a card no longer fills the track, because the neighbours
  // have to show at the edges — otherwise the row reads as a single card that
  // changes when you are not looking, and nothing tells you there are five
  // more. Between 75% and 92%: narrower and the card itself starts to suffer,
  // wider and the peek is a sliver nobody notices.
  const ratio = s.cardW / s.trackW;
  (ratio > 0.75 && ratio < 0.92)
    ? ok('a card leaves room for its neighbours',`${s.cardW} of ${s.trackW}px, ${Math.round(ratio*100)}%`)
    : bad('a card leaves room for its neighbours',`${s.cardW} of ${s.trackW}px, ${Math.round(ratio*100)}%`);
  // And they are actually ON SCREEN, which the ratio alone does not prove —
  // a gap, or an edge fade, big enough to hide them passes the check above.
  // Both of those happened: the first attempt scored 84% here and showed an
  // 11px sliver under a fade that covered it, which is no peek at all. 18px
  // is about where a strip of a card starts reading as a card.
  s.neighbourVisible >= 18
    ? ok('and the next countdown really is visible',`${s.neighbourVisible}px of it`)
    : bad('and the next countdown really is visible',`only ${s.neighbourVisible}px — too thin to read as a card`);
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
      // 320ms read the height mid-ease and made this a coin toss between runs.
      // The settle is debounced 160ms after the scroll stops, and only THEN
      // does the height start a 250ms transition — so nothing under 410ms can
      // see the final value. The failures looked exactly like that: 701 vs
      // 712, 850 vs 864, a height still travelling toward the right one.
      await new Promise(r=>setTimeout(r,700));
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
  strip.strip && strip.navShown && strip.dots===7
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
    return {slides:vis.length, navHidden:nav.hidden, dots:nav.querySelectorAll('.cd-dot').length,
            cardW: vis[0]?Math.round(vis[0].getBoundingClientRect().width):0,
            trackW: Math.round(t.clientWidth)};
  });
  s.slides===1 ? ok('one slide') : bad('one slide',`${s.slides}`);
  s.navHidden===true ? ok('and the controls take themselves away') : bad('and the controls take themselves away');
  s.dots<=1 ? ok('no stale dots left over',`${s.dots}`) : bad('no stale dots left over',`${s.dots}`);
  // With no neighbours to peek at, leaving room for them only makes the card
  // narrow for nothing — so the single-slide case goes back to filling.
  Math.abs(s.cardW-s.trackW)<=2 ? ok('and it fills the view, with nothing to peek at',`${s.cardW}px`)
                                : bad('and it fills the view, with nothing to peek at',`card ${s.cardW} vs track ${s.trackW}`);
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
  f.dots===7 ? ok('a dot for every picture in the strip') : bad('a dot for every picture in the strip',`${f.dots}`);
  f.navHidden===false ? ok('the dots are shown') : bad('the dots are shown');
  f.frameW===f.trackW ? ok('one frame at a time',`${f.frameW}px`) : bad('one frame at a time',`${f.frameW} vs ${f.trackW}`);
  const before=f.at;
  await page.waitForTimeout(6000);                       // autoplay is 4500ms
  f=await read();
  f.at!==before ? ok('it advances on its own',`${before} → ${f.at}`) : bad('it advances on its own',`stuck at ${f.at}`);
  f.lit===f.at ? ok('and the dot keeps up') : bad('and the dot keeps up',`at ${f.at}, lit ${f.lit}`);
  // A finger landing on the track is NOT a choice, and treating it as one is
  // what made the looping die on a phone: hold() was bound to touchstart, so
  // the first finger that was only scrolling the page past this card stopped
  // it for the rest of the visit. A mostly-vertical drag is that finger.
  const strip = page.locator('.cd-card-lisa .cd-strip');
  const touch = (type, x, y) => strip.dispatchEvent(type,
    { clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', bubbles: true });
  await touch('pointerdown', 100, 300);
  await touch('pointermove', 104, 200);          // dy 100, dx 4 — a page scroll
  await touch('pointerup',   104, 200);
  // Settle first. An autoplay tick fired just before the touch is still
  // scrolling smoothly, so reading the position now catches it mid-flight and
  // the comparison below fails on a carousel that did stop — which is how this
  // check went red once in four runs.
  await page.waitForTimeout(1200);
  const scrolled=(await read()).at;
  await page.waitForTimeout(7000);
  const afterScroll=(await read()).at;
  afterScroll!==scrolled ? ok('a finger only scrolling the page does not stop it',`${scrolled} → ${afterScroll}`)
                         : bad('a finger only scrolling the page does not stop it',`stuck at ${scrolled}`);

  // Same finger, but released past the card's edge — its pointerup lands on
  // some other element, so a handler bound to the track would never see it
  // and the pause taken on pointerdown would never lift.
  await touch('pointerdown', 100, 300);
  await touch('pointermove', 104, 180);
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerup',
    { bubbles: true, pointerId: 1, pointerType: 'touch', clientX: 104, clientY: 60 })));
  await page.waitForTimeout(1200);
  const offEdge=(await read()).at;
  await page.waitForTimeout(7000);
  const afterOffEdge=(await read()).at;
  afterOffEdge!==offEdge ? ok('and a drag released off the card still lets it resume',`${offEdge} → ${afterOffEdge}`)
                         : bad('and a drag released off the card still lets it resume',`stuck at ${offEdge}`);

  // A sideways drag IS taking it over, and that holds for good.
  await touch('pointerdown', 300, 300);
  await touch('pointermove', 230, 303);          // dx 70, dy 3 — a real swipe
  await touch('pointerup',   230, 303);
  await page.waitForTimeout(1200);
  const held=(await read()).at;
  await page.waitForTimeout(7000);
  const after=(await read()).at;
  after===held ? ok('and stops for good once you swipe it',`held on ${held}`)
               : bad('and stops for good once you swipe it',`${held} → ${after}`);
  await page.close();
}

console.log('--- what a phone gets: arrows, dots and a carousel that runs itself');
{
  // isMobile, not just hasTouch: `@media (hover: none)` is what hid the arrows,
  // and only mobile emulation sets that media feature.
  const ctx=await browser.newContext({viewport:{width:390,height:900}, hasTouch:true, isMobile:true});
  const page=await ctx.newPage();
  await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator(TRACK).waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  const controls=await page.evaluate(()=>{
    const nav=document.querySelector('#home-countdowns > [data-carousel-nav]');
    const arrows=nav?[...nav.querySelectorAll('.cd-arrow')]:[];
    return {navHidden:nav?nav.hidden:null, dots:nav?nav.querySelectorAll('.cd-dot').length:0,
      arrows:arrows.map(a=>{const r=a.getBoundingClientRect();
        return {shown:getComputedStyle(a).display!=='none', w:Math.round(r.width), h:Math.round(r.height),
                dir:a.dataset.carouselDir};})};
  });
  controls.arrows.length===2 ? ok('both arrows are in the nav') : bad('both arrows are in the nav',`${controls.arrows.length}`);
  controls.arrows.every(a=>a.shown)
    ? ok('and a phone can see them')
    : bad('and a phone can see them','display:none — the (hover:none) rule is back');
  // 44px is the smallest target a thumb reliably hits, and the reason they
  // were hidden here in the first place was that 32px next to a card edge is
  // not one. Showing them at 32px would repeat that mistake, not fix it.
  const small=controls.arrows.filter(a=>a.w<40||a.h<40);
  small.length ? bad('and they are big enough to hit',small.map(a=>`${a.w}×${a.h}`).join(', '))
               : ok('and they are big enough to hit',controls.arrows.map(a=>`${a.w}×${a.h}`).join(', '));
  controls.dots>1 ? ok('the dots are there too',`${controls.dots}`) : bad('the dots are there too',`${controls.dots}`);

  // Tapping an arrow moves it, which is the whole point of showing them.
  const where=()=>page.evaluate(()=>{const t=document.querySelector('#home-countdowns > .cd-wrap');
    return Math.round(t.scrollLeft);});
  const x0=await where();
  await page.locator('#home-countdowns > [data-carousel-nav] [data-carousel-dir="1"]').tap();
  await page.waitForTimeout(900);
  const x1=await where();
  x1>x0 ? ok('tapping › moves to the next countdown',`${x0} → ${x1}`)
        : bad('tapping › moves to the next countdown',`${x0} → ${x1}`);

  // And it runs on its own. The arrow tap above was a deliberate choice, so it
  // has already held autoplay — reload to get an untouched carousel.
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator(TRACK).waitFor({timeout:20000});
  await page.waitForTimeout(2500);
  await page.locator(TRACK).scrollIntoViewIfNeeded().catch(()=>{});
  await page.waitForTimeout(800);
  const y0=await where();
  await page.waitForTimeout(12000);              // the countdown carousel is 9000ms
  const y1=await where();
  y1!==y0 ? ok('and the countdowns advance on their own',`${y0} → ${y1}`)
          : bad('and the countdowns advance on their own',`stuck at ${y0}`);
  await ctx.close();
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
