// Every leaderboard track names itself.
//
// Run: node .github/scripts/test_lb_song_labels.mjs
//
// Reported from the live site on 2026-10-25: selecting TARANTINO showed
// "34 LESS THAN A LOVER streams today combined", and so did V12, COBRA,
// CUT U OFF and SWEAT — the whole PRESS PLAY EP announcing itself as Jennie's
// song, on the board, in the heading and on the shared card.
//
// The cause was five identical hand-written ternary chains, each ending
// `: 'LESS THAN A LOVER'`. Any id they had not been taught fell through to that
// final branch. Adding a track meant remembering five places; the EP was added
// to TRACKS and to the tab buttons, and those five were missed.
//
// Two things let it survive review. SaWaDiKa read correctly, because it had
// shipped as a single a month earlier and been added by hand — so a quick look
// at a PRESS PLAY tab could land on the one that worked. And `ltal` read
// correctly because the fallback happened to BE its title, so the bug was
// invisible from the one tab most likely to be used for checking.
//
// The guard is therefore not "the chain is gone" but "no two tracks share a
// label, and no track borrows another's" — which is the property that was
// actually violated, and which stays true however the lookup is written.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const page = readFileSync(root + 'index.html', 'utf8');

// Evaluate the real TRACKS array and the real lookup out of the page, rather
// than restating either here — a test with its own copy of the list is one more
// place to forget a track, which is the bug.
function load() {
  const arr = page.match(/^const TRACKS = \[[\s\S]*?^\];$/m);
  if (!arr) throw new Error('could not find the TRACKS array in index.html');
  // Matched loosely on purpose. Pinning the exact fallback expression made the
  // test fail to LOAD when that expression changed, instead of failing a check
  // — so reintroducing the original bug produced an unexplained crash rather
  // than "tarantino says LESS THAN A LOVER", which is the one message that
  // makes the failure self-explanatory.
  const table = page.match(/^const LB_SONG_TITLE = .*?;$/m);
  const fn = page.match(/^const lbSongLabel = [\s\S]*?;$/m);
  if (!table || !fn) throw new Error('could not find LB_SONG_TITLE / lbSongLabel in index.html');
  const lookup = [table[0], fn[0]];
  // NEWTRICK_TRACK_ID is interpolated into one entry's spotify url.
  return new Function(`const NEWTRICK_TRACK_ID = 'x';\n${arr[0]}\n${lookup.join('\n')}\nreturn { TRACKS, LB_SONG_TITLE, lbSongLabel };`)();
}

const { TRACKS, lbSongLabel } = load();
const ids = TRACKS.map(t => t.id);

console.log(`--- ${ids.length} tracks, each with a label of its own`);
for (const t of TRACKS) {
  const got = lbSongLabel(t.id, 'ALL TRACKS');
  check(got === t.title, `${t.id} → ${t.title}`, got === t.title ? '' : `got "${got}"`);
}

console.log('\n--- no track wears another track\'s name');
// The direct statement of the bug. TARANTINO returning "LESS THAN A LOVER" is
// caught here even if every individual lookup above were rewritten to agree
// with some other wrong table.
{
  const seen = new Map();
  for (const t of TRACKS) {
    const label = lbSongLabel(t.id, 'ALL TRACKS');
    if (seen.has(label)) fails.push(`${t.id} and ${seen.get(label)} both render as "${label}"`);
    seen.set(label, t.id);
  }
  const dupes = fails.filter(f => f.includes('both render as'));
  check(dupes.length === 0, 'every label is unique to one track', dupes.join('; '));
}

console.log('\n--- the PRESS PLAY EP specifically');
// Named outright because this is what was reported, and because a regression
// here is the one a reader of this file will want to see by name.
for (const id of ['v12', 'cobra', 'tarantino', 'cutuoff', 'sweat']) {
  const got = lbSongLabel(id, 'ALL TRACKS');
  check(got !== 'LESS THAN A LOVER', `${id} does not say LESS THAN A LOVER`, got);
}

console.log('\n--- an id nobody taught it is visibly wrong, not quietly wrong');
// The fallback's whole job. Confidently printing another song's name is worse
// than printing something obviously placeholder, because only one of the two
// gets reported.
{
  const got = lbSongLabel('somethingnew', 'ALL TRACKS');
  check(got === 'SOMETHINGNEW', 'an unknown id renders as itself', got);
  check(got !== 'LESS THAN A LOVER', 'and never borrows a real track\'s title');
}

console.log('\n--- "all" still says all');
check(lbSongLabel('all', 'ALL TRACKS') === 'ALL TRACKS', 'the ALL TRACKS wording is preserved');
check(lbSongLabel('all', 'All Campaign Tracks') === 'All Campaign Tracks',
      'and so is the All Campaign Tracks wording, which two callers use instead');

console.log('\n--- every sub-tab button points at a real track');
// The other half of the pairing: a button whose id is not in TRACKS would now
// render as capitals rather than a wrong song, but it still would not work.
{
  const tabIds = [...page.matchAll(/switchLbSong\('([a-z0-9]+)'/g)].map(m => m[1]);
  const unknown = [...new Set(tabIds)].filter(id => id !== 'all' && !ids.includes(id));
  check(unknown.length === 0, `all ${new Set(tabIds).size} sub-tabs resolve to a track`, unknown.join(', '));
  const missingTab = ids.filter(id => !tabIds.includes(id));
  check(missingTab.length === 0, 'and every track has a sub-tab', missingTab.join(', '));
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
