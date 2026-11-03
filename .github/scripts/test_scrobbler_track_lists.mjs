// Every scrobbler counts every track.
//
// Run: node .github/scripts/test_scrobbler_track_lists.mjs
//
// WHY. A play reaches the leaderboard down one of five paths, and each one
// carries its OWN hand-written list of the tracks it knows:
//
//   Last.fm / Libre.fm   api/cron-scrobbles.js   TRACKS
//   ListenBrainz         (same TRACKS)
//   BU browser extension api/ingest-scrobble.js  TRACKS      <- matcher
//   Musicat / Stats.fm   api/statsfm.js          TRACKS      <- matcher
//   the board itself     api/leaderboard.js      rankTids / TIDS / empty()
//   the badges page      index.html              TRACKS / CAMPAIGN_TOTAL_IDS
//
// Adding a release to some of them and not the rest throws nothing, logs
// nothing and renders fine. The song simply reads low, in a way that looks
// exactly like the fan not having streamed it.
//
// That is not hypothetical. JISOO's ADDICTED (2026-10-30) went into
// cron-scrobbles and index.html and into NONE of the other three, so:
//   · every extension-scrobbled play fell through the matcher into the
//     generic solo_jisoo bucket and counted for nothing;
//   · Stats.fm/Musicat reported 0 for it however much it was played;
//   · rankTids() left it out of the campaign *_all sums, and the daily floor
//     did not protect it, so a partial page load could LOWER it.
// A fan reported the card showing 2. The Last.fm half was working the whole
// time, which is why it took a report to notice.
//
// test_track_wiring.mjs already guards "a release reaches every list" — but it
// loads index.html in a browser and never reads api/*.js, so all five server
// paths were outside it. It passed through every day of this. This file is the
// server half, and it is deliberately plain text parsing: no browser, so it
// still runs on a runner where Playwright cannot install.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const read = p => readFileSync(root + p, 'utf8');

// ── The canonical list, read from the source rather than typed here ─────────
// Typing the ids into this file would mean the test knows about a release only
// when someone remembers to tell it — the exact failure it exists to catch.
const cron = read('api/cron-scrobbles.js');
const cronBlock = (cron.match(/const TRACKS = \[([\s\S]*?)\n\];/) || [])[1];
if (!cronBlock) {
  console.log('  FAIL could not read TRACKS from api/cron-scrobbles.js — fix this test, do not let it pass');
  process.exit(1);
}
const CANON = [...cronBlock.matchAll(/id:\s*'([a-z0-9]+)'/g)].map(m => m[1]);
ok(`canonical track list: ${CANON.length} tracks`, CANON.join(' '));
if (CANON.length < 10) { bad('the canonical list looks truncated'); process.exit(1); }

// ── Every list that has to carry all of them ────────────────────────────────
// `end` is a distinctive closer so the captured block stops at the right place.
const LISTS = [
  ['api/ingest-scrobble.js', 'TRACKS (the extension matcher)',
   /const TRACKS = \[([\s\S]*?)\n\];/],
  ['api/statsfm.js', 'TRACKS (Musicat / Stats.fm matcher)',
   /const TRACKS = \[([\s\S]*?)\n    \];/],
  ['api/leaderboard.js', 'rankTids() (the campaign *_all sums)',
   /const rankTids = \(\) => \[([\s\S]*?)\];/],
  ['api/leaderboard.js', 'extensionCountsForUser empty()',
   /const empty = \(\) => \(\{([\s\S]*?)\}\);/],
  ['index.html', 'CAMPAIGN_TOTAL_IDS',
   /const CAMPAIGN_TOTAL_IDS = \[([\s\S]*?)\];/],
];

console.log('\n--- every scrobbler path carries every track');
for (const [file, label, re] of LISTS) {
  const src = read(file);
  const m = src.match(re);
  if (!m) {
    // A list that cannot be found is a FAILURE, never a skip. A renamed
    // constant would otherwise silently remove this file from the check and
    // the run would stay green while the gap reopened.
    bad(`${file} · ${label}: could not locate the list`, 'the pattern no longer matches — fix this test');
    continue;
  }
  const tokens = new Set([
    ...[...m[1].matchAll(/'([a-z0-9]+)'/g)].map(x => x[1]),
    ...[...m[1].matchAll(/(\w+)\s*:\s*0\b/g)].map(x => x[1]),
  ]);
  const missing = CANON.filter(id => !tokens.has(id));
  missing.length === 0
    ? ok(`${file} · ${label}`, `${tokens.size} ids`)
    : bad(`${file} · ${label}`, `missing: ${missing.join(', ')}`);
}

// ── The repeated TIDS literals in leaderboard.js ────────────────────────────
// There are two, doing different jobs (folding in extension plays, and the
// daily floor that stops a partial load lowering a count). Both were short of
// ADDICTED. Checked by occurrence so neither can be fixed while the other is
// left behind — and the COUNT is asserted, so deleting one to make this pass
// is itself a failure.
console.log('\n--- and every copy of the TIDS literal, not just the first');
{
  const src = read('api/leaderboard.js');
  const hits = [...src.matchAll(/const TIDS = \[([\s\S]*?)\];/g)];
  hits.length >= 2
    ? ok(`found ${hits.length} TIDS literals`)
    : bad(`found ${hits.length} TIDS literals`, 'expected at least 2 — did one get deleted rather than fixed?');
  hits.forEach((h, i) => {
    const ids = new Set([...h[1].matchAll(/'([a-z0-9]+)'/g)].map(x => x[1]));
    const missing = CANON.filter(id => !ids.has(id));
    missing.length === 0
      ? ok(`  TIDS #${i + 1}`, `${ids.size} ids`)
      : bad(`  TIDS #${i + 1}`, `missing: ${missing.join(', ')}`);
  });
}

// ── The client and the server must agree on the campaign scope ──────────────
// rankTids() carries a comment calling CAMPAIGN_TOTAL_IDS its mirror. They
// drifted anyway: the client counted ADDICTED toward *_all and the server did
// not, so the same fan's total differed depending on which one computed it.
console.log('\n--- the client and server campaign sums are the same set');
{
  const lb = read('api/leaderboard.js');
  const site = read('index.html');
  const srv = new Set([...((lb.match(/const rankTids = \(\) => \[([\s\S]*?)\];/) || [])[1] || '')
    .matchAll(/'([a-z0-9]+)'/g)].map(x => x[1]));
  const cli = new Set([...((site.match(/const CAMPAIGN_TOTAL_IDS = \[([\s\S]*?)\];/) || [])[1] || '')
    .matchAll(/'([a-z0-9]+)'/g)].map(x => x[1]));
  const onlySrv = [...srv].filter(x => !cli.has(x));
  const onlyCli = [...cli].filter(x => !srv.has(x));
  (srv.size > 0 && onlySrv.length === 0 && onlyCli.length === 0)
    ? ok('rankTids() === CAMPAIGN_TOTAL_IDS', `${srv.size} ids`)
    : bad('rankTids() === CAMPAIGN_TOTAL_IDS',
          `server only: [${onlySrv.join(', ')}]  client only: [${onlyCli.join(', ')}]`);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
