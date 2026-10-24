// The /streams "BY ALBUM" view, in a real browser.
//
// Run: node .github/scripts/test_album_grouping.mjs
//
// Spotify files a pre-release single under its OWN album name, so the view
// stood SaWaDiKa apart from PRESS PLAY and Less Than a Lover apart from Fallen
// Angel — the same record shown as two, with the EP's own total missing the
// track that carried most of its streams.
//
// Two things go wrong silently when folding them in. The group can take its
// name, sleeve and release date from whichever member has the most streams —
// which is the single, since tracks arrive sorted by streams, so PRESS PLAY
// would wear SaWaDiKa's cover. And a track on its first reading has no previous
// day to subtract, which rendered as "—": indistinguishable from a day where
// nobody streamed it, on the day a record came out.
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
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
let fails=0;
const ok=(m,d)=>console.log(`  ok   ${m}${d?` (${d})`:''}`);
const bad=(m,d)=>{fails++;console.log(`  FAIL ${m}${d?` (${d})`:''}`);};
await page.goto(base+'/streams',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(2000);

// The real album strings and shape the live data returns, including the single
// outranking every EP track — which is what makes the metadata question bite.
const render = async () => page.evaluate(() => {
  artistStreamsData = { tracks: [
    { name: 'SaWaDiKa',     streams: 88680494, daily_delta: 1372419, prev_daily_delta: 1376410,
      album: 'SaWaDiKa',   album_release_date: '2026-09-04', album_art_url: 'https://img/sawadika.jpg' },
    { name: 'Tarantino',    streams: 243826, daily_delta: null, prev_daily_delta: null,
      album: 'PRESS PLAY',  album_release_date: '2026-10-23', album_art_url: 'https://img/pressplay.jpg' },
    { name: 'V12',          streams: 156452, daily_delta: null, prev_daily_delta: null,
      album: 'PRESS PLAY',  album_release_date: '2026-10-23', album_art_url: 'https://img/pressplay.jpg' },
    { name: 'Cut U Off',    streams: 143510, daily_delta: null, prev_daily_delta: null,
      album: 'PRESS PLAY',  album_release_date: '2026-10-23', album_art_url: 'https://img/pressplay.jpg' },
    { name: 'Cobra',        streams: 139160, daily_delta: null, prev_daily_delta: null,
      album: 'PRESS PLAY',  album_release_date: '2026-10-23', album_art_url: 'https://img/pressplay.jpg' },
    { name: 'Sweat',        streams: 136572, daily_delta: null, prev_daily_delta: null,
      album: 'PRESS PLAY',  album_release_date: '2026-10-23', album_art_url: 'https://img/pressplay.jpg' },
    { name: 'Less Than a Lover', streams: 80401093, daily_delta: 361999, prev_daily_delta: 359621,
      album: 'Less than a Lover', album_release_date: '2026-08-01', album_art_url: 'https://img/ltal.jpg' },
    { name: 'Fallen Angel', streams: 34874308, daily_delta: 298918, prev_daily_delta: 295235,
      album: 'Fallen Angel', album_release_date: '2026-09-04', album_art_url: 'https://img/faep.jpg' },
    { name: 'Heaven',       streams: 24293935, daily_delta: 187103, prev_daily_delta: 182866,
      album: 'Fallen Angel', album_release_date: '2026-09-04', album_art_url: 'https://img/faep.jpg' },
  ] };
  artistTrackGroupByAlbum = true;
  artistTrackSort = 'streams';
  renderArtistTracks();
  const out = [];
  for (const tr of document.querySelectorAll('#as-tracks-body tr')) {
    if (tr.classList.contains('as-album-row')) {
      out.push({ kind: 'album',
        name: tr.querySelector('.as-album-name')?.textContent.trim(),
        stats: tr.querySelector('.as-album-stats')?.textContent.trim(),
        art: tr.querySelector('.as-album-art')?.getAttribute('src') || null,
        partial: tr.querySelector('.as-album-partial')?.textContent.trim() || null });
    } else {
      out.push({ kind: 'track',
        name: tr.querySelector('.as-track-name')?.textContent.trim(),
        ownArt: tr.querySelector('.as-track-art')?.getAttribute('src') || null,
        daily: tr.querySelector('.as-track-daily-num')?.textContent.trim() });
    }
  }
  return out;
});
const rows = await render();
const albums = rows.filter(r => r.kind === 'album');
console.log('    groups: ' + albums.map(a => a.name).join(' · '));

// One group per record, not per sleeve.
albums.length === 2 ? ok('two records, not four') : bad('two records, not four', albums.map(a=>a.name).join(', '));
albums.some(a => a.name === 'SaWaDiKa') ? bad('SaWaDiKa is not its own group') : ok('SaWaDiKa is not its own group');
albums.some(a => a.name === 'Less than a Lover') ? bad('the LTAL single is not its own group')
                                                 : ok('the LTAL single is not its own group');

const idx = n => rows.findIndex(r => r.kind === 'album' && r.name === n);
const membersOf = n => { const i = idx(n); const out = [];
  for (let j = i + 1; j < rows.length && rows[j].kind === 'track'; j++) out.push(rows[j]); return out; };

const pp = membersOf('PRESS PLAY');
JSON.stringify(pp.map(t => t.name.replace(/^\s+/, ''))) ===
  JSON.stringify(['SaWaDiKa','Tarantino','V12','Cut U Off','Cobra','Sweat'])
  ? ok('PRESS PLAY holds all six, SaWaDiKa first', pp.length + ' tracks')
  : bad('PRESS PLAY holds all six, SaWaDiKa first', pp.map(t=>t.name).join(', '));
const fa = membersOf('Fallen Angel');
fa.length === 3 ? ok('Fallen Angel holds all three') : bad('Fallen Angel holds all three', fa.length);

// The group's own total must include the single — that is the point of folding.
const ppStats = albums.find(a => a.name === 'PRESS PLAY').stats;
ppStats.includes('6 tracks') ? ok('PRESS PLAY counts 6 tracks') : bad('PRESS PLAY counts 6 tracks', ppStats);
ppStats.includes('89,500,014') ? ok('and sums the single into its total', '89,500,014')
                               : bad('and sums the single into its total', ppStats);

// Metadata from the EP, not from its biggest track.
const ppArt = albums.find(a => a.name === 'PRESS PLAY').art;
ppArt === 'https://img/pressplay.jpg'
  ? ok('PRESS PLAY wears its own sleeve, not the single\'s')
  : bad('PRESS PLAY wears its own sleeve, not the single\'s', ppArt);

// The single keeps its sleeve on its own row.
const sawa = pp.find(t => t.name.includes('SaWaDiKa'));
sawa?.ownArt === 'https://img/sawadika.jpg'
  ? ok('SaWaDiKa still shows its own cover on its row')
  : bad('SaWaDiKa still shows its own cover on its row', sawa?.ownArt);
pp.find(t => t.name.includes('Tarantino'))?.ownArt === null
  ? ok('an EP track adds no redundant thumbnail')
  : bad('an EP track adds no redundant thumbnail');

// First readings: labelled, counted, and explained where the number is.
const firsts = pp.filter(t => t.daily === 'first reading').map(t => t.name.trim());
firsts.length === 5 ? ok('the five new tracks read "first reading", not "—"')
                    : bad('the five new tracks read "first reading", not "—"', firsts.join(', '));
sawa?.daily?.startsWith('+') ? ok('SaWaDiKa still shows a real daily', sawa.daily)
                             : bad('SaWaDiKa still shows a real daily', sawa?.daily);
const note = albums.find(a => a.name === 'PRESS PLAY').partial;
note && note.includes('5 tracks') && /partial day/i.test(note)
  ? ok('and the group says the figure is a partial day')
  : bad('and the group says the figure is a partial day', note);
albums.find(a => a.name === 'Fallen Angel').partial === null
  ? ok('a settled record carries no partial-day note')
  : bad('a settled record carries no partial-day note');

if (errs.length) { console.log('    page errors: ' + errs.slice(0,3).join(' | ')); fails += errs.length; }
await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
