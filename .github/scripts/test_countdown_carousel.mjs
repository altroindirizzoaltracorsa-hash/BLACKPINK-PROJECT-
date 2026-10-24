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
  // The service worker is withheld on purpose. index.html reloads the page
  // once on `controllerchange`, which is right in a browser and fatal here:
  // the reload lands mid-check and tears down the execution context, so a
  // run fails with "Cannot read properties of null" on an element the
  // locator had just waited for. Measured, not guessed — it took out the hub
  // section roughly one run in three. Nothing below tests caching.
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
  // The loop moves cards between the ends, so where a card SITS is not where
  // it comes in the running order. `at` is the DOM position of whatever is
  // centred; `atLogical` is that card's place in the authored order, which is
  // what the dots are indexed by.
  const lg = (el)=> (el && el._cdLogical!=null) ? el._cdLogical : slides.indexOf(el);
  return {slides:slides.length, dots:dots.length, lit:dots.findIndex(d=>d.classList.contains('is-on')),
    navHidden: nav?nav.hidden:null, at, atLogical: lg(slides[at]),
    showing: slides[at]?.dataset.slug,
    horiz: t.scrollWidth>t.clientWidth+2,
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
  // in, and it is invisible from any one card's markup.
  //
  // What is still AHEAD comes first, soonest to furthest: ADDICTED on Oct 30,
  // then Someone to Hold with the Steps film on Nov 20. Then the ones already
  // out, newest first. PRESS PLAY led this list until it was released on the
  // 23rd; a countdown to a date that has passed is not the thing to open on.
  // CLICK (jisoo.io) is no longer in this row at all — it moved to the past
  // block on 2026-10-24, which is what the #cd-past check below now expects.
  const ORDER = ['addicted','steps','lalisaofficial.com','newtrick','hellosawadika.com'];
  // Read the AUTHORED order, not the DOM order: with looping on, the track
  // rotates cards between its ends, so the DOM order is the running order
  // turned by however many times it has wrapped.
  const got = await page.evaluate(()=>[...document.querySelectorAll('#home-countdowns > .cd-wrap > .cd-card')]
    .map((c,i)=>({slug:c.dataset.slug, k: c._cdLogical!=null ? c._cdLogical : i}))
    .sort((a,b)=>a.k-b.k).map(o=>o.slug));
  // Auto-discovered pre-releases are inserted ahead of everything on purpose,
  // so compare the hand-authored cards in the order they appear among them.
  const hand = got.filter(g=>ORDER.includes(g));
  JSON.stringify(hand)===JSON.stringify(ORDER)
    ? ok('they run in the order they are meant to', hand.join(' → '))
    : bad('they run in the order they are meant to', `got ${hand.join(' → ')}`);
  // What is ON SCREEN at rest, which is the thing that matters and is not the
  // same as what is first in the DOM once the track can rotate.
  s.showing===ORDER[0] ? ok('and the carousel opens on the next release',`${s.showing}`)
                       : bad('and the carousel opens on the next release',`opens on ${s.showing}, want ${ORDER[0]}`);
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

  // ONE FLICK, ONE CARD — and this is now a real measurement, which the two
  // earlier attempts could not have. Those left the scrolling to the browser
  // and tried to constrain it with scroll-snap-stop; the thing doing the
  // scrolling was then the compositor's fling, which cannot be produced here
  // (synthetic touch carries no momentum, and synthesizeScrollGesture will
  // not drive this element), so the check could only ever inspect the rule
  // rather than the behaviour. The track now declares `touch-action: pan-y`,
  // which means the browser never scrolls it sideways at all and the gesture
  // is handled by the page on the main thread — so a pointerdown/move/up
  // sequence IS the production path, and the length of the drag is the thing
  // that used to decide how many cards went past.
  await page.evaluate(()=>document.querySelector('#home-countdowns > .cd-wrap')
    .dispatchEvent(new Event('focusin',{bubbles:true})));      // autoplay out of the way
  const ta = await page.evaluate(()=>
    getComputedStyle(document.querySelector('#home-countdowns > .cd-wrap')).touchAction);
  /(^|\s)pan-y(\s|$)/.test(ta) && !/manipulation|auto|pan-x/.test(ta)
    ? ok('the browser does not scroll the cards itself',`touch-action: ${ta}`)
    : bad('the browser does not scroll the cards itself',
          `touch-action: ${ta} — a sideways fling belongs to the compositor again, and it will run past several cards`);
  // Dispatched on the track and left to bubble, the way a real touch arrives.
  const drag = async (dx, steps=14) => {
    await page.evaluate(({dx,steps})=>new Promise(res=>{
      const el=document.querySelector('#home-countdowns > .cd-wrap');
      const r=el.getBoundingClientRect();
      const y=Math.round(r.top+Math.min(80, r.height/2));
      const x0=Math.round(r.left+r.width/2);
      const send=(type,x)=>el.dispatchEvent(new PointerEvent(type,
        {clientX:x, clientY:y, pointerId:7, pointerType:'touch', bubbles:true}));
      send('pointerdown', x0);
      let i=0;
      const tick=()=>{
        i++;
        send('pointermove', Math.round(x0+dx*i/steps));
        if (i<steps) { requestAnimationFrame(tick); return; }
        send('pointerup', Math.round(x0+dx));
        res();
      };
      requestAnimationFrame(tick);
    }), {dx,steps});
    await page.waitForTimeout(1000);
  };
  // A short swipe and a long one. The long one is the complaint: 700px across
  // a 390px viewport is nearly two whole cards of travel, and before this it
  // would have carried three or four. Compared on the AUTHORED index, because
  // the loop rotates the DOM underneath and a position in the track names a
  // different card each lap.
  for (const [dx,label] of [[-140,'a short swipe'],[-700,'a long flick'],[700,'and a long flick back']]) {
    const was=await state(page);
    await drag(dx);
    const now=await state(page);
    const n=now.slides;
    const want=((was.atLogical + (dx<0?1:-1)) % n + n) % n;
    now.atLogical===want
      ? ok(`${label} moves exactly one card`,`${was.showing} → ${now.showing}`)
      : bad(`${label} moves exactly one card`,
            `${was.showing} → ${now.showing}, which is ${((now.atLogical-was.atLogical)%n+n)%n} along, not 1`);
  }

  // Same here: hold autoplay still so the position under test is the one the
  // check put it in.
  await page.evaluate(()=>document.querySelector('#home-countdowns > .cd-wrap')
    .dispatchEvent(new Event('focusin',{bubbles:true})));
  // Scroll the track and watch the dots follow the real position.
  await page.evaluate(()=>{const t=document.querySelector('#home-countdowns > .cd-wrap');
    // Through the page's own navigation, and aimed by the card's place in the
    // RUNNING ORDER rather than its position in the DOM — looping rotates the
    // DOM, so a bare index means a different card each time round. (A plain
    // two-card scrollBy is also no longer something a finger can do: one
    // flick moves one card, which is the feature.)
    const sl=[...t.children].filter(c=>c.nodeType===1&&getComputedStyle(c).display!=='none');
    const pos=sl.findIndex(c=>(c._cdLogical!=null?c._cdLogical:sl.indexOf(c))===2);
    carouselGo(t, pos, false);});
  await page.waitForTimeout(900);
  s=await state(page);
  // The lit dot must name the card that is centred. Compared in the authored
  // order, because that is what the dots are: a fixed row standing for the
  // running order, not for where a card happens to sit after the track has
  // rotated. Scrolling two slides on from the opener lands on the third card.
  (s.lit===s.atLogical && s.atLogical===2)
    ? ok('the dots follow the scroll position',`"${s.showing}", dot ${s.lit}`)
    : bad('the dots follow the scroll position',`showing "${s.showing}" (order ${s.atLogical}), lit ${s.lit}`);

  // A dot is a destination, not a decoration.
  // Scoped to the countdown nav: the MV frames have dots of their own, inside
  // the LISA card, which come first in document order.
  await page.evaluate(()=>document.querySelectorAll('#home-countdowns > [data-carousel-nav] .cd-dot')[4].click());
  await page.waitForTimeout(900);
  s=await state(page);
  // Compared on the AUTHORED index, not the DOM position: the fifth dot stands
  // for the fifth countdown in the running order, and looping moves that card
  // around the track, so demanding it sit fifth in the DOM is asking the wrong
  // question. It passed for a while on the rotation happening to line up.
  (s.atLogical===4 && s.lit===4)
    ? ok('clicking a dot goes to that slide',`"${s.showing}"`)
    : bad('clicking a dot goes to that slide',`showing "${s.showing}" (order ${s.atLogical}), lit ${s.lit}`);
  // The track takes the height of the card you are on — otherwise a poster-
  // shaped card sits over a few hundred pixels of nothing, left by whichever
  // sibling happens to be tallest.
  // Freeze autoplay first. It no longer stops when you touch the thing, it
  // just waits out a fresh interval, so a measurement that walks every card
  // can have the track moved under it halfway through — which is what made
  // this read one card's height against another's. focusin is the page's own
  // way of saying "a keyboard user is reading this; stay put".
  await page.evaluate(()=>document.querySelector('#home-countdowns > .cd-wrap')
    .dispatchEvent(new Event('focusin',{bubbles:true})));
  const fit = await page.evaluate(async ()=>{
    const t=document.querySelector('#home-countdowns > .cd-wrap');
    const live=()=>[...t.children].filter(c=>c.nodeType===1&&getComputedStyle(c).display!=='none');
    // Hold the CARDS, not their indexes. Looping moves cards between the ends
    // of the track, so an index walked in a loop names a different card each
    // time and the height read back belongs to its neighbour.
    const cards=live();
    const out=[];
    for (const card of cards){
      carouselGo(t, live().indexOf(card), false);
      // 320ms read the height mid-ease and made this a coin toss between runs.
      // The settle is debounced 160ms after the scroll stops, and only THEN
      // does the height start a 250ms transition — so nothing under 410ms can
      // see the final value. The failures looked exactly like that: 701 vs
      // 712, 850 vs 864, a height still travelling toward the right one.
      await new Promise(r=>setTimeout(r,700));
      out.push({card:Math.round(card.offsetHeight), track:Math.round(t.clientHeight)});
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

console.log('--- nothing hangs off the side of a card');
{
  // Narrowing the cards to 80% to let the neighbours show took about 56px off
  // every card, and three things that had been sized off the WINDOW did not
  // notice: both clocks (one of whose clamp FLOOR was already wider than the
  // card) and the SaWaDiKa wordmark, which has a 220px floor and sat in a
  // 156px box. All three hung off the right-hand edge. Checked at three real
  // phone widths, because the narrowest is where a floor bites first.
  for (const w of [360, 390, 414]) {
    const page=await newPage(w,900);
    await page.goto(base+'/',{waitUntil:'domcontentloaded'});
    await page.locator(TRACK).waitFor({timeout:20000});
    await page.waitForTimeout(2800);
    const over=await page.evaluate(()=>{
      const out=[];
      document.querySelectorAll('#home-countdowns .cd-card').forEach(card=>{
        if(getComputedStyle(card).display==='none') return;
        const cs=getComputedStyle(card), cr=card.getBoundingClientRect();
        const L=cr.left+parseFloat(cs.paddingLeft), R=cr.right-parseFloat(cs.paddingRight);
        const slug=card.dataset.slug||card.className;
        card.querySelectorAll('*').forEach(el=>{
          if(getComputedStyle(el).display==='none') return;
          // These bleed to the card's edge on purpose: width:calc(100% + 2.8rem)
          // with a matching negative margin.
          if(el.closest('.ad-sky, .cd-hero, .st-hero')) return;
          // And anything inside a sideways scroller is MEANT to sit outside
          // the visible box — that is what makes it a scroller.
          for(let p=el.parentElement;p&&p!==card;p=p.parentElement){
            const ox=getComputedStyle(p).overflowX;
            if(ox==='auto'||ox==='scroll') return;
          }
          const r=el.getBoundingClientRect();
          if(!r.width) return;
          const spill=Math.max(L-r.left, r.right-R);
          if(spill>1.5) out.push({slug, el:el.className||el.tagName, spill:Math.round(spill),
                                  text:(el.textContent||'').trim().slice(0,20)});
        });
      });
      const best={};
      out.forEach(o=>{ if(!best[o.slug]||o.spill>best[o.slug].spill) best[o.slug]=o; });
      return Object.values(best);
    });
    over.length
      ? bad(`nothing overflows its card at ${w}px`,
            over.map(o=>`${o.slug} <${o.el}> by ${o.spill}px`).join('; '))
      : ok(`nothing overflows its card at ${w}px`);
    await page.close();
  }
}

console.log('--- it runs endlessly, in both directions');
{
  const page=await newPage();
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator(TRACK).waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  // Which CARD is centred, and which dot is lit for it. Both matter: the loop
  // works by moving cards in the DOM, so a card's position changes under it
  // and a dot indexed by position would skate across the row every time the
  // track turned over.
  const where=()=>page.evaluate(()=>{
    const t=document.querySelector('#home-countdowns > .cd-wrap');
    const nav=document.querySelector('#home-countdowns > [data-carousel-nav]');
    const sl=[...t.children].filter(c=>c.nodeType===1&&getComputedStyle(c).display!=='none');
    const mid=t.scrollLeft+t.clientWidth/2;
    let at=0,g=Infinity; sl.forEach((s,i)=>{const d=Math.abs((s.offsetLeft+s.offsetWidth/2)-mid); if(d<g){g=d;at=i;}});
    const dots=[...nav.querySelectorAll('.cd-dot')];
    return { slug: sl[at]?.dataset.slug, lit: dots.findIndex(d=>d.classList.contains('is-on')), n: sl.length };
  });
  const go=async(dir)=>{ await page.locator(`#home-countdowns > [data-carousel-nav] [data-carousel-dir="${dir}"]`).click();
                         await page.waitForTimeout(1300); return where(); };
  const first=await where();
  // All the way round and one past the end.
  const seen=[first.slug];
  let w=first;
  for (let i=0;i<first.n;i++){ w=await go(1); seen.push(w.slug); }
  const wrapped = seen[seen.length-1]===first.slug;
  wrapped ? ok('forward past the last card carries on into the first',seen.join(' → '))
          : bad('forward past the last card carries on into the first',seen.join(' → '));
  new Set(seen.slice(0,first.n)).size===first.n
    ? ok('and it passes every card exactly once on the way',`${first.n} cards`)
    : bad('and it passes every card exactly once on the way',seen.join(','));
  w.lit===first.lit ? ok('the dot comes back round with it',`dot ${w.lit}`)
                    : bad('the dot comes back round with it',`dot ${w.lit}, started on ${first.lit}`);
  // And backwards off the front edge.
  const back=await go(-1);
  back.slug!==first.slug && back.lit!==first.lit
    ? ok('and back past the first carries on into the last',`${first.slug} ← ${back.slug}`)
    : bad('and back past the first carries on into the last',JSON.stringify(back));
  await page.close();
}

console.log('--- the hub lists them, it does not page through them');
{
  const page=await newPage();
  await page.goto(base+'/countdowns',{waitUntil:'domcontentloaded'});
  await page.locator(TRACK).waitFor({timeout:20000});
  await page.waitForTimeout(3000);
  const r=await page.evaluate(()=>{
    const w=document.querySelector('#home-countdowns > .cd-wrap');
    const nav=document.querySelector('#home-countdowns > [data-carousel-nav]');
    const cards=[...w.children].filter(c=>c.nodeType===1&&getComputedStyle(c).display!=='none');
    const tops=cards.map(c=>Math.round(c.getBoundingClientRect().top));
    return { n: cards.length, dir: getComputedStyle(w).flexDirection,
             stacked: new Set(tops).size===tops.length,
             // Top to bottom as the reader meets them, against the authored
             // running order held on each card. Looping browses by moving a
             // card from one end of the track to the other, so the DOM order
             // on arrival is the running order turned by however many times it
             // has wrapped — which a carousel is indifferent to and a LIST is
             // not. The hub was opening on hellosawadika.com for exactly that
             // reason.
             domOrder: cards.map(c=>c.dataset.slug),
             byLogical: cards.map((c,i)=>({s:c.dataset.slug,k:c._cdLogical!=null?c._cdLogical:i}))
               .sort((a,b)=>a.k-b.k).map(o=>o.s),
             navHidden: nav?nav.hidden:null, inlineHeight: w.style.height||'',
             dimmed: cards.filter(c=>c.classList.contains('is-ahead')).length,
             widthsSame: new Set(cards.map(c=>Math.round(c.getBoundingClientRect().width))).size===1,
             pageOverflow: document.documentElement.scrollWidth>window.innerWidth+1 };
  });
  r.n>=5 ? ok('every countdown is on the page',`${r.n}`) : bad('every countdown is on the page',`${r.n}`);
  r.dir==='column' && r.stacked
    ? ok('one under another, not side by side')
    : bad('one under another, not side by side',JSON.stringify(r));
  JSON.stringify(r.domOrder)===JSON.stringify(r.byLogical)
    ? ok('and in the order they are meant to run', r.domOrder.join(' → '))
    : bad('and in the order they are meant to run',
          `reads ${r.domOrder.join(' → ')}, should be ${r.byLogical.join(' → ')}`);
  r.navHidden===true ? ok('and the carousel controls stand down')
                     : bad('and the carousel controls stand down',`navHidden=${r.navHidden}`);
  // A list has no single height to take and nothing to dim: both are carousel
  // ideas that would be left behind on the cards if the switch were partial.
  !r.inlineHeight ? ok('the track drops its fitted height') : bad('the track drops its fitted height',r.inlineHeight);
  r.dimmed===0 ? ok('and nothing is dimmed as a neighbour') : bad('and nothing is dimmed as a neighbour',`${r.dimmed}`);
  !r.pageOverflow ? ok('the page still does not scroll sideways') : bad('the page still does not scroll sideways');
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

  // A sideways drag used to stop it for good. It now buys the FULL interval
  // instead: landing somewhere on purpose should not be undone a moment
  // later by a tick that had been running since before you got there, but it
  // should not silence the thing either. So: still there a moment after, and
  // moving again once the interval has gone by.
  await touch('pointerdown', 300, 300);
  await touch('pointermove', 230, 303);          // dx 70, dy 3 — a real swipe
  await touch('pointerup',   230, 303);
  await page.waitForTimeout(1500);
  const landed=(await read()).at;
  await page.waitForTimeout(2500);               // well inside the 4.5s strip interval
  const soon=(await read()).at;
  soon===landed ? ok('a swipe buys the whole interval before it moves again',`held on ${landed}`)
                : bad('a swipe buys the whole interval before it moves again',`${landed} → ${soon} too soon`);
  await page.waitForTimeout(6000);
  const later=(await read()).at;
  later!==landed ? ok('and then it carries on by itself',`${landed} → ${later}`)
                 : bad('and then it carries on by itself',`still on ${landed}`);
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
  // Aimed at the card's own TEXT, not at a point 120px down from its corner.
  // That landed in the artwork, which is deliberately not a link now — so the
  // swipe half of this check would have passed whether or not the drag guard
  // existed, which is no check at all. The date line navigates, so a swipe
  // across it genuinely has to be held back by the guard.
  const spot = await page.evaluate(()=>{
    const card=[...document.querySelectorAll('#home-countdowns .cd-card')]
      .find(c=>c.offsetParent && getComputedStyle(c).display!=='none');
    const el=card && card.querySelector('.cd-sub');
    if (!el) return null;
    el.scrollIntoView({ block:'center', inline:'nearest', behavior:'instant' });
    const r=el.getBoundingClientRect();
    return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), slug: card.dataset.slug };
  });
  if (!spot) bad('a swipe across the cards stays on the hub','no card text to aim at');
  else {
    const fire=(x0,x1,y)=>page.evaluate(([x0,x1,y])=>{
      const el=document.elementFromPoint(x0,y);
      if (!el) return 'off screen';
      el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x0,clientY:y,pointerType:'touch'}));
      el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x1,clientY:y,pointerType:'touch'}));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x1,clientY:y}));
      return 'fired';
    },[x0,x1,y]);
    await fire(spot.x-60, spot.x+60, spot.y);     // a swipe, 120px across
    await page.waitForTimeout(900);
    page.url().endsWith('/countdowns') ? ok('a swipe across the cards stays on the hub')
                                       : bad('a swipe across the cards stays on the hub',page.url().replace(base,''));
    // ...and a tap in one place still opens that countdown.
    await fire(spot.x, spot.x+2, spot.y);
    await page.waitForTimeout(900);
    page.url()===base+'/countdowns/'+spot.slug
      ? ok('and a tap still opens that countdown',page.url().replace(base,''))
      : bad('and a tap still opens that countdown',`${page.url().replace(base,'')}, card was ${spot.slug}`);
  }
  await ctx.close();
}
console.log('--- from the home page, a countdown is a door');
{
  const page=await newPage();
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.locator(TRACK).waitFor({timeout:20000});
  await page.waitForTimeout(3000);

  // 1. The heading goes to the hub. A real link, so this also asserts the
  //    href — the thing that makes it openable in a new tab and followable by
  //    anything that is not a mouse.
  const head = await page.evaluate(()=>{
    const a=document.querySelector('#home-countdowns .cd-section-label a');
    return a ? { href: new URL(a.getAttribute('href'), location.origin).pathname, text: a.textContent.trim() } : null;
  });
  head && head.href==='/countdowns'
    ? ok('the Countdowns heading links to the hub', `"${head.text}" → ${head.href}`)
    : bad('the Countdowns heading links to the hub', head ? head.href : 'it is not a link at all');
  if (head) {
    await page.locator('#home-countdowns .cd-section-label a').click();
    await page.waitForTimeout(700);
    page.url().replace(base,'')==='/countdowns'
      ? ok('and clicking it opens the hub')
      : bad('and clicking it opens the hub', page.url().replace(base,''));
    await page.goBack(); await page.waitForTimeout(1200);
  }

  // 2. A tap on the card's own body opens that countdown. Aimed at the date
  //    line, which is text the card prints and nothing else claims.
  // Always aimed at the card that is ON SCREEN. Taking the first card in the
  // DOM does not do that: the loop rotates cards between the ends of the
  // track, so the first one is usually parked off to the left, where
  // elementFromPoint returns null and the tap lands on nothing at all. That
  // is what the first version of this check was measuring — silently.
  const tapShowing = async (relSel) => {
    const r = await page.evaluate((relSel)=>{
      const t=document.querySelector('#home-countdowns > .cd-wrap');
      const sl=[...t.children].filter(c=>c.nodeType===1&&getComputedStyle(c).display!=='none');
      const mid=t.scrollLeft+t.clientWidth/2; let at=0,g=Infinity;
      sl.forEach((s,i)=>{const d=Math.abs((s.offsetLeft+s.offsetWidth/2)-mid); if(d<g){g=d;at=i;}});
      const card=sl[at], el=card.querySelector(relSel);
      if (!el) return { missing: `no ${relSel} on ${card.dataset.slug}` };
      // These cards are taller than a phone screen, so the part being aimed
      // at is often below the fold — and a tap at a point outside the
      // viewport lands on nothing. inline:'nearest' so bringing it into view
      // cannot scroll the TRACK sideways and change which card is centred.
      // behavior:'instant' because the page sets html{scroll-behavior:smooth},
      // so a default scrollIntoView ANIMATES — and the rect read on the very
      // next line is still the old one. That is why this first reported the
      // element as off screen at exactly the coordinates it started at.
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const b2=el.getBoundingClientRect();
      const x=Math.round(b2.x+b2.width/2), y=Math.round(b2.y+b2.height/2);
      const hit=document.elementFromPoint(x,y);
      if (!hit) return { err: `${relSel} is still off screen at ${x},${y}` };
      hit.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y,pointerType:'touch'}));
      hit.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x+1,clientY:y+1,pointerType:'touch'}));
      hit.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x+1,clientY:y+1}));
      return { slug: card.dataset.slug, hit: hit.tagName.toLowerCase() };
    }, relSel);
    await page.waitForTimeout(800);
    return { ...r, url: page.url().replace(base,'') };
  };
  const t1 = await tapShowing('.cd-sub');
  (t1.err || t1.missing) ? bad('tapping the card opens its own countdown', t1.err || t1.missing)
    : t1.url===`/countdowns/${t1.slug}`
      ? ok('tapping the card opens its own countdown', t1.url)
      : bad('tapping the card opens its own countdown', `${t1.url} — the card showing is ${t1.slug}`);
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(2500);

  // 3. But the ARTWORK is not a link. ADDICTED's lockup turns under a finger
  //    and the sky strikes; a tap there belongs to the card. Same for the
  //    buttons, which have somewhere of their own to go.
  for (const [rel, what] of [['.ad-sky','the art'], ['.cd-btn','a button']]) {
    const r = await tapShowing(rel);
    if (r.missing) { continue; }             // this card has no such part
    if (r.err) { bad(`tapping ${what} does not navigate`, r.err); continue; }
    r.url==='/' ? ok(`tapping ${what} does not navigate`)
                : bad(`tapping ${what} does not navigate`, `it went to ${r.url}`);
    if (r.url!=='/') { await page.goto(base+'/',{waitUntil:'domcontentloaded'}); await page.waitForTimeout(2500); }
  }
  await page.close();
}

await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll carousel checks passed.');
process.exit(fails?1:0);
