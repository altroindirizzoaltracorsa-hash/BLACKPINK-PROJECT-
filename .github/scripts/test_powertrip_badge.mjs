// The Day One badge is earned on release day ANYWHERE, and nowhere else.
//
// Run: node .github/scripts/test_powertrip_badge.mjs
//
// WHY THE WINDOW IS 50 HOURS AND NOT 24. "Power Trip" lands at midnight in
// each country, so release day opens in the first timezone long before it
// opens in the last, and it is still Nov 20 in the last one for most of a day
// after the first has moved on. A "day one" badge that ran 24 hours from any
// single instant would shut out most of the planet's actual day one.
//
//   OPENS  2026-11-19T10:00:00Z — midnight Nov 20 at UTC+14, Kiribati's Line
//          Islands. NOT New Zealand: it is UTC+13 in November, on daylight
//          saving, so it is second by an hour. That is the kind of detail
//          that gets assumed rather than checked, so it is checked here.
//   CLOSES 2026-11-21T12:00:00Z — midnight Nov 21 at UTC-12, the last place
//          on Earth still inside Nov 20.
//
// Both ends are computed from the offsets below rather than copied from the
// source, so a typo in either constant fails rather than being ratified.
//
// AND THE CLOSE MATTERS AS MUCH AS THE OPEN. Every badge on this site that
// shipped without a closing gate — ADDICTED, new trick — handed "Early
// Supporter" to anyone who tapped the link weeks later, which devalues it for
// everybody who was actually there. A day-one badge with no end is just a
// badge.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from './_playwright.mjs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const src = readFileSync(root + 'index.html', 'utf8');
const constOf = (name) => (src.match(new RegExp(`const ${name}\\s*=\\s*'([^']+)'`)) || [])[1];

console.log('--- the window is release day, everywhere on Earth');
{
  const from  = constOf('PT_BADGE_FROM');
  const until = constOf('PT_BADGE_UNTIL');
  check(!!from && !!until, 'both ends are defined', `${from} → ${until}`);
  // Midnight Nov 20 at UTC+14 == Nov 19 10:00 UTC. Computed, not copied.
  const wantFrom  = new Date(Date.UTC(2026, 10, 20, 0, 0, 0) - 14 * 3600000).toISOString();
  const wantUntil = new Date(Date.UTC(2026, 10, 21, 0, 0, 0) + 12 * 3600000).toISOString();
  check(new Date(from).toISOString()  === wantFrom,
        'it opens at midnight Nov 20 in the FIRST timezone (UTC+14, Kiritimati)', `${from} vs ${wantFrom}`);
  check(new Date(until).toISOString() === wantUntil,
        'it closes at midnight Nov 21 in the LAST timezone (UTC-12)', `${until} vs ${wantUntil}`);
  const hours = (new Date(until) - new Date(from)) / 3600000;
  check(hours === 50, 'which is 50 hours, not 24', `${hours}h`);
  // The specific wrong answer this is guarding: New Zealand is on daylight
  // saving in November, so it is UTC+13 and an hour LATE.
  const nz = new Date(Date.UTC(2026, 10, 20, 0, 0, 0) - 13 * 3600000).toISOString();
  check(new Date(from).toISOString() !== nz,
        '  and not New Zealand\'s midnight, which is an hour later', `NZ would be ${nz}`);
}

