// ADDICTED goes out at one instant, and the site has five copies of it.
//
// Run: node .github/scripts/test_addicted_release_time.mjs
//
// The countdown was set to 2026-10-30T04:00:00Z — 1PM KST, the hour JISOO's
// CLICK and the other singles used. The official timetable says 8AM KST on
// Oct 30, which is 2026-10-29T23:00:00Z. Five hours earlier. The countdown
// would have sat there showing time remaining while the song was already out,
// and the existing test asserted the wrong value, so it PROTECTED the bug
// rather than catching it.
//
// So this does not assert a timestamp someone typed. It derives the instant
// from the published timetable — every city on the poster, rendered in its own
// zone and compared against what the poster prints — and then checks that each
// copy in the site agrees with it. Getting the release time wrong now requires
// the poster to be wrong too.
//
// Five copies, because there are five: the card's data-target, the "release
// times worldwide" block, the human sub-line, ADDICTED_RELEASE_AT (which hides
// the pre-save block and stamps the share card), and the share card's own
// dateLine. They are separate on purpose — different parts of the page — and
// nothing but this check keeps them in step.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// The TIMETABLE poster, transcribed. City, IANA zone, and the local time it
// prints. This is the source of truth; everything else is derived.
const POSTER = [
  ['Los Angeles', 'America/Los_Angeles', 'Oct 29 @ 4:00 PM'],
  ['Mexico City', 'America/Mexico_City', 'Oct 29 @ 5:00 PM'],
  ['New York',    'America/New_York',    'Oct 29 @ 7:00 PM'],
  ['São Paulo',   'America/Sao_Paulo',   'Oct 29 @ 8:00 PM'],
  ['Auckland',    'Pacific/Auckland',    'Oct 30 @ 12:00 PM'],
  ['Beijing',     'Asia/Shanghai',       'Oct 30 @ 7:00 AM'],
  ['Sydney',      'Australia/Sydney',    'Oct 30 @ 10:00 AM'],
  ['Bangkok',     'Asia/Bangkok',        'Oct 30 @ 6:00 AM'],
  ['London',      'Europe/London',       'Oct 29 @ 11:00 PM'],
  ['Manila',      'Asia/Manila',         'Oct 30 @ 7:00 AM'],
  ['Mumbai',      'Asia/Kolkata',        'Oct 30 @ 4:30 AM'],
  ['Paris',       'Europe/Paris',        'Oct 30 @ 12:00 AM'],
  ['Seoul',       'Asia/Seoul',          'Oct 30 @ 8:00 AM'],
  ['Tokyo',       'Asia/Tokyo',          'Oct 30 @ 8:00 AM'],
];

const RELEASE = '2026-10-29T23:00:00Z';

const render = (iso, tz) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(iso));
  const g = t => (parts.find(p => p.type === t) || {}).value;
  return `${g('month')} ${g('day')} @ ${g('hour')}:${g('minute')} ${g('dayPeriod')}`;
};

console.log(`--- ${RELEASE} is the instant the poster describes`);
// All fourteen, not a sample. A release time that satisfies thirteen cities and
// not the fourteenth is the wrong release time, and a transcription slip in
// this very file would otherwise read as agreement.
for (const [city, tz, printed] of POSTER) {
  const got = render(RELEASE, tz);
  check(got === printed, `${city} reads ${printed}`, got === printed ? '' : `got ${got}`);
}

console.log('\n--- and no other hour does');
// Guards against the file being "fixed" by moving both the poster and the code
// together. The old value has to be refuted explicitly.
for (const wrong of ['2026-10-30T04:00:00Z', '2026-10-29T22:00:00Z', '2026-10-30T00:00:00Z']) {
  const agree = POSTER.filter(([, tz, printed]) => render(wrong, tz) === printed).length;
  check(agree === 0, `${wrong} matches no city`, `${agree}/${POSTER.length}`);
}

