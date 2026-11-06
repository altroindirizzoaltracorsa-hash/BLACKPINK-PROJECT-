// The two TRACKS lists carry byte-identical artist and track strings.
//
// Run: node .github/scripts/test_track_titles_match.mjs
//
// WHY THE STRINGS, NOT JUST THE IDS. test_scrobbler_track_lists already proves
// every path knows every track ID. That is not enough, because one of the
// paths does not match on an ID or on a normalised key — it matches on the
// RAW TITLE STRING:
//
//   fetchTrackPlays(username, t.artist, t.track)
//     -> Last.fm track.getInfo(artist, track).userplaycount
//
// There is no normalisation in that call at all. Last.fm either has a track
// under exactly that artist and title or it answers "Track not found", and
// the site turns that into 0. Both index.html and api/cron-scrobbles.js make
// that same call from their own copy of TRACKS, so the two copies must agree
// character for character or the browser and the cron disagree about a fan's
// all-time count — one of them reading 0.
//
// THIS IS NOT HYPOTHETICAL. JENNIE's "Someone to Hold" shipped with the bare
// title in both lists while Last.fm files it, and fans scrobble it, as
//
//     Someone to Hold (from the Netflix Film "Steps")
//
// Measured 2026-11-06 on two linked accounts: 43 and 25 plays under the full
// spelling, and track.getInfo for the bare one answered userplaycount=None
// under both 'Jennie' and 'JENNIE', with autocorrect off AND on, while
// user.getTrackScrobbles answered total=0. Last.fm does not fold the two
// together. Today and this week were right the whole time, because those go
// through trackKey() which strips (...) — which is exactly why the bug is
// quiet: the card shows plausible daily numbers beside a frozen all-time one.
//
// WHAT THIS CAN AND CANNOT CATCH. It cannot know what Last.fm calls a song;
// only probe-lastfm-title.yml and probe-track-user.yml can answer that, and
// they are the step to run on release day. What it catches is the other half
// of the same mistake: fixing the string in one file and not the other, which
// is silent, survives review, and leaves whichever surface was missed reading
// zero.
//
// Static analysis. No browser, no network.

import { readFileSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

// Scope to the TRACKS array before matching entries: index.html has other
// object literals with an `id:`, and one TRACKS entry's `spotify:` is a
// template literal containing ${...}, so the brace-avoiding entry pattern
// below must not be let loose on the whole file.
function tracksOf(file, src) {
  const i = src.indexOf('const TRACKS = [');
  if (i < 0) return null;
  const body = src.slice(i, src.indexOf('\n];', i));
  const out = new Map();
  for (const m of body.matchAll(/\{\s*id:\s*'([^']+)'[^}]*?artist:\s*'([^']*)'[^}]*?track:\s*'([^']*)'/g)) {
    out.set(m[1], { artist: m[2], track: m[3] });
  }
  return out.size ? out : null;
}

const files = [
  ['index.html',            tracksOf('index.html', read('index.html'))],
  ['api/cron-scrobbles.js', tracksOf('api/cron-scrobbles.js', read('api/cron-scrobbles.js'))],
];

console.log('--- both TRACKS lists parsed');
for (const [name, map] of files) {
  map ? ok(`${name}`, `${map.size} entries`)
      : bad(`${name}`, 'could not parse TRACKS — nothing below means anything');
}
if (files.some(([, m]) => !m)) { console.log('\n1 FAILED'); process.exit(1); }

const [[aName, a], [bName, b]] = files;

console.log('\n--- every id in both carries the same artist and title');
const shared = [...a.keys()].filter((id) => b.has(id));
shared.length
  ? ok(`${shared.length} id(s) in both`)
  : bad('the two lists share any ids at all');

for (const id of shared) {
  const x = a.get(id), y = b.get(id);
  if (x.artist === y.artist && x.track === y.track) { ok(`  ${id}`, `${x.artist} — ${x.track}`); continue; }
  if (x.artist !== y.artist)
    bad(`  ${id} artist`, `${aName}: ${JSON.stringify(x.artist)} vs ${bName}: ${JSON.stringify(y.artist)}`);
  if (x.track !== y.track)
    bad(`  ${id} track`, `${aName}: ${JSON.stringify(x.track)} vs ${bName}: ${JSON.stringify(y.track)} ` +
        '— track.getInfo is an exact-string lookup, so one of these reads 0');
}

// An id in one list and not the other is a different bug with its own test
// (test_scrobbler_track_lists), but saying so here costs a line and stops this
// one reporting "all titles agree" over a list that is missing a song.
console.log('\n--- and neither list has an id the other does not');
for (const [mine, theirs, mineName, theirsName] of [[a, b, aName, bName], [b, a, bName, aName]]) {
  const only = [...mine.keys()].filter((id) => !theirs.has(id));
  only.length === 0
    ? ok(`nothing only in ${mineName}`)
    : bad(`nothing only in ${mineName}`, `${only.join(', ')} missing from ${theirsName}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nTitles agree.');
process.exit(fails ? 1 : 0);
