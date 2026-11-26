// ONE DEAD LINKED ACCOUNT MUST NOT ZERO THE FAN'S WORKING ONES.
//
// Run: node .github/scripts/test_dead_account_isolation.mjs
//
// WHAT WENT WRONG. refreshUser walked a fan's linked accounts with no try/catch
// inside the loop, so the first unreachable one threw out of the whole function
// and the fan published nothing. Measured over the live board on 2026-11-22:
//
//   83 of 353 linked handles answer 404/403
//   44 of 212 board entries carry at least one of them
//
// so a FIFTH of the board contributed zero to the daily community goal every
// single day. The clearest case: `blackpinkshazam` has a working Last.fm with
// 146 BLACKPINK plays that day and a Libre.fm handle answering 403 — and scored
// zero because of the second one. That is why the goal had not been reached
// since 2026-10-30 while a live Last.fm recount put real activity at roughly
// twice the figure the bar was showing.
//
// WHAT MUST NOT HAPPEN WHILE FIXING IT, and this is the harder half:
//
//   · A 500 MUST STILL FAIL THE FAN. On 2026-11-26 Last.fm answered HTTP 500
//     for twelve consecutive accounts — a bad morning upstream, nothing to do
//     with those fans. Isolating that would publish a total with an account
//     missing merely because it was unreachable, silently cutting scores during
//     someone else's outage. Only 404/403 ("not there") may be isolated.
//   · A FAN WITH NOTHING LEFT must still fail, so their row keeps its
//     last-known numbers instead of being republished as a fresh zero.
//   · A CARRIED-FORWARD DAILY COUNT MUST NOT CROSS THE DAY BOUNDARY. The
//     community goal is a DAILY goal; a count cached under yesterday's day key
//     is yesterday's plays and must contribute 0 today, never be re-filed under
//     today.
//
// Each of those is a separate section below, because a fix that gets the first
// one right and any of the others wrong is worse than the bug.
//
// Built against the REAL module (only its two npm imports stubbed), asserted
// rather than assumed: if the import lines stop matching, the harness exits
// loudly instead of quietly testing a module it never built.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const IMPORTS = [
  "import { Redis } from '@upstash/redis';",
  "import { createClient } from '@supabase/supabase-js';",
];
const src = readFileSync(root + 'api/cron-scrobbles.js', 'utf8');
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
export { refreshUser, TRACKS, deadAccounts, getDayBounds, getWeekBounds, dayKey };
`;
const dir = mkdtempSync(join(tmpdir(), 'bu-deadacct-'));
const modPath = join(dir, 'cron-scrobbles.mjs');
writeFileSync(modPath, built);

process.env.LASTFM_RATE_PER_SEC = '200';      // fast; pacing is tested elsewhere
process.env.SCROBBLE_RUN_BUDGET_MS = '600000';
delete process.env.CRON_SECRET;
globalThis.__store = STORE;

const mod = await import('file://' + modPath);
check(typeof mod.refreshUser === 'function', 'harness built the real module');

// ── A Last.fm that can be told to fail specific handles ──────────────────────
// `statusFor` maps a handle to an HTTP status. Everything else succeeds.
let statusFor = {};
let calls = [];
let playcount = { };                 // per-handle whole-library playcount
let perTrackPlays = 7;               // what each track.getInfo returns
globalThis.fetch = async (url) => {
  const q = new URL(url).searchParams;
  const method = q.get('method');
  const user = q.get('user') || q.get('username') || '';
  calls.push({ method, user });
  const st = statusFor[user];
  if (st) return { ok: false, status: st, json: async () => ({}) };
  const body =
    method === 'user.getInfo'   ? { user: { playcount: String(playcount[user] ?? 1000) } } :
    method === 'artist.getInfo' ? { artist: { stats: { userplaycount: '500' } } } :
    method === 'track.getInfo'  ? { track: { userplaycount: String(perTrackPlays) } } :
    method === 'user.getRecentTracks' ? { recenttracks: { track: [], '@attr': { totalPages: '1' } } } :
    {};
  return { ok: true, json: async () => body };
};

const TRACKS = mod.TRACKS;
const NT = TRACKS.length;
const entryWith = (name, accts, scores = {}) => ({
  username: name, displayName: name, linkedAccounts: accts, scores,
});
const lfm = u => ({ type: 'lastfm', username: u });
const libre = u => ({ type: 'librefm', username: u });
const reset = () => { calls = []; statusFor = {}; mod.deadAccounts.length = 0; STORE.clear(); };

// ── 1. THE BUG: a dead second account must not zero the working first ────────
// Modelled directly on blackpinkshazam: lastfm works, librefm 403s.
console.log('--- a fan with one working and one dead account still counts');
{
  reset();
  statusFor = { souralis: 403 };
  let res, threw = null;
  try {
    res = await mod.refreshUser(
      entryWith('blackpinkshazam', [lfm('bpshazam'), libre('souralis')]),
      null, null, null, {});
  } catch (e) { threw = e; }
  check(threw === null, 'the refresh does not throw', threw ? threw.message : '');
  if (res) {
    // The working account contributed real per-track figures.
    check(res.scores.overall_jump === perTrackPlays,
          'the WORKING account\'s plays are counted',
          `overall_jump=${res.scores.overall_jump}, expected ${perTrackPlays}`);
    check(res.scores.overall_all === perTrackPlays * NT,
          'and the campaign total is the full sum, not zero',
          `${res.scores.overall_all} over ${NT} tracks`);
  }
  check(mod.deadAccounts.some(s => s.includes('souralis')),
        'the dead account is REPORTED, not silently dropped',
        JSON.stringify(mod.deadAccounts));
}

// ── 2. A 500 IS NOT ISOLATED ─────────────────────────────────────────────────
// The safety limit. An outage must not be allowed to publish a reduced total.
console.log('--- an HTTP 500 still fails the fan, so an outage cannot cut scores');
{
  reset();
  statusFor = { flaky: 500 };
  let threw = null;
  try {
    await mod.refreshUser(entryWith('someone', [lfm('works'), lfm('flaky')]), null, null, null, {});
  } catch (e) { threw = e; }
  check(threw !== null, 'refreshUser throws on a 500 rather than isolating it',
        threw ? threw.message : 'DID NOT THROW — an upstream outage would now lower totals');
  check(!mod.deadAccounts.some(s => s.includes('flaky')),
        'and a 500 is NOT recorded as a dead account');
}

// ── 3. A fan whose every account is dead still fails ─────────────────────────
// So the row keeps its last-known numbers rather than republishing a zero with
// today's date on it. Real instances on the board: `kat` (two handles, both
// 404) and `izz`. NOT `remspot3` — its 38 dead handles made it look like the
// obvious example, but it also carries two Stats.fm accounts and so takes the
// other-source path in 3b. The handle names are kept here only because they
// are the shape that exercises the guard.
console.log('--- a fan with no working scrobbler left still fails');
{
  reset();
  statusFor = { remspot3: 404, remspot4: 404 };
  let threw = null;
  try {
    await mod.refreshUser(entryWith('remspot3', [lfm('remspot3'), lfm('remspot4')]),
                          null, null, null, {});
  } catch (e) { threw = e; }
  check(threw !== null, 'refreshUser throws when nothing could be read',
        threw ? threw.message : 'DID NOT THROW — would publish a fresh zero');
  // AND THE MESSAGE STILL HAS TO SAY "HTTP 404", which is not cosmetic. The
  // caller's markMiss only counts a miss matching /HTTP (404|403)/, and that
  // is what retires a name after DEAD_AFTER consecutive misses. Throwing an
  // error of our own wording here ("all 1 account(s) unavailable") does not
  // match, so the skip list silently stops accumulating and a dead name is
  // retried every run forever. That is exactly what the first version of this
  // fix did, and test_scrobble_rate caught it — pinned here too, next to the
  // throw it constrains, because nothing about the synthetic message looked
  // wrong on review.
  check(threw !== null && /HTTP (404|403)/.test(String(threw.message || '')),
        'and the thrown message still matches what markMiss counts',
        threw ? JSON.stringify(threw.message) : 'n/a');
}

// ── 3b. …unless another kind of scrobbler is linked ──────────────────────────
// Stats.fm / ListenBrainz / Musicat are fetched by other branches, so a fan
// whose Last.fm died but whose Stats.fm works must still be refreshed.
console.log('--- but a dead Last.fm does not fail a fan who also has Stats.fm');
{
  reset();
  statusFor = { gonehandle: 404 };
  let threw = null;
  try {
    await mod.refreshUser(
      entryWith('mixed', [lfm('gonehandle'), { type: 'statsfm', username: 'someid' }]),
      null, null, null, {});
  } catch (e) { threw = e; }
  check(threw === null, 'the fan is still refreshed via their other source',
        threw ? threw.message : '');
}

// ── 4. A dead account's ALL-TIME totals are carried, not written down to 0 ───
// They are cumulative and only climb, so the last figure read is the best
// available; zeroing them would visibly shorten the fan's badges.
console.log('--- a dead account with a cache carries its all-time totals forward');
{
  reset();
  statusFor = { wentaway: 404 };
  const CARRIED = 4242;
  const t = {}; for (const tr of TRACKS) t[tr.id] = CARRIED;
  const cache = { wentaway: { pc: 9, ap: 77, t, d: {}, w: {}, dk: 'x', wk: 'x', ts: 0, tFull: 0 } };
  let res = null, threw = null;
  try {
    res = await mod.refreshUser(
      entryWith('carrier', [lfm('alive'), lfm('wentaway')]), null, null, null, cache);
  } catch (e) { threw = e; }
  check(threw === null, 'no throw', threw ? threw.message : '');
  if (res) {
    check(res.scores.overall_jump === perTrackPlays + CARRIED,
          'the all-time total is the live account PLUS the cached dead one',
          `${res.scores.overall_jump} = ${perTrackPlays} + ${CARRIED}`);
  }
}

// ── 5. THE DAY BOUNDARY: a stale cached daily count must contribute 0 ────────
// The half that keeps the community goal honest. Carrying yesterday's count
// into today would put stale listening into a DAILY bar — which the whole
// investigation that produced this fix was about not doing.
console.log('--- a cached daily count is carried ONLY inside its own day window');
{
  const { from: dayFrom }  = mod.getDayBounds();
  const { from: weekFrom } = mod.getWeekBounds();
  const todayKey = mod.dayKey(dayFrom);
  const weekKeyNow = mod.dayKey(weekFrom);
  const DAILY = 31;
  const mk = (dk) => {
    const d = {}; for (const tr of TRACKS) d[tr.id] = DAILY;
    return { gone: { pc: 9, ap: 0, t: {}, d, w: {}, dk, wk: weekKeyNow, ts: 0, tFull: 0 } };
  };

  // 5a. same day → carried
  reset();
  statusFor = { gone: 404 };
  const sameDay = await mod.refreshUser(
    entryWith('wd', [lfm('alive2'), lfm('gone')]), null, null, null, mk(todayKey));
  check(sameDay.scores.daily_jump === DAILY,
        'inside today\'s window the cached daily count IS carried',
        `daily_jump=${sameDay.scores.daily_jump}, expected ${DAILY}`);

  // 5b. yesterday → NOT carried
  reset();
  statusFor = { gone: 404 };
  const staleDay = await mod.refreshUser(
    entryWith('wd', [lfm('alive2'), lfm('gone')]), null, null, null, mk('1999-01-01'));
  check(staleDay.scores.daily_jump === 0,
        'a count cached under ANOTHER day contributes 0 to today',
        `daily_jump=${staleDay.scores.daily_jump}, expected 0 — ` +
        'a non-zero here is yesterday\'s plays inside today\'s goal');
  // And the two must actually differ, or this section proves nothing: if both
  // read 0 the window check could be absent and 5a would be the real failure.
  check(sameDay.scores.daily_jump !== staleDay.scores.daily_jump,
        'the two cases really are distinguishable',
        `${sameDay.scores.daily_jump} vs ${staleDay.scores.daily_jump}`);
}

console.log('');
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('All correct.');