console.log('\n--- every copy in the site agrees');
{
  const page = readFileSync(root + 'index.html', 'utf8');
  const card = page.match(/<div class="cd-card cd-card-addicted"[\s\S]*?(?=<div class="cd-card )/);
  check(!!card, 'found the ADDICTED card');
  const block = card ? card[0] : '';

  check(block.includes(`data-target="${RELEASE}"`), 'the countdown counts to it',
        (block.match(/data-target="([^"]+)"/) || [])[1]);
  check(block.includes(`data-times-for="${RELEASE}"`), '"release times worldwide" is built from it',
        (block.match(/data-times-for="([^"]+)"/) || [])[1]);

  const relAt = (page.match(/const ADDICTED_RELEASE_AT = '([^']+)'/) || [])[1];
  check(relAt === RELEASE, 'ADDICTED_RELEASE_AT agrees', relAt);

  // The two human-readable lines. Checked for the correct hour AND against the
  // old one, because a stale "1PM KST" beside a corrected countdown is its own
  // bug — the page would be telling the reader two different times.
  const sub = (block.match(/<div class="cd-sub">([^<]*)</) || [])[1] || '';
  check(/8AM KST/.test(sub) && !/1PM KST|12AM EDT/.test(sub),
        'the card\'s sub-line names the real hour', sub.trim());
  const dateLine = (page.match(/dateLine: 'Out Oct 30, 2026[^']*'/) || [])[0] || '';
  check(/8AM KST/.test(dateLine) && !/1PM KST|12AM EDT/.test(dateLine),
        'the share card\'s date line names the real hour', dateLine);
}

console.log('\n--- the assets, where each one belongs');
{
  const page = readFileSync(root + 'index.html', 'utf8');
  for (const f of ['/strips/addicted-1.webp', '/strips/addicted-2.jpg', '/strips/addicted-3.jpg']) {
    check(readFileSync(root + f.slice(1)).length > 1000, `${f} exists in the repo`);
  }

  const card = (page.match(/<div class="cd-card cd-card-addicted"[\s\S]*?(?=<div class="cd-card )/) || [''])[0];
  const strip = (card.match(/<div class="cd-strip[\s\S]*?<\/div>/) || [''])[0];
  const inCarousel = f => strip.includes(f);
  // The key visual already carries the ADDICTED lockup, which the card renders
  // two inches above the strip — in the carousel it read as the same artwork
  // twice. It belongs to the share card, where it IS the picture.
  check(inCarousel('/strips/addicted-1.webp'), 'the portrait is in the carousel');
  // The timetable is not a photograph and never belonged beside one — it is
  // the release times, so it sits in "Release times worldwide" above the list
  // that renders the same instant in the reader's own clock. Keeping it out of
  // the strip is also what lets the strip take the portrait's 3:4 shape.
  check(!inCarousel('/strips/addicted-3.jpg'), 'the timetable is NOT in the carousel');
  check(/<a class="ad-timetable"[\s\S]*?addicted-3\.jpg/.test(card), 'it is in the release-times section');
  check(!inCarousel('/strips/addicted-2.jpg'), 'the key visual is NOT in the carousel');

  const pics = page.match(/const ADDICTED_CARD_PICS = \[([\s\S]*?)\];/);
  check(!!pics, 'the share-card picker has a picture list');
  if (pics) {
    check(pics[1].includes('/strips/addicted-2.jpg'), 'but it IS a share-card background');
    const rows = pics[1].split('\n').filter(l => l.includes('url:'));
    check(rows.length >= 2, `the picker offers ${rows.length} backgrounds`);
    // A picture added without the flag would be drawn under a second copy of
    // the wordmark.
    check(rows.every(l => /hasLockup:\s*(true|false)/.test(l)),
          'and every one declares hasLockup',
          rows.filter(l => !/hasLockup:/.test(l)).join(' / '));
  }
}

console.log('\n--- the MV is linked, not embedded');
// Three platforms of audio snippet became one teaser, and now the teaser has
// become the MV — one YouTube video each time, so one link and no chooser.
//
// The rule it inherits is the one the snippet was built on, and it is the same
// rule for the same reason: a player that cannot start on its own is a player
// sitting there looking broken. Browsers refuse audio before a gesture, so
// anything autoplaying would have to be muted, which is no use for a video.
{
  const page = readFileSync(root + 'index.html', 'utf8');
  const card = (page.match(/<div class="cd-card cd-card-addicted"[\s\S]*?(?=<div class="cd-card )/) || [''])[0];
  const block = (card.match(/<div class="ad-snippet">[\s\S]*?<\/div>/) || [''])[0];
  check(!!block, 'the card has a video block');
  // The teaser is SUPERSEDED, not kept beside the MV. Offering both asks a
  // reader to choose between a trailer and the film, and the trailer is the
  // one that stops being the point the moment the film exists. Named by id
  // because that is what a well-meant "put the teaser back" would restore.
  check(!card.includes('ZKupyV0lgqg'),
        'and the pre-release teaser is no longer linked from it');

  const hrefs = [...block.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
  check(hrefs.length === 1, `it has ${hrefs.length} link(s), not a chooser`, hrefs.join(' '));
  check(hrefs.some(h => /youtu\.?be(\.com)?\//.test(h)), 'and it goes to YouTube', hrefs.join(' '));
  check(!/ytm-card|ytmPlay|i\.ytimg\.com|youtube(-nocookie)?\.com\/embed/.test(card),
        'and nothing on the card embeds or previews it');

  // Share-tracking tokens are stripped before a link goes on a public page.
  // ?is= on YouTube and ?obrf= on Instagram identify whoever copied the link,
  // do nothing for the video, and would be handed to every visitor alike. The
  // teaser URL arrived carrying ?is=jIZqHwTnEbAt5bbO.
  check(!hrefs.some(h => /[?&](obrf|is|si|_r|_t)=/.test(h)),
        'and carries no share-tracking parameter',
        hrefs.filter(h => /[?&](obrf|is|si|_r|_t)=/.test(h)).join(' '));
  check(hrefs.every(h => /^https:\/\/\S+\.\S+/.test(h)),
        'and is a real URL, not a placeholder', hrefs.join(' / '));

  // The chooser is gone, so its markup and its styles must be too — a rule
  // left behind styles nothing and reads as a feature that is still there.
  check(!/ad-snippet-summary|ad-snippet-links/.test(page),
        'the old three-platform chooser is fully removed, markup and CSS');
}

console.log('\n--- the community playlists');
// Same block, same order and the same rules as PRESS PLAY's, which is the
// point: two campaign cards side by side that list their playlists in
// whatever order the links arrived read as two different features.
//
// Checked in ORDER rather than as a set. A set passes while FOCUSED sits
// third, and the order is the only thing distinguishing these three to
// someone scanning the card.
{
  const page = readFileSync(root + 'index.html', 'utf8');
  const card = (page.match(/<div class="cd-card cd-card-addicted"[\s\S]*?(?=<div class="cd-card )/) || [''])[0];
  const block = (card.match(/<details class="cd-times cd-playlists">[\s\S]*?<\/details>/) || [''])[0];
  check(!!block, 'the card has a playlists block');

  const WANT = [
    ['ADDICTED FOCUSED',  '3qcYmgWzGmjjdEnjRFGWgU'],
    ['ADDICTED x PINKS',  '5hskZkTdeVFb5NgVuin2W4'],
    ['ADDICTED x BP',     '7nUhd0sH32lh4wWkdREGFe'],
  ];
  const links = [...block.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .map((m) => [m[2].replace(/\s*→\s*$/, '').trim(), m[1]]);
  check(links.length === WANT.length, `${links.length} playlists listed`,
        links.map((l) => l[0]).join(', '));
  WANT.forEach(([name, id], i) => {
    const got = links[i] || [];
    check(got[0] === name && got[1] === `https://open.spotify.com/playlist/${id}`,
          `  ${i + 1}. ${name}`, got[0] ? `got ${got[0]} → ${got[1]}` : 'missing');
  });
  // Each arrived carrying ?si=, which identifies whoever copied the link.
  check(!/[?&]si=/.test(block), 'and none carries a share-tracking parameter',
        (block.match(/[^"]*[?&]si=[^"]*/g) || []).join(' '));
  // ADDICTED is out. "Pre-save them" is PRESS PLAY's note, for a card that was
  // still counting down, and copying it here would ask for something that is
  // no longer possible.
  check(/class="cd-pl-note"/.test(block) && !/pre-save/i.test(block),
        'and the note asks people to play them, not to pre-save a released song');
}

console.log('\n--- the playlists are shareable');
// Built in a real browser from the real card, because the point of this post
// is that it is NOT a second copy of the ids — it reads the anchors off the
// panel. A source-level check would pass on a function that returns a
// hand-typed list, which is the failure it exists to prevent.
{
  const { createServer } = await import('node:http');
  const { chromium } = await import('./_playwright.mjs');
  const TY = { html:'text/html', js:'text/javascript', css:'text/css', json:'application/json',
    png:'image/png', jpg:'image/jpeg', webp:'image/webp', svg:'image/svg+xml', mp4:'video/mp4' };
  const srv = createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/sw.js') { res.writeHead(404); res.end(''); return; }
    const f = u === '/' ? '/index.html' : u;
    try { const b = await (await import('node:fs/promises')).readFile(root + f.slice(1));
      res.writeHead(200, { 'content-type': TY[f.split('.').pop()] || 'application/octet-stream' }); res.end(b); }
    catch { res.writeHead(404); res.end(''); }
  });
  await new Promise((r) => srv.listen(0, r));
  const br = await chromium.launch();
  const pg = await br.newPage({ viewport: { width: 414, height: 900 } });
  await pg.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1'); localStorage.setItem('ext_update_dismissed_1.9.8','1'); } catch (e) {} });
  await pg.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.shareAddictedPlaylists === 'function', null, { timeout: 30000 }).catch(() => {});

  const r = await pg.evaluate(() => {
    const card = document.querySelector('.cd-card-addicted');
    const btn = card && card.querySelector('.cd-pl-share');
    const hrefs = [...card.querySelectorAll('.cd-playlists .cd-times-body a')].map(a => a.href);
    return { hasBtn: !!btn, onclick: btn ? btn.getAttribute('onclick') : '',
             post: (window._addictedPlaylistPost && window._addictedPlaylistPost()) || null, hrefs };
  });

  check(r.hasBtn, 'the playlists block has a share button', r.onclick);
  check(!!r.post, 'and it builds a post');
  if (r.post) {
    // Every link on the panel is in the post, and nothing else is.
    const inPost = r.hrefs.filter((h) => r.post.includes(h));
    check(inPost.length === r.hrefs.length,
          `all ${r.hrefs.length} playlists are in it`, `${inPost.length} found`);
    const extra = [...r.post.matchAll(/https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]+/g)]
      .map((m) => m[0]).filter((u) => !r.hrefs.includes(u));
    check(extra.length === 0, 'and no playlist the card does not have', extra.join(' '));
    // The titles travel with the links; a bare list of urls says nothing.
    check(/ADDICTED FOCUSED/.test(r.post) && /ADDICTED x PINKS/i.test(r.post) && /ADDICTED x BP/i.test(r.post),
          'each one is named, not just linked');
    check(r.post.includes('blinksunited.com/countdowns/addicted'),
          'and the post carries the campaign link');
    check(!/[?&](si|utm_source|is|obrf)=/.test(r.post),
          'and no share-tracking parameter rides along',
          (r.post.match(/\S*[?&](si|utm_source)=\S*/g) || []).join(' '));
    // It is out. The PRESS PLAY post asks for a pre-save; this one cannot.
    check(!/pre-?save/i.test(r.post), 'and it does not ask anyone to pre-save a released single');
  }
  await br.close(); srv.close();
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
