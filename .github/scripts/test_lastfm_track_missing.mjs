// A BRAND-NEW TITLE MUST NOT FAIL A REFRESH.
//
// Run: node .github/scripts/test_lastfm_track_missing.mjs
//
// WHAT WENT WRONG, 2026-11-20. "Sun Showers" was added to TRACKS five hours
// after its release. Last.fm creates a track's page on its FIRST SCROBBLE
// ANYWHERE, so for the opening hours of a release track.getInfo answers
//
//     error 6: Track not found
//
// for a song thousands of people are playing — measured at 10:31Z across four
// spellings with autocorrect on and off: eight misses. fetchTrackPlays let that
// throw, the throw escaped refreshUser's Promise.all, and ONE brand-new title
// therefore failed the WHOLE user. The first run after the deploy:
//
//     46 of 51 failed — every one "Last.fm error 6: Track not found"
//
// THE FIVE SURVIVORS ARE THE DIAGNOSIS. They are the idle accounts, which skip
// the per-track reads entirely. A spent key fails everyone; this failed exactly
// the accounts that had scrobbled. That shape is why this is a title bug and
// not a budget one, and it is the thing to look for if it ever recurs.
//
// The same function exists in index.html and would have thrown on every
// signed-in fan's badges page — which is worse, because the fan is looking at
// it. Measured on one real row: Last.fm held 24 plays, the board held 6, and
// the badges page reported 26 then 6 on consecutive loads. Partial sums of the
// same 24, varying with which account's fetch threw first. The instability is
// the fingerprint — a correct calculation does not change on reload.
//
// WHAT IS PINNED HERE
//   1. fetchTrackPlays returns 0 for error 6 instead of throwing.
//   2. A refresh with one missing title still produces every OTHER figure,
//      correctly — not zeroes, and not a thrown user.
//   3. The missing title is REPORTED, because error 6 is also what a
//      misspelled entry in TRACKS returns (the "Someone to Hold" failure) and
//      swallowing it silently would make that permanent and invisible.
//   4. A genuine error still fails, so the catch is not a blanket swallow.
//   5. The day and week counts for the missing title still land from the
//      scrobble feed — the whole point: no Last.fm page, but the fan's plays
//      of it count.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

// ── Build the real module, stubbing only its two npm imports ────────────────
const src = readFileSync(root + 'api/cron-scrobbles.js', 'utf8');
const IMPORTS = [
  "import { Redis } from '@upstash/redis';",
  "import { createClient } from '@supabase/supabase-js';",
];
for (const line of IMPORTS) {
  if (!src.includes(line)) {
    console.log(`  FAIL harness: expected import line not found: ${line}`);
    console.log('         api/cron-scrobbles.js changed its imports — fix this harness,');
    console.log('         do not let it pass by testing nothing.');
    process.exit(1);
  }
}
const STORE = new Map();
const prelude = `
const Redis = { fromEnv: () => ({
  get:  async k => (globalThis.__store.has(k) ? JSON.parse(JSON.stringify(globalThis.__store.get(k))) : null),
  set:  async (k, v) => { globalThis.__store.set(k, JSON.parse(JSON.stringify(v))); return 'OK'; },
  del:  async k => { globalThis.__store.delete(k); return 1; },
}) };
const createClient = () => { throw new Error('supabase must not be constructed in this test'); };
`;
let built = src;
for (const line of IMPORTS) built = built.replace(line, '');
built = prelude + built + `
export { lfmFetch, fetchTrackPlays, refreshUser, TRACKS, lfmMissingTracks };
`;
const dir = mkdtempSync(join(tmpdir(), 'bu-missing-'));
const modPath = join(dir, 'cron-scrobbles.mjs');
writeFileSync(modPath, built);

process.env.LASTFM_RATE_PER_SEC = '200';          // fast; pacing is tested elsewhere
process.env.SCROBBLE_RUN_BUDGET_MS = '600000';
delete process.env.CRON_SECRET;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
globalThis.__store = STORE;

const mod = await import('file://' + modPath);
check(typeof mod.fetchTrackPlays === 'function', 'harness built the real module');

