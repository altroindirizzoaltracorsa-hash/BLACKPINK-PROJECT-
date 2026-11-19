// The five Power Trip playlists are the ones that were asked for, they are
// labelled honestly, and the note under them tells the truth on both sides of
// the release.
//
// Run: node .github/scripts/test_powertrip_playlists.mjs
//
// WHY A TEST FOR FIVE LINKS. A playlist id is 22 base62 characters and one
// wrong character is a dead link on a card thousands of people tap — silently,
// because Spotify answers a bad id with its own "couldn't find that" page
// rather than an error anyone here would see. These five were read out of the
// account by API for exactly that reason; this pins what was read.
//
// AND WHY THE NOTE IS CHECKED IN A BROWSER. It is deliberately NOT in the
// markup: it has to switch at the release instant, and the three cards that
// wrote their note into the HTML all went stale — PRESS PLAY's still reads
// "they fill up when PRESS PLAY lands" two weeks after it landed. A note that
// is empty in the source is right only if a script fills it, so the only
// meaningful check is the rendered one, on both sides of the instant.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from './_playwright.mjs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const src = readFileSync(root + 'index.html', 'utf8');

// The three that are this song's own, then the two that span the other drops.
// Order matters: it is the order on the card and therefore the order in the
// shared post, and the cross-release pair belongs last in both.
const WANT = [
  ['POWER TRIP Focused',     '6itTleOIire70BDaVOLf50'],
  ['POWER TRIP x PINKS',     '4FMIAhP7tdzV7xgZbwsSCe'],
  ['POWER TRIP x BP',        '2QI45Deh6MrFuUKR2E6Rlu'],
  ['JENSOO RELEASE DAY',     '75Pc4jtAlQsKaQyBUtWpnJ'],
  ['LWM x PT x SS Focused',  '0PqV4NjZKG0Q3DKi2AkgJ3'],
];

// ── the card itself ─────────────────────────────────────────────────────────
// Bounded by brace depth, not by the next `</div>`: the share button sits
// after the pill list, so a bound that stopped at the first closing tag used
// to match nothing and report the playlists missing when they were right
// there. (Same lesson as test_presave_wiring's.)
const card = (() => {
  const open = src.indexOf('<div class="cd-card cd-card-powertrip"');
  if (open < 0) return '';
  let depth = 0;
  const tag = /<div\b[^>]*>|<\/div>/g;
  tag.lastIndex = open;
  for (let m; (m = tag.exec(src)); ) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return src.slice(open, m.index + m[0].length);
  }
  return '';
})();

console.log('--- the card lists them');
check(!!card, 'the Power Trip card is there to read');
check(card.includes('<div class="cd-pl-pills">'),
      'and carries the playlists block, open rather than behind a <summary>');

