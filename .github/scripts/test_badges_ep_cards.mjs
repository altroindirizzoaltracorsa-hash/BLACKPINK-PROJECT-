// The daily challenge's collapsible EP tiles, in a real browser.
//
// Run: node .github/scripts/test_badges_ep_cards.mjs
//
// Fifteen equal cards read as a wall, so each EP folds into one tile with the
// combined count and its tracks a tap away. Three things go wrong silently
// here: a track that belongs to an EP also rendering as a loose card (counted
// twice on screen), a summary number that is not the sum of what opening it
// shows, and a tile whose body is clipped so the last track cannot be reached
// at all — none of which throws, and the last of which is invisible in a
// screenshot of the closed state.
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
    res.end(b);}catch{res.writeHead(404);res.end('{}');}});
await new Promise(r=>server.listen(0,r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
let fails=0;
const ok=(m,d)=>console.log(`  ok   ${m}${d?` (${d})`:''}`);
const bad=(m,d)=>{fails++;console.log(`  FAIL ${m}${d?` (${d})`:''}`);};

// Both widths: the open tile spans the row at three columns and stacks at one,
// and the body cap has to clear the taller (stacked) case.
for (const vp of [{width:1280,height:1000,name:'desktop'},{width:430,height:950,name:'phone'}]) {
  const page=await browser.newPage({viewport:{width:vp.width,height:vp.height}});
  await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(base+'/badges',{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(2500);
  console.log(`\n  — ${vp.name} ${vp.width}px —`);

  // Render with a distinct count per track so a summary that sums the wrong
  // set cannot coincidentally match. Equal counts would hide that.
  const seeded = await page.evaluate(() => {
    const counts = zeroTrackCounts();
    SCROBBLE_TRACK_IDS.forEach((id, i) => { counts[id] = (i + 1) * 3; });
    renderProfile({
      info: { name: 'test', playcount: 0, registered: { unixtime: 0 }, image: [] },
      artistPlays: 0, totalPlays: counts, todayCounts: counts, weekCounts: counts,
      weekDays: [], lastScrobbleTs: null, memberPlays: zeroMemberPlays(),
    });
    return counts;
  });

  const shape = await page.evaluate(() => {
    const grid = document.querySelector('#daily-challenge-grid .daily-grid');
    const tiles = [...grid.children];
    return {
      tileCount: tiles.length,
      // Only the cards that are NOT inside an EP body are top-level tiles.
      looseNames: tiles.filter(el => !el.classList.contains('daily-ep'))
        .map(el => el.querySelector('.daily-song-name')?.textContent.trim()),
      eps: [...grid.querySelectorAll('.daily-ep')].map(el => ({
        key: el.dataset.ep,
        label: el.querySelector('.daily-song-name').textContent.replace('▾','').trim(),
        summary: Number(el.querySelector('.daily-ep-head .daily-count').textContent.trim()),
        inner: [...el.querySelectorAll('.daily-ep-grid .daily-card')].map(c => ({
          name: c.querySelector('.daily-song-name').textContent.trim(),
          count: Number(c.querySelector('.daily-count').textContent.trim()),
        })),
      })),
      epMembership: EP_RELEASES.map(g => ({ key: g.key, label: g.label, songs: g.songs })),
      titleOf: Object.fromEntries(TRACKS.map(t => [t.id, t.title])),
    };
  });

  console.log(`    ${shape.tileCount} tiles · loose: ${shape.looseNames.join(', ')}`);
  shape.eps.length === 2 ? ok('both EPs are folded into a tile')
                         : bad('both EPs are folded into a tile', `${shape.eps.length} found`);

  // No EP track may also be a loose card: that is the same scrobble shown twice.
  const epTitles = new Set(shape.epMembership.flatMap(g => g.songs.map(id => shape.titleOf[id])));
  const dupes = shape.looseNames.filter(n => epTitles.has(n));
  dupes.length ? bad('no EP track is also a loose card', dupes.join(', '))
               : ok('no EP track is also a loose card');

  for (const ep of shape.eps) {
    const inner = ep.inner.reduce((s, c) => s + c.count, 0);
    ep.summary === inner
      ? ok(`${ep.label}: the summary is the sum of its tracks`, `${ep.summary} = ${ep.inner.map(c=>c.count).join('+')}`)
      : bad(`${ep.label}: the summary is the sum of its tracks`, `shows ${ep.summary}, tracks total ${inner}`);
    const want = shape.epMembership.find(g => g.key === ep.key).songs.map(id => shape.titleOf[id]);
    JSON.stringify(ep.inner.map(c => c.name)) === JSON.stringify(want)
      ? ok(`${ep.label}: holds its own tracks, in order`, want.join(' · '))
      : bad(`${ep.label}: holds its own tracks, in order`, `got ${ep.inner.map(c=>c.name).join(' · ')}`);
  }

  // Closed means not reachable; open means every track fully visible. The cap
  // on .daily-ep-body is a fixed pixel value, so this is the check that it is
  // actually big enough rather than merely plausible.
  const pp = page.locator('.daily-ep[data-ep="pressplay"]');
  // How much of the first track card is actually inside the body's box.
  // Playwright's isVisible() is the wrong probe here: it ignores clipping by an
  // ancestor's overflow, so a card inside a max-height:0 body still reads
  // visible and the closed state would pass no matter what.
  const reach = () => page.evaluate(() => {
    const el = document.querySelector('.daily-ep[data-ep="pressplay"]');
    const body = el.querySelector('.daily-ep-body').getBoundingClientRect();
    const card = el.querySelector('.daily-ep-grid .daily-card').getBoundingClientRect();
    return {
      bodyH: Math.round(body.height),
      shown: Math.round(Math.max(0, Math.min(body.bottom, card.bottom) - Math.max(body.top, card.top))),
    };
  });
  const closed = await reach();
  closed.shown === 0 ? ok('an EP starts closed', `body ${closed.bodyH}px`)
                     : bad('an EP starts closed', `${closed.shown}px of a track already showing`);

  await pp.locator('.daily-ep-head').click();
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => {
    const el = document.querySelector('.daily-ep[data-ep="pressplay"]');
    const body = el.querySelector('.daily-ep-body');
    const cards = [...el.querySelectorAll('.daily-ep-grid .daily-card')];
    const gridRect = el.querySelector('.daily-ep-grid').getBoundingClientRect();
    return {
      expanded: el.querySelector('.daily-ep-head').getAttribute('aria-expanded'),
      // The content's own height vs the box allowed to show it.
      contentH: Math.round(gridRect.height),
      visibleH: Math.round(body.getBoundingClientRect().height),
      lastCardBottomInside: Math.round(
        cards[cards.length-1].getBoundingClientRect().bottom - body.getBoundingClientRect().bottom),
      spansRow: getComputedStyle(el).gridColumnStart === '1',
    };
  });
  opened.expanded === 'true' ? ok('clicking opens it') : bad('clicking opens it', opened.expanded);
  opened.lastCardBottomInside <= 1
    ? ok('the last track is not clipped', `content ${opened.contentH}px, box ${opened.visibleH}px`)
    : bad('the last track is not clipped',
          `content ${opened.contentH}px overflows the box by ${opened.lastCardBottomInside}px — raise the max-height cap`);
  const shownOpen = await reach();
  shownOpen.shown > 20 ? ok('its tracks are visible once open', `${shownOpen.shown}px of the first card`)
                       : bad('its tracks are visible once open', `only ${shownOpen.shown}px`);

  await pp.locator('.daily-ep-head').click();
  await page.waitForTimeout(600);
  const reclosed = await reach();
  reclosed.shown === 0 ? ok('clicking again closes it')
                       : bad('clicking again closes it', `${reclosed.shown}px still showing`);

  // Before the rest of an EP is out, its one released track must stay a plain
  // card: folding a single track behind an "EP" tile hides it and claims a
  // release that has not landed. Checked by moving the clock back rather than
  // by trusting the branch, since this is the state the page will be in for
  // every future EP's pre-release week.
  const prePP = await page.evaluate(() => {
    const real = Date.now;
    try {
      Date.now = () => pressPlayOutAt() - 3600 * 1000;  // an hour before local midnight
      const counts = zeroTrackCounts();
      SCROBBLE_TRACK_IDS.forEach((id, i) => { counts[id] = (i + 1) * 3; });
      renderProfile({
        info: { name: 'test', playcount: 0, registered: { unixtime: 0 }, image: [] },
        artistPlays: 0, totalPlays: counts, todayCounts: counts, weekCounts: counts,
        weekDays: [], lastScrobbleTs: null, memberPlays: zeroMemberPlays(),
      });
      const grid = document.querySelector('#daily-challenge-grid .daily-grid');
      return {
        eps: [...grid.querySelectorAll('.daily-ep')].map(e => e.dataset.ep),
        loose: [...grid.children].filter(e => !e.classList.contains('daily-ep'))
          .map(e => e.querySelector('.daily-song-name')?.textContent.trim()),
      };
    } finally { Date.now = real; }
  });
  !prePP.eps.includes('pressplay')
    ? ok('pre-release: no PRESS PLAY tile', `tiles: ${prePP.eps.join(', ') || 'none'}`)
    : bad('pre-release: no PRESS PLAY tile', 'a one-track EP tile was rendered');
  prePP.loose.includes('SAWADIKA')
    ? ok('pre-release: SaWaDiKa stays a plain card')
    : bad('pre-release: SaWaDiKa stays a plain card', `loose: ${prePP.loose.join(', ')}`);
  prePP.loose.some(n => ['V12','COBRA','TARANTINO','CUT U OFF','SWEAT'].includes(n))
    ? bad('pre-release: the unreleased five are absent', prePP.loose.join(', '))
    : ok('pre-release: the unreleased five are absent');

  if (errs.length) { console.log('    page errors: ' + errs.slice(0,4).join(' | ')); fails += errs.length; }
  await page.close();
}

await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
