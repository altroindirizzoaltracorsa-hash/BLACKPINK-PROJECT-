// Every track in TRACKS is wired all the way through, in a real browser.
//
// Run: node .github/scripts/test_track_wiring.mjs
//
// A release reaches the page through about ten separate lists: TRACKS, the two
// tier tables, the zeroed counts objects, the scrobble matchers, the score
// payload. Adding a song to some of them and not the rest throws nothing and
// logs nothing — the card renders with `undefined` plays, or the per-track
// board reads empty because the payload had no field to carry the number, so
// the server stored a zero. That is exactly how the PRESS PLAY EP shipped:
// into the server's track list, the tier tables and the leaderboard, and into
// none of index.html's own twenty-two hand-typed `{ jump: 0, … }` literals.
//
// So this does not check the EP. It checks that no track CAN be half-wired,
// which is the only version of the check that still works for the next one.
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
const page=await browser.newPage({viewport:{width:430,height:950}});
await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
  localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.8','1');}catch(e){}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
let fails=0;
const ok=(m,d)=>console.log(`  ok   ${m}${d?` (${d})`:''}`);
const bad=(m,d)=>{fails++;console.log(`  FAIL ${m}${d?` (${d})`:''}`);};
await page.goto(base+'/badges',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(3000);

const R = await page.evaluate(() => {
  const ids = TRACKS.map(t => t.id);
  const zero = zeroTrackCounts();
  return {
    ids,
    titles: Object.fromEntries(TRACKS.map(t => [t.id, t.title])),
    // Every id has a slot in a fresh counts object. Without one the count is
    // `undefined`, which renders as "undefined" or NaN rather than 0.
    missingFromZero: ids.filter(id => zero[id] !== 0),
    zeroExtras: Object.keys(zero).filter(k => !ids.includes(k)),
    // Both tier tables. A card with no tiers can never earn a badge and shows
    // "No badge yet" for ever, which looks like the reader not streaming.
    missingDaily: ids.filter(id => !(DAILY_TIERS[id] || []).length),
    missingWeekly: ids.filter(id => !(WEEKLY_TIERS[id] || []).length),
    // PRESS PLAY's matcher branch is `PRESS_PLAY_KEYS.includes(k)` indexing
    // `counts[k]`, so for those five the normalized title MUST equal the id or
    // the play lands on a key nothing reads. Two older tracks are deliberate
    // aliases with their own branches (ddududu <- ddududdudu, ltal <-
    // lessthanalover); the per-listen check below covers those properly.
    keyMismatch: TRACKS.filter(t => PRESS_PLAY_KEYS.includes(t.id) && _trackKey(t.track) !== t.id)
                       .map(t => `${t.id} <- ${_trackKey(t.track)}`),
    aliases: TRACKS.filter(t => _trackKey(t.track) !== t.id)
                   .map(t => `${t.id} <- ${_trackKey(t.track)}`),
    // SCROBBLE_TRACK_IDS must BE the TRACKS ids: it is what every counts
    // object, loop and payload is now built from.
    scrobbleIdsAgree: JSON.stringify(SCROBBLE_TRACK_IDS) === JSON.stringify(ids),
    // EP_RELEASES is now the one membership list the leaderboard's tab rows
    // and My Badges' collapsible cards both read. A song id that is not a real
    // track silently drops out of both.
    epGhosts: EP_RELEASES.flatMap(g => g.songs.filter(id => !ids.includes(id)).map(id => `${g.key}:${id}`)),
    epOverlap: (() => {
      const seen = new Set(), dup = [];
      for (const g of EP_RELEASES) for (const id of g.songs) {
        if (seen.has(id)) dup.push(id); else seen.add(id);
      }
      return dup;
    })(),
  };
});

console.log(`    ${R.ids.length} tracks: ${R.ids.join(', ')}`);
R.scrobbleIdsAgree ? ok('SCROBBLE_TRACK_IDS is TRACKS') : bad('SCROBBLE_TRACK_IDS is TRACKS');
R.epGhosts.length ? bad('every EP song is a real track', R.epGhosts.join(', '))
                  : ok('every EP song is a real track');
R.epOverlap.length ? bad('no track is on two EPs', R.epOverlap.join(', '))
                   : ok('no track is on two EPs');
R.missingFromZero.length ? bad('every track has a counts slot', R.missingFromZero.join(', '))
                         : ok('every track has a counts slot');
R.zeroExtras.length ? bad('no counts slot without a track', R.zeroExtras.join(', '))
                    : ok('no counts slot without a track');
R.missingDaily.length ? bad('every track has daily tiers', R.missingDaily.join(', '))
                      : ok('every track has daily tiers');
R.missingWeekly.length ? bad('every track has weekly tiers', R.missingWeekly.join(', '))
                       : ok('every track has weekly tiers');
console.log(`    title aliases (own branches): ${R.aliases.join('; ') || 'none'}`);
R.keyMismatch.length ? bad('each PRESS PLAY title normalizes to its id', R.keyMismatch.join('; '))
                     : ok('each PRESS PLAY title normalizes to its id');

// The scrobble matchers, driven through countLbByTrack with a synthesised
// listen per track. Checking the function rather than the branch text, so a
// matcher that looks right and counts onto the wrong id still fails.
const matched = await page.evaluate(() => {
  const out = {};
  for (const t of TRACKS) {
    const c = countLbByTrack([{ track_metadata: { track_name: t.track, artist_name: t.artist } }]);
    out[t.id] = c[t.id];
  }
  return out;
});
const unmatched = Object.entries(matched).filter(([, v]) => v !== 1).map(([k, v]) => `${k}=${v}`);
unmatched.length ? bad('one listen counts onto its own track', unmatched.join(', '))
                 : ok('one listen counts onto its own track');

// The score payload, read out of the `const scores = { … }` literal itself by
// brace-matching rather than by scanning the file. Scanning the file passed
// with the whole daily spread deleted, because `daily_v12` also appears in the
// leaderboard's own sum a hundred lines away — a check that cannot fail is
// worse than no check, so this one is scoped to the object that gets posted.
const html = await readFile(ROOT + '/index.html', 'utf8');
const ppKeys = await page.evaluate(() => PRESS_PLAY_KEYS);
const trackIds = R.ids;
const lit = (() => {
  const at = html.indexOf('const scores = {');
  if (at < 0) return null;
  let i = html.indexOf('{', at), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) return html.slice(i, j + 1);
  }
  return null;
})();
if (!lit) {
  bad('the scores literal was found');
} else {
  ok('the scores literal was found', `${lit.length} bytes`);
  const fields = new Set();
  for (const m of lit.matchAll(/\b(overall|daily|weekly)_([a-z0-9]+)\s*:/g)) fields.add(`${m[1]}_${m[2]}`);
  // Computed spreads post a field per PRESS_PLAY_KEYS entry.
  for (const m of lit.matchAll(/PRESS_PLAY_KEYS\.map\(k => \[`(overall|daily|weekly)_\$\{k\}`/g))
    for (const k of ppKeys) fields.add(`${m[1]}_${k}`);
  const missingFields = [];
  for (const id of trackIds) for (const pre of ['overall', 'daily', 'weekly'])
    if (!fields.has(`${pre}_${id}`)) missingFields.push(`${pre}_${id}`);
  missingFields.length ? bad('every track is in the posted scores', missingFields.join(', '))
                       : ok('every track is in the posted scores', `${fields.size} fields`);
}

// And the thing the reader actually complained about: the cards on screen.
// Driven by calling the real renderer with synthesised counts, because signed
// out the grid never renders — and a check that skips itself is how a missing
// card ships.
const cards = await page.evaluate(() => {
  const counts = zeroTrackCounts();
  for (const id of SCROBBLE_TRACK_IDS) counts[id] = 7;
  renderProfile({
    info: { name: 'test', playcount: 0, registered: { unixtime: 0 }, image: [] },
    artistPlays: 0, totalPlays: counts, todayCounts: counts, weekCounts: counts,
    weekDays: [], lastScrobbleTs: null, memberPlays: zeroMemberPlays(),
  });
  const g = document.getElementById('daily-challenge-grid');
  return {
    names: [...(g?.querySelectorAll('.daily-song-name') || [])].map(e => e.textContent.trim()),
    // A card showing undefined/NaN is the half-wired failure rendered.
    counts: [...(g?.querySelectorAll('.daily-count') || [])].map(e => e.textContent.trim()),
  };
});
console.log(`    grid: ${cards.names.join(' · ')}`);
const want = ['V12', 'COBRA', 'TARANTINO', 'CUT U OFF', 'SWEAT'];
const absent = want.filter(w => !cards.names.includes(w));
absent.length ? bad('the PRESS PLAY cards are in the daily grid', absent.join(', '))
              : ok('the PRESS PLAY cards are in the daily grid');
const broken = cards.counts.filter(c => !/^\d+$/.test(c));
broken.length ? bad('every card shows a number', broken.join(', '))
              : ok('every card shows a number');

if (errs.length) { console.log('    page errors: ' + errs.slice(0, 4).join(' | ')); fails += errs.length; }
await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