// The label sits after an inline Spotify glyph, so the visible text is what is
// left once tags are stripped — reading up to the first '<' would measure the
// <svg> and every name would come back empty.
const links = [...card.matchAll(/<a class="cd-pl-pill" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map((m) => [m[2].replace(/<[^>]*>/g, '').trim(), m[1]]);

check(links.length === WANT.length, `${WANT.length} playlists listed`,
      `${links.length}: ${links.map((l) => l[0]).join(', ')}`);
WANT.forEach(([name, id], i) => {
  const got = links[i] || [];
  check(got[0] === name && got[1] === `https://open.spotify.com/playlist/${id}`,
        `  ${i + 1}. ${name}`, got[0] ? `got ${got[0]} → ${got[1]}` : 'missing');
});

// A typo in an id is the failure this whole file exists for, and it does not
// look like one: 22 base62 characters all look alike. So the shape is checked
// too, which catches a truncated or pasted-over id even if the table above is
// edited to match it.
const shapeBad = WANT.filter(([, id]) => !/^[0-9A-Za-z]{22}$/.test(id));
check(!shapeBad.length, '  every id is 22 base62 characters',
      shapeBad.map(([n, id]) => `${n}: ${id} (${id.length})`).join('; '));

// Five distinct playlists. A duplicate here means a copy-paste that stopped
// halfway, which reads perfectly on the card and sends two pills to one place.
const ids = WANT.map(([, id]) => id);
check(new Set(ids).size === ids.length, '  and no id appears twice');

// And none of them is a link lifted from another card, which is the other
// shape of that same slip.
const elsewhere = ids.filter((id) => {
  const outside = src.split(card).join('');
  return outside.includes(id);
});
check(!elsewhere.length, '  nor borrowed from another card’s list', elsewhere.join(' '));

// ?si= identifies whoever copied the link and would be handed to every visitor
// alike. Every other playlist list on the site is stripped of it.
const si = (card.match(/open\.spotify\.com\/playlist\/[^"]*[?&]si=[^"]*/g) || []);
check(!si.length, '  and none carries a share-tracking parameter', si.join(' '));

console.log('\n--- the two that are not only this song are SAID to be');
// Three of the five are Power Trip's own; "JENSOO RELEASE DAY" is the whole of
// Nov 20 and "LWM x PT x SS" also carries LISA's single. Listing those two
// unlabelled among the others promises a fan a Power Trip playlist and hands
// them a mixed one — a small broken promise, but on the card they tapped.
const divider = card.indexOf('class="pt-pl-also"');
check(divider > 0, 'there is a divider before the cross-release pair');
if (divider > 0) {
  const third  = card.indexOf(WANT[2][1]);
  const fourth = card.indexOf(WANT[3][1]);
  check(third < divider && divider < fourth,
        '  and it sits between the third and the fourth, not anywhere else');
}

console.log('\n--- the note is not written into the markup');
// This is the check that keeps it honest. If someone "simplifies" the empty <p>
// into a sentence, the card starts lying the moment the song is out.
const noteEl = card.match(/<p class="cd-pl-note" id="pt-pl-note">([\s\S]*?)<\/p>/);
check(!!noteEl, 'the note is an empty #pt-pl-note, filled by script');
check(noteEl && noteEl[1].trim() === '',
      '  and nothing is hardcoded inside it', noteEl ? noteEl[1].trim() : 'no element');

// ── rendered, in a real browser, on both sides of the release ───────────────
const SPA = /^\/(countdowns|voting|vote|streams|badges|leaderboard|account|feedback)(\/|$)/;
const server = createServer((req, res) => {
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

const at = async (iso) => {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 950 } });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(iso));
  await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });
  await page.goto(base + '/countdowns/powertrip', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof renderPtPlaylistNote === 'function', { timeout: 20000 });
  const got = await page.evaluate(() => {
    renderPtPlaylistNote();
    const pills = [...document.querySelectorAll('.cd-card-powertrip .cd-pl-pill')];
    return {
      live:  ptLive(),
      note:  document.getElementById('pt-pl-note')?.textContent.trim() || '',
      // Visible without opening anything — the whole point of the block being
      // open on the card. A pill inside a closed <details> has height 0.
      shown: pills.filter((p) => p.getBoundingClientRect().height > 0).length,
      post:  typeof _ptPlaylistPost === 'function' ? _ptPlaylistPost() : null,
    };
  });
  await ctx.close();
  return got;
};

// An hour before the first midnight anywhere, and a day after the last.
const before = await at('2026-11-19T09:00:00Z');
const after  = await at('2026-11-22T12:00:00Z');

console.log('\n--- and it says the right thing, rendered, on each side');
check(before.live === false && after.live === true,
      'the two samples really do straddle the release', `${before.live} → ${after.live}`);
check(before.shown === WANT.length, `all ${WANT.length} pills are visible without opening anything`,
      `${before.shown} of ${WANT.length}`);
check(/pre-save/i.test(before.note), 'before: it asks for a pre-save', before.note);
check(/is out/i.test(after.note) && !/pre-save/i.test(after.note),
      'after: it says the song is out, and stops asking for a pre-save', after.note);

console.log('\n--- the shared post carries all five, off the card');
// Read off the DOM rather than from a second list in the source: a second copy
// of five URLs is a second place to edit, and the one that gets forgotten is
// the post, which is the half that travels.
const missing = WANT.filter(([, id]) => !(before.post || '').includes(id));
check(before.post && !missing.length, 'every playlist is in the post',
      missing.map(([n]) => n).join(', '));
check(/pre-save these/i.test(before.post || ''), '  before the release it asks for pre-saves');
check(/is out/i.test(after.post || '') && !/pre-save/i.test(after.post || ''),
      '  after it does not', (after.post || '').split('\n')[1]);
check((before.post || '').includes('/countdowns/powertrip'),
      '  and it links back to the card');

await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