// The title that has no Last.fm page. Taken from TRACKS rather than hardcoded,
// so this keeps testing the newest release instead of a name that ages out.
const MISSING = mod.TRACKS[mod.TRACKS.length - 1];
const PRESENT = mod.TRACKS[0];
console.log(`    missing title under test: ${MISSING.artist} — ${MISSING.track}`);
console.log(`    control title:            ${PRESENT.artist} — ${PRESENT.track}`);

// ── A Last.fm that has no page for exactly one title ────────────────────────
let calls = [];
let playcount = 1000;
let feed = [];
let failMode = null;          // 'none' | 'server' — for the "still fails" check
const scrobble = (name, artistName, uts) => ({ name, artistName, uts });

globalThis.fetch = async (url) => {
  const q = new URL(url).searchParams;
  const method = q.get('method');
  calls.push({ method, track: q.get('track') });
  if (method === 'track.getInfo') {
    if (q.get('track') === MISSING.track) {
      // Exactly what Last.fm sends for a track it has no page for.
      return { ok: true, json: async () => ({ error: 6, message: 'Track not found' }) };
    }
    if (failMode === 'server' && q.get('track') === PRESENT.track) {
      // 13 is not in LASTFM_RETRYABLE_ERRORS, so it is a genuine hard failure
      // and must still propagate. Picked deliberately over 8/11/16, which
      // retry, so this asserts the catch and not the retry.
      return { ok: true, json: async () => ({ error: 13, message: 'Invalid method signature' }) };
    }
    return { ok: true, json: async () => ({ track: { userplaycount: '7' } }) };
  }
  const body =
    method === 'user.getInfo'   ? { user: { playcount: String(playcount) } } :
    method === 'artist.getInfo' ? { artist: { stats: { userplaycount: '500' } } } :
    method === 'user.getRecentTracks' ? recentTracksBody(q) : {};
  return { ok: true, json: async () => body };
};
function recentTracksBody(q) {
  const from = parseInt(q.get('from') || '0', 10);
  const to   = parseInt(q.get('to')   || '9999999999', 10);
  const sel  = feed.filter(s => s.uts >= from && s.uts < to).sort((a, b) => b.uts - a.uts);
  return { recenttracks: {
    track: sel.map(s => ({ name: s.name, artist: { '#text': s.artistName }, date: { uts: String(s.uts) } })),
    '@attr': { totalPages: '1' },
  } };
}
const entry = u => ({ username: u, displayName: u, linkedAccounts: [{ type: 'lastfm', username: u }], scores: {} });

// ── 1. error 6 is an answer, not an exception ──────────────────────────────
console.log('--- a title Last.fm has no page for reads as 0, not as a throw');
{
  let threw = null, got = null;
  try { got = await mod.fetchTrackPlays('u', MISSING.artist, MISSING.track); }
  catch (e) { threw = e; }
  check(threw === null, 'fetchTrackPlays does not throw on error 6',
        threw ? String(threw.message).slice(0, 60) : 'returned');
  check(got === 0, 'and it reads as 0 plays', `got ${JSON.stringify(got)}`);
  check([...mod.lfmMissingTracks].some(s => s.includes(MISSING.track)),
        'and the title is recorded so it can be reported',
        [...mod.lfmMissingTracks].join(', ') || '(empty)');
}

// ── 2. the control title still works, and a hard error still fails ─────────
console.log('--- the catch is for error 6 only, not a blanket swallow');
{
  const n = await mod.fetchTrackPlays('u', PRESENT.artist, PRESENT.track);
  check(n === 7, 'a title that DOES have a page returns its real count', `got ${n}`);

  failMode = 'server';
  let threw = null;
  try { await mod.fetchTrackPlays('u', PRESENT.artist, PRESENT.track); }
  catch (e) { threw = e; }
  check(threw !== null, 'a non-6 Last.fm error still throws',
        threw ? String(threw.message).slice(0, 48) : 'DID NOT THROW — the catch is too wide');
  check(threw?.lfmError === 13, 'and it carries the numeric code for the caller',
        `lfmError=${threw?.lfmError}`);
  failMode = null;
}