// ── and the gate really gates, in a real browser ────────────────────────────
const SPA = /^\/(countdowns|voting|vote|streams|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  if (p.startsWith('/api/')) { res.writeHead(404); res.end(''); return; }
  const file = SPA.test(p) || p === '/' ? '/index.html' : p;
  try {
    const b = readFileSync(root + file.slice(1));
    const ext = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }[ext]
      || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise(r => server.listen(0, r));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();

const at = async (iso, label) => {
  // SERVICE WORKERS BLOCKED. In a fresh context sw.js installs, calls
  // clients.claim(), and index.html's `controllerchange` handler reloads the
  // page ONCE on purpose so the build swaps instead of running stale cached
  // JS. That reload can land between the waitForFunction below and the
  // evaluate after it, and kills the context mid-read: "Execution context was
  // destroyed, most likely because of a navigation" — a message with nothing
  // in it to connect it to a service worker, and which looks like a broken
  // badge gate rather than the transient it is.
  //
  // It passed here for weeks and started failing in CI the day the card grew
  // a playlists block and a premiere row: more markup, later parse, wider
  // window. So the race was always present and the page size only changed how
  // often it is lost — which is why this is fixed rather than re-run. Nothing
  // in this file tests the service worker.
  //
  // Reproduced before fixing, since the CI log was not retrievable: eight
  // copies in parallel, to widen the window the way a loaded runner does,
  // failed 2 of 8 with that exact error. Same command passes 8 of 8 with this
  // option set.
  const ctx = await browser.newContext({ viewport: { width: 430, height: 950 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(iso));
  await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
  await page.goto(base + '/countdowns/powertrip', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof savePowerTrip === 'function', { timeout: 20000 });
  const got = await page.evaluate(() => {
    try { localStorage.removeItem('bu_jennie_powertrip_saved'); } catch (e) {}
    const open = ptBadgeOpen();
    savePowerTrip();
    return { open, earned: !!localStorage.getItem('bu_jennie_powertrip_saved') };
  });
  await ctx.close();
  return got;
};

// The same gate, reached by TAPPING A PLAYLIST rather than the album button.
// Every pill on this card grants the badge now, because a fan in a timezone
// where the song is already out is as likely to open a playlist as the album.
//
// It also checks the pre-save COUNTER is not touched by a playlist tap. The
// badge and the count used to be one function, and wiring the pills to it
// would have filed every playlist tap in bu_jennie_powertrip_saves as a
// pre-save — a number that is supposed to mean one thing quietly meaning two.
const viaPlaylist = async (iso) => {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 950 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(iso));
  await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
  await page.goto(base + '/countdowns/powertrip', { waitUntil: 'load' });
  const got = await (await page.waitForFunction(() => {
    try { if (typeof grantPowerTripDayOne !== 'function') return null; } catch { return null; }
    const pills = [...document.querySelectorAll('.cd-card-powertrip .cd-pl-pill')];
    if (!pills.length) return null;
    try { localStorage.removeItem('bu_jennie_powertrip_saved');
          localStorage.removeItem('bu_jennie_powertrip_counted'); } catch (e) {}
    // A real click on a real pill, not a direct call: the wiring is the thing
    // under test, so calling the function by name would pass with no onclick
    // on any of them.
    pills[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return {
      open:    ptBadgeOpen(),
      earned:  !!localStorage.getItem('bu_jennie_powertrip_saved'),
      counted: !!localStorage.getItem('bu_jennie_powertrip_counted'),
      pills:   pills.length,
      wired:   pills.filter(p => (p.getAttribute('onclick') || '').includes('grantPowerTripDayOne')).length,
    };
  }, null, { timeout: 25000 })).jsonValue();
  await ctx.close();
  return got;
};

// The one CTA, rendered: what it says, where it points, and what tapping it
// does. Read from the live page because the swap lives in renderPtCta().
const ctaAt = async (iso) => {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 950 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(iso));
  await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
  await page.goto(base + '/countdowns/powertrip', { waitUntil: 'load' });
  const got = await (await page.waitForFunction(() => {
    const note = document.getElementById('pt-pl-note');
    if (!note || !note.textContent.trim()) return null;   // the load path has run
    const a = document.getElementById('pt-cta');
    if (!a) return null;
    try { localStorage.removeItem('bu_jennie_powertrip_saved');
          localStorage.removeItem('bu_jennie_powertrip_counted'); } catch (e) {}
    savePowerTrip();
    return {
      live:    ptLive(),
      label:   a.textContent.trim(),
      href:    a.getAttribute('href') || '',
      earned:  !!localStorage.getItem('bu_jennie_powertrip_saved'),
      counted: !!localStorage.getItem('bu_jennie_powertrip_counted'),
    };
  }, null, { timeout: 25000 })).jsonValue();
  await ctx.close();
  return got;
};

console.log('\n--- and a playlist tap earns it too, on the same gate');
{
  let r = await viaPlaylist('2026-11-19T22:00:00Z');
  check(r.pills > 0 && r.wired === r.pills,
        'every playlist on the card grants the badge', `${r.wired}/${r.pills} wired`);
  check(r.open && r.earned, '  opening a playlist inside the window earns it');
  check(!r.counted,
        '  and does NOT file the tap as a pre-save', 'bu_jennie_powertrip_counted stayed unset');
  r = await viaPlaylist('2026-11-19T09:00:00Z');
  check(!r.open && !r.earned, '  an hour before the window opens: nothing');
  r = await viaPlaylist('2026-11-22T12:00:00Z');
  check(!r.open && !r.earned, '  after it has closed everywhere: nothing');

  // THE ONE BUTTON SWAPS WHERE IT GOES at the reader's own midnight: the
  // album pre-save before, the song itself after. Spotify will not serve the
  // track to a listener whose Nov 20 has not arrived, so pointing at it any
  // earlier is a dead button on a card they trusted; and once the song is out
  // the pre-save is pointless and the song is what they came for.
  //
  // Rendered on both sides, not read off the markup: the swap lives in
  // renderPtCta(), so the source only ever shows the pre-release state.
  const before = await ctaAt('2026-11-19T22:00:00Z');  // badge open, Rome still Nov 19
  const after  = await ctaAt('2026-11-20T12:00:00Z');  // out almost everywhere
  check(before.live === false && after.live === true,
        '  the two samples straddle the reader\'s own midnight', `${before.live} -> ${after.live}`);
  check(/pre-save/i.test(before.label) && before.href.includes('/album/'),
        '  before it: a pre-save, pointing at the ALBUM', `${before.label} -> ${before.href}`);
  check(!/pre-save/i.test(after.label) && after.href.includes('/track/1cyE4XiRueT0ANCp3CuJOK'),
        '  after it: the SONG, and no longer called a pre-save', `${after.label} -> ${after.href}`);
  check(!/[?&]si=/.test(before.href) && !/[?&]si=/.test(after.href),
        '  neither carries a share-tracking parameter');
  // The badge is the same badge from either side — it is a day-one badge, not
  // a pre-save badge, so it must keep granting after the song is out.
  check(before.earned && after.earned, '  and the button earns the badge on both sides',
        `${before.earned} / ${after.earned}`);
  // But the PRE-SAVE COUNT must stop once it is no longer a pre-save.
  check(before.counted && !after.counted,
        '  while the pre-save count stops when it stops being a pre-save',
        `counted before=${before.counted} after=${after.counted}`);
}

console.log('\n--- the gate opens and closes on those instants');
{
  // An hour before the first midnight anywhere.
  let r = await at('2026-11-19T09:00:00Z');
  check(!r.open && !r.earned, 'an hour before the first country reaches Nov 20: no badge');
  // One minute after it opens.
  r = await at('2026-11-19T10:01:00Z');
  check(r.open && r.earned, 'a minute after Kiritimati turns over: earned');
  // Mid-window, when most of the world is in Nov 20.
  r = await at('2026-11-20T12:00:00Z');
  check(r.open && r.earned, 'midway through the world\'s release day: earned');
  // One minute before the last country leaves Nov 20.
  r = await at('2026-11-21T11:59:00Z');
  check(r.open && r.earned, 'a minute before the last timezone leaves Nov 20: still earned');
  // And after.
  r = await at('2026-11-21T12:01:00Z');
  check(!r.open && !r.earned, 'a minute after Nov 20 has ended everywhere: no badge');
  // Weeks later, which is the failure ADDICTED and new trick both shipped.
  r = await at('2026-12-15T12:00:00Z');
  check(!r.open && !r.earned, 'and not three weeks later, which is how the old badges leaked');
}

await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
