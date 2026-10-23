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

  // ── the weekly table ──────────────────────────────────────────────────────
  // Same grouping, different mechanics: rows cannot nest, so a group is a
  // <tbody> and closed means its track rows are not laid out at all. Re-render
  // at today's clock first, since the pre-release check above left the table
  // drawn with PRESS PLAY ungrouped.
  await page.evaluate(() => {
    const counts = zeroTrackCounts();
    SCROBBLE_TRACK_IDS.forEach((id, i) => { counts[id] = (i + 1) * 3; });
    // A week of days, so the day cells have something to sum rather than all
    // reading "—". Monday is deliberately a clean sweep and Tuesday is not.
    const sweep = {}, partial = {};
    for (const id of SCROBBLE_TRACK_IDS) { sweep[id] = 9999; partial[id] = 1; }
    // Tuesday must be a genuine MIX inside each EP — one track over its tier,
    // the rest under. With nothing cleared, "every track done" and "any track
    // done" agree, and a group tick that fires on ANY track passes unnoticed.
    for (const g of EP_RELEASES) partial[g.songs[0]] = 9999;
    window.__wkPartial = partial;   // the check below needs the day's counts
    const weekDays = [{ label: 'Mon', counts: sweep }, { label: 'Tue', counts: partial },
                      ...Array.from({ length: 5 }, () => null)];
    renderProfile({
      info: { name: 'test', playcount: 0, registered: { unixtime: 0 }, image: [] },
      artistPlays: 0, totalPlays: counts, todayCounts: counts, weekCounts: counts,
      weekDays, lastScrobbleTs: null, memberPlays: zeroMemberPlays(),
    });
  });
  await page.waitForTimeout(300);

  const wk = await page.evaluate(() => {
    const table = document.querySelector('#weekly-challenge-grid .weekly-table');
    const groups = [...table.querySelectorAll('tbody.week-ep')];
    const laidOut = tr => !!tr.offsetParent || tr.getClientRects().length > 0;
    return {
      headerCells: table.querySelectorAll('thead th').length,
      // Every row must have exactly as many cells as the header, group rows
      // included: one short and the whole week shifts a column to the left.
      ragged: [...table.querySelectorAll('tr')]
        .filter(tr => tr.querySelectorAll('td').length &&
                      tr.querySelectorAll('td').length !== table.querySelectorAll('thead th').length)
        .map(tr => `${tr.querySelector('td')?.textContent.trim()}=${tr.querySelectorAll('td').length}`),
      groups: groups.map(g => ({
        key: g.dataset.ep,
        label: g.querySelector('.week-ep-head .song-name').textContent.replace('▾','').trim(),
        total: Number(g.querySelector('.week-ep-head td:last-child').textContent.trim().split('\n')[0]),
        trackTotals: [...g.querySelectorAll('.week-ep-track')].map(tr =>
          Number(tr.querySelector('td:last-child').textContent.trim().split('/')[0].replace(/[^0-9]/g,'') || 0)),
        trackNames: [...g.querySelectorAll('.week-ep-track .song-name')].map(e => e.textContent.trim()),
        tracksLaidOut: [...g.querySelectorAll('.week-ep-track')].filter(laidOut).length,
        // Monday was a clean sweep for everything, Tuesday was not.
        monDone: g.querySelector('.week-ep-head td:nth-child(2)').className === 'week-cell-done',
        tueDone: g.querySelector('.week-ep-head td:nth-child(3)').className === 'week-cell-done',
        // The NUMBER in the day cell, not just its styling: a cell summing
        // every track on the page still shows "partial" on a partial day.
        tueShown: Number(g.querySelector('.week-ep-head td:nth-child(3)').textContent.replace(/[^0-9]/g,'') || 0),
        tueOwn: EP_RELEASES.find(e => e.key === g.dataset.ep).songs
                  .reduce((s, id) => s + (window.__wkPartial[id] || 0), 0),
      })),
      looseRowCount: table.querySelectorAll('tbody:not(.week-ep) tr').length,
    };
  });

  console.log(`    weekly: ${wk.groups.length} group tbodies, ${wk.looseRowCount} loose rows`);
  wk.ragged.length ? bad('every weekly row has a full set of cells', wk.ragged.join(', '))
                   : ok('every weekly row has a full set of cells', `${wk.headerCells} columns`);
  wk.groups.length === 2 ? ok('both EPs are folded into a weekly row')
                         : bad('both EPs are folded into a weekly row', `${wk.groups.length}`);
  for (const g of wk.groups) {
    const sum = g.trackTotals.reduce((a, b) => a + b, 0);
    g.total === sum ? ok(`${g.label}: the weekly total is the sum of its tracks`, `${g.total}`)
                    : bad(`${g.label}: the weekly total is the sum of its tracks`, `row ${g.total} vs ${sum}`);
    g.tracksLaidOut === 0 ? ok(`${g.label}: its track rows start hidden`)
                          : bad(`${g.label}: its track rows start hidden`, `${g.tracksLaidOut} laid out`);
    // ✓ on a group day must mean EVERY track cleared its own tier that day.
    g.monDone ? ok(`${g.label}: a clean sweep day shows done`)
              : bad(`${g.label}: a clean sweep day shows done`);
    g.tueDone ? bad(`${g.label}: a partial day does NOT show done`)
              : ok(`${g.label}: a partial day does NOT show done`);
    g.tueShown === g.tueOwn
      ? ok(`${g.label}: the day cell counts only its own tracks`, `${g.tueShown}`)
      : bad(`${g.label}: the day cell counts only its own tracks`, `shows ${g.tueShown}, its tracks did ${g.tueOwn}`);
  }

  // Opened by keyboard, because the row is the control and had to grow its own
  // key handler — the daily card gets Enter and Space free from being a button.
  const wkHead = page.locator('.week-ep[data-ep="pressplay"] .week-ep-head');
  await wkHead.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const afterKey = await page.evaluate(() => {
    const g = document.querySelector('.week-ep[data-ep="pressplay"]');
    return {
      open: g.classList.contains('open'),
      expanded: g.querySelector('.week-ep-head').getAttribute('aria-expanded'),
      laidOut: [...g.querySelectorAll('.week-ep-track')].filter(tr => tr.getClientRects().length > 0).length,
      rule: getComputedStyle(g.querySelector('.week-ep-track td')).borderLeftWidth,
    };
  });
  afterKey.open && afterKey.expanded === 'true'
    ? ok('Enter opens a weekly EP row') : bad('Enter opens a weekly EP row', JSON.stringify(afterKey));
  afterKey.laidOut === 6 ? ok('all six tracks appear once open')
                         : bad('all six tracks appear once open', `${afterKey.laidOut} laid out`);
  afterKey.rule === '3px' ? ok('the open group is ruled down the left', afterKey.rule)
                          : bad('the open group is ruled down the left', afterKey.rule);

  await wkHead.click();
  await page.waitForTimeout(300);
  const wkClosed = await page.evaluate(() =>
    [...document.querySelectorAll('.week-ep[data-ep="pressplay"] .week-ep-track')]
      .filter(tr => tr.getClientRects().length > 0).length);
  wkClosed === 0 ? ok('clicking closes it again') : bad('clicking closes it again', `${wkClosed} still laid out`);

  // The invariant the live page broke: a row's day cells must add up to its own
  // week total. The multi-account day build summed a hand-typed list of ids
  // that stopped at `heaven`, so "new trick" and all five PRESS PLAY tracks
  // showed a dot on every day beside a real total — which reads as "nobody
  // streamed this" on the day a record came out. Driven through the real
  // aggregator rather than renderProfile, since that is where the list was.
  const agg = await page.evaluate(() => {
    const ids = SCROBBLE_TRACK_IDS;
    const perDay = () => Object.fromEntries(ids.map(id => [id, 3]));
    // TWO accounts, so the cross-account sum is exercised too, and a server
    // row that is higher for one track and lower for another, so the
    // frozen-value reconcile is as well.
    const breakdown = [
      { label: 'a', source: 'lastfm', username: 'u1', weekDayCounts: [perDay(), null, null, null, null, null, null] },
      { label: 'b', source: 'listenbrainz', username: 'u2', weekDayCounts: [perDay(), null, null, null, null, null, null] },
    ];
    const day = mergeWeekDay(breakdown, 0, null);
    const server = { [ids[0]]: 99, [ids[ids.length - 1]]: 1, by_source: { lastfm: 1 } };
    const reconciled = mergeWeekDay(breakdown, 0, server);
    return {
      day, keys: Object.keys(day).length,
      missed: ids.filter(id => day[id] !== 6),
      serverWins: reconciled[ids[0]],
      serverLoses: reconciled[ids[ids.length - 1]],
      bySourceLeaked: 'by_source' in reconciled,
    };
  });
  agg.missed.length
    ? bad('the day build covers every track', agg.missed.join(', '))
    : ok('the day build covers every track', `${agg.keys} ids, 3+3 each`);
  agg.serverWins === 99 ? ok('a higher frozen server value wins')
                        : bad('a higher frozen server value wins', `${agg.serverWins}`);
  agg.serverLoses === 6 ? ok('a lower frozen server value does not shrink the day')
                        : bad('a lower frozen server value does not shrink the day', `${agg.serverLoses}`);
  agg.bySourceLeaked ? bad('by_source is not treated as a track count')
                     : ok('by_source is not treated as a track count');

  // The weekly day cache. A day cached before a release has no key for the new
  // track, so trusting it pins that day at zero for the rest of the week — and
  // the release day is the one worth looking at.
  const cache = await page.evaluate(() => {
    const full = Object.fromEntries(SCROBBLE_TRACK_IDS.map(id => [id, 0]));
    const stale = { ...full };
    for (const k of PRESS_PLAY_KEYS) delete stale[k];   // cached before the EP
    return {
      full: weekCacheUsable(full),
      stale: weekCacheUsable(stale),
      missing: weekCacheUsable(undefined),
      zeroesAreFine: weekCacheUsable(Object.fromEntries(SCROBBLE_TRACK_IDS.map(id => [id, 0]))),
    };
  });
  cache.full ? ok('a current cached day is reused') : bad('a current cached day is reused');
  cache.stale ? bad('a day cached before a release is refetched')
              : ok('a day cached before a release is refetched');
  cache.missing ? bad('no cached day means refetch') : ok('no cached day means refetch');
  cache.zeroesAreFine ? ok('a genuine all-zero day is still cacheable')
                      : bad('a genuine all-zero day is still cacheable');

  // And the same thing end to end on the rendered table: every visible row's
  // seven day cells must sum to the total the row claims.
  const rows = await page.evaluate(() => {
    const counts = zeroTrackCounts();
    const perDay = {};
    SCROBBLE_TRACK_IDS.forEach((id, i) => { perDay[id] = i + 1; counts[id] = (i + 1) * 2; });
    const weekDays = [{ label: 'Mon', counts: perDay }, { label: 'Tue', counts: perDay },
                      ...Array.from({ length: 5 }, () => null)];
    renderProfile({
      info: { name: 't', playcount: 0, registered: { unixtime: 0 }, image: [] },
      artistPlays: 0, totalPlays: counts, todayCounts: counts, weekCounts: counts,
      weekDays, lastScrobbleTs: null, memberPlays: zeroMemberPlays(),
    });
    document.querySelectorAll('.week-ep').forEach(g => g.classList.add('open'));
    const out = [];
    for (const tr of document.querySelectorAll('#weekly-challenge-grid .weekly-table tbody tr')) {
      const tds = [...tr.querySelectorAll('td')];
      const name = tds[0].textContent.replace('▾','').trim();
      const days = tds.slice(1, 8).reduce((s, td) => {
        if (td.className === 'week-cell-future') return s;
        return s + Number(td.textContent.replace(/[^0-9]/g, '') || 0);
      }, 0);
      const total = Number(tds[8].textContent.trim().split('\n')[0].split('/')[0].replace(/[^0-9]/g,'') || 0);
      out.push({ name, days, total, isEp: tr.classList.contains('week-ep-head') });
    }
    return out;
  });
  // Only the rows whose Total cell shows a plain number can be compared; a row
  // that earned its weekly badge shows the badge there instead.
  const mismatched = rows.filter(r => r.total > 0 && r.days !== r.total);
  mismatched.length
    ? bad('every row adds up to its own total',
          mismatched.map(r => `${r.name}: days ${r.days} vs total ${r.total}`).join('; '))
    : ok('every row adds up to its own total', `${rows.length} rows checked`);
  const allDots = rows.filter(r => r.days === 0 && r.total > 0).map(r => r.name);
  allDots.length ? bad('no row shows a week of dots beside a real total', allDots.join(', '))
                 : ok('no row shows a week of dots beside a real total');

  if (errs.length) { console.log('    page errors: ' + errs.slice(0,4).join(' | ')); fails += errs.length; }
  await page.close();
}

await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