// ── 3. the whole user survives, with every other figure intact ─────────────
// This is the regression itself: before the fix, refreshUser threw here and the
// caller kept the fan's stale row, so the board looked populated and was frozen.
console.log('--- one missing title does not fail the user');
{
  STORE.clear();
  calls = [];
  const now = Math.floor(Date.now() / 1000);
  // Played BOTH the control title and the one with no Last.fm page.
  feed = [
    scrobble(PRESENT.track, PRESENT.artist, now - 600),
    scrobble(MISSING.track, MISSING.artist, now - 300),
    scrobble(MISSING.track, MISSING.artist, now - 200),
  ];
  let out = null, threw = null;
  try { out = await mod.refreshUser(entry('alice'), null, null, null, {}); }
  catch (e) { threw = e; }
  check(threw === null, 'refreshUser completes',
        threw ? String(threw.message).slice(0, 60) : 'no throw');
  if (out) {
    check(out.scores[`overall_${PRESENT.id}`] === 7,
          'the other titles keep their real all-time figures',
          `overall_${PRESENT.id}=${out.scores[`overall_${PRESENT.id}`]}`);
    check(out.scores[`overall_${MISSING.id}`] === 0,
          'the missing title reads 0 all-time, which is the honest figure',
          `overall_${MISSING.id}=${out.scores[`overall_${MISSING.id}`]}`);
    // THE POINT OF THE WHOLE EXERCISE: no Last.fm page, but the fan's plays of
    // it still count today and this week, because those are derived from the
    // scrobble feed and not from track.getInfo.
    check(out.scores[`daily_${MISSING.id}`] === 2,
          "and the fan's plays of it STILL land in today's count",
          `daily_${MISSING.id}=${out.scores[`daily_${MISSING.id}`]}`);
    check(out.scores[`weekly_${MISSING.id}`] === 2,
          'and in the week', `weekly_${MISSING.id}=${out.scores[`weekly_${MISSING.id}`]}`);
    check(out.scores[`daily_${PRESENT.id}`] === 1,
          'the control title counts once', `daily_${PRESENT.id}=${out.scores[`daily_${PRESENT.id}`]}`);
    // And the derived sums include the missing title's plays — the second bug
    // found the same morning, where the three *_all sums were typed out and
    // stopped at `lwm`, so the newest release was missing from every total.
    check(out.scores.daily_all >= 3,
          'daily_all includes the missing title and is not short',
          `daily_all=${out.scores.daily_all}`);
  }
}

// ── 4. every title missing is still not a thrown user ──────────────────────
// The release-morning worst case: a page so new that nothing in TRACKS resolves.
console.log('--- even if Last.fm has no page for ANY title, the user still refreshes');
{
  STORE.clear();
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams;
    const method = q.get('method');
    if (method === 'track.getInfo') {
      return { ok: true, json: async () => ({ error: 6, message: 'Track not found' }) };
    }
    return saved(url);
  };
  let out = null, threw = null;
  try { out = await mod.refreshUser(entry('bob'), null, null, null, {}); }
  catch (e) { threw = e; }
  globalThis.fetch = saved;
  check(threw === null, 'refreshUser still completes',
        threw ? String(threw.message).slice(0, 60) : 'no throw');
  check(out && out.scores.overall_all === 0,
        'with every all-time figure 0 and nothing invented', `overall_all=${out?.scores?.overall_all}`);
}

// ── 5. the browser carries the same fix ────────────────────────────────────
// index.html has its own copy of fetchTrackPlays — a duplicate the repo has
// been bitten by before (api/youtube-stats.js's stale RELEASE map). Fixing one
// and not the other leaves the fan's own page broken, which is the half they
// actually see, so this reads the real file rather than trusting that both were
// edited.
console.log('--- index.html has the same guard, not just the server');
{
  const html = readFileSync(root + 'index.html', 'utf8');
  const fn = html.slice(html.indexOf('async function fetchTrackPlays'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  check(/catch/.test(body), 'the browser copy catches instead of propagating');
  check(/lfmError\s*===\s*6|error 6/.test(body),
        'and it tests for error 6 specifically, not every error');
  check(/return 0/.test(body), 'and returns 0 for it');
  check(/err\.lfmError\s*=\s*data\.error/.test(html),
        "and lfmFetch tags the thrown error with its code so that test is possible");
  // A blanket `catch { return 0 }` would make every figure on the badges page
  // silently zero on any Last.fm hiccup, which is strictly worse than the bug
  // being fixed: it would look like the fan had streamed nothing.
  check(/throw e/.test(body), 'a non-6 error is still re-thrown, not swallowed as 0');
}

console.log('');
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('All correct.');
