// The scrobble refresh has to stay inside Last.fm's request budget, and nobody
// may be starved when it doesn't.
//
// Run: node .github/scripts/test_scrobble_rate.mjs
//
// WHAT WENT WRONG. refreshUser fired 18 Last.fm calls per account inside one
// Promise.all, 3 accounts at a time, unpaced — ~54 requests in flight, ~70/s
// against a documented ceiling of 5/s. The shared key was exhausted seconds
// into every run, and because the board is walked in a fixed order it was
// always the same prefix that got served:
//
//   2026-11-03 10:08 UTC   refreshed  46 · failed 155  (152 of them error 29)
//   2026-11-02 20:31 UTC   refreshed  88 · failed 112  ( 99 of them error 29)
//
// and the 46 were a strict SUBSET of the 88. When refreshUser throws, the
// caller keeps the user's previous entry, so every one of those 155 rows stayed
// on the board showing last-known numbers. The board looked fine. Three
// quarters of it was frozen, for days, and the first report came from a fan.
//
// HOW THIS IS TESTED. Not by reading the source for a sleep() — a pace is a
// property of the calls as they actually leave, and the thing that broke was
// specifically that code which looked right in isolation behaved differently
// under a Promise.all fan-out. So this builds the REAL module (api/cron-scrobbles.js
// text, with only its two npm imports stubbed), runs the real refreshUser and
// the real handler against a counting Last.fm, and measures.
//
// The stubbing is asserted, not assumed: if the import lines stop matching, the
// harness fails loudly instead of quietly testing a module it never built.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

// ── Build the real module with its two npm imports replaced ──────────────────
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

// An in-memory Redis, so the cursor and the cache behave the way they do in
// production: they survive between runs.
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
built = prelude + built;
// refreshUser and the Last.fm helpers are module-private; the harness is
// generating this file, so it can export them.
built += `
export { lfmFetch, fetchUserPlaycount, fetchTrackPlays, refreshUser, TRACKS, LFM_RATE_PER_SEC };
`;
const dir = mkdtempSync(join(tmpdir(), 'bu-scrobble-'));
const modPath = join(dir, 'cron-scrobbles.mjs');
writeFileSync(modPath, built);

// A high rate so the pacing is measurable in a second rather than a minute.
// The assertion is "never faster than configured", which is the invariant at
// any value.
const RATE = 50;
process.env.LASTFM_RATE_PER_SEC = String(RATE);
process.env.SCROBBLE_RUN_BUDGET_MS = '600000';
delete process.env.CRON_SECRET;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
globalThis.__store = STORE;

const mod = await import('file://' + modPath);
check(typeof mod.refreshUser === 'function', 'harness built the real module', 'refreshUser present');
check(mod.LFM_RATE_PER_SEC === RATE, 'the rate is configurable', `${mod.LFM_RATE_PER_SEC}/s`);

// ── A counting, scriptable Last.fm ───────────────────────────────────────────
let calls = [];           // { method, at }
let playcount = 1000;
let rateLimitOnce = null; // a method name to answer once with error 29
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const q = new URL(url).searchParams;
  const method = q.get('method');
  calls.push({ method, user: q.get('user') || q.get('username'), at: Date.now() });
  if (rateLimitOnce === method) {
    rateLimitOnce = null;
    return { ok: true, json: async () => ({ error: 29, message: 'Rate Limit Exceeded' }) };
  }
  const body =
    method === 'user.getInfo'       ? { user: { playcount: String(playcount) } } :
    method === 'artist.getInfo'     ? { artist: { stats: { userplaycount: '500' } } } :
    method === 'track.getInfo'      ? { track: { userplaycount: '7' } } :
    method === 'user.getRecentTracks' ? { recenttracks: { track: [], '@attr': { totalPages: '1' } } } :
    {};
  return { ok: true, json: async () => body };
};
const reset = () => { calls = []; };
const of = m => calls.filter(c => c.method === m).length;

const entry = u => ({ username: u, displayName: u, linkedAccounts: [{ type: 'lastfm', username: u }], scores: {} });

// ── 1. The pace holds under a Promise.all fan-out ────────────────────────────
// The old code's whole problem: each call was fine, 54 at once were not.
console.log('--- the request pace holds however many callers fire at once');
{
  reset();
  const N = 60;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: N }, () => mod.fetchTrackPlays('u', 'BLACKPINK', 'JUMP')));
  const span = Date.now() - t0;
  const observed = N / (span / 1000);
  check(observed <= RATE * 1.25, `${N} concurrent calls left at ${observed.toFixed(1)}/s, cap ${RATE}/s`,
        `${span}ms`);
  // And the gap between consecutive departures is real, not all of them at t0.
  const sorted = calls.map(c => c.at).sort((a, b) => a - b);
  const bunched = sorted.filter((t, i) => i > 0 && t - sorted[i - 1] === 0).length;
  check(bunched < N / 2, 'the calls are spaced, not released in one burst',
        `${bunched}/${N - 1} gaps were 0ms`);
}

// ── 2. An idle account costs ONE request, not eighteen ───────────────────────
console.log('--- an account that has not scrobbled costs one request');
{
  STORE.clear();
  reset();
  const cache = {};
  await mod.refreshUser(entry('alice'), null, null, null, cache);
  const first = calls.length;
  check(of('track.getInfo') === mod.TRACKS.length,
        `a first read fetches every tracked title`, `${of('track.getInfo')} of ${mod.TRACKS.length}`);
  check(!!cache.alice && Number.isFinite(cache.alice.pc), 'and it caches the playcount it gated on',
        `pc=${cache.alice?.pc}`);

  reset();
  await mod.refreshUser(entry('alice'), null, null, null, cache);
  check(calls.length === 1, 'the next run with nothing scrobbled costs 1 request',
        `${calls.length} (was ${first})`);
  check(of('user.getInfo') === 1 && of('track.getInfo') === 0,
        'and that one request is the playcount gate');
}

// ── 3. ...but a scrobble is never missed ─────────────────────────────────────
// The gate has to be a gate, not an off switch.
console.log('--- an account that HAS scrobbled is fully re-read');
{
  const cache = {};
  reset(); await mod.refreshUser(entry('bob'), null, null, null, cache);
  playcount += 1;                       // bob played something
  reset();
  const out = await mod.refreshUser(entry('bob'), null, null, null, cache);
  check(of('track.getInfo') === mod.TRACKS.length,
        'every tracked title is re-read after a scrobble', `${of('track.getInfo')}`);
  check(out.scores.overall_jump === 7, 'and the fresh figure is the one stored',
        `overall_jump=${out.scores.overall_jump}`);
}

// ── 4. A release added to TRACKS is never served as a cached zero ────────────
// The failure this guards: the cache is keyed on "did they scrobble", which a
// new entry in TRACKS does not change — so a stale entry would answer 0 for the
// new song for every idle fan, indefinitely.
console.log('--- a track the cache predates forces a re-read');
{
  const cache = {};
  reset(); await mod.refreshUser(entry('cleo'), null, null, null, cache);
  const newest = mod.TRACKS[mod.TRACKS.length - 1].id;
  delete cache.cleo.t[newest];          // what a pre-release cache entry looks like
  reset();
  const out = await mod.refreshUser(entry('cleo'), null, null, null, cache);
  check(of('track.getInfo') === mod.TRACKS.length,
        'a cache entry missing a tracked title is refetched, not trusted', `${of('track.getInfo')}`);
  check(out.scores[`overall_${newest}`] === 7,
        `and ${newest} reports its real total, not 0`, `${out.scores[`overall_${newest}`]}`);
}

// ── 5. A day rollover re-derives the windowed counts, and only those ──────────
// A scrobble can fall OUT of the day window with no new one arriving, so the
// playcount gate alone would keep yesterday's daily counts.
console.log('--- a rolled-over day re-derives the day counts without re-reading totals');
{
  const cache = {};
  reset(); await mod.refreshUser(entry('dina'), null, null, null, cache);
  cache.dina.dk = '1999-01-01';         // the cache is from another day
  reset();
  await mod.refreshUser(entry('dina'), null, null, null, cache);
  check(of('user.getRecentTracks') >= 1, 'the week range is re-fetched', `${of('user.getRecentTracks')}`);
  check(of('track.getInfo') === 0, 'but the all-time totals are not re-read again');
  check(calls.length <= 3, 'so a rollover costs ~2 requests, not 18', `${calls.length}`);
}

// ── 6. error 29 is survivable, and it slows EVERYONE down ────────────────────
// It was absent from LASTFM_RETRYABLE_ERRORS, so a rate limit threw straight
// out of the user's Promise.all and lost all 18 of that user's figures.
console.log('--- a rate limit is retried, and backs the whole run off');
{
  reset();
  rateLimitOnce = 'artist.getInfo';
  let threw = null;
  try { await mod.fetchUserPlaycount('erin'); } catch (e) { threw = e; }
  check(!threw, 'a normal call still succeeds alongside the scripted limit');

  reset();
  rateLimitOnce = 'artist.getInfo';
  const t0 = Date.now();
  let value = null, err = null;
  try { value = await mod.lfmFetch({ method: 'artist.getInfo', artist: 'BLACKPINK', username: 'erin' }); }
  catch (e) { err = e; }
  const waited = Date.now() - t0;
  check(!err && !!value, 'error 29 is retried rather than thrown', err ? err.message : 'recovered');
  check(waited >= 1800, 'and the retry waits seconds, not milliseconds', `${waited}ms`);
  check(of('artist.getInfo') === 2, 'exactly one retry was needed', `${of('artist.getInfo')} calls`);
}

// ── 7. NOBODY IS STARVED: the cut-off rotates ────────────────────────────────
// The heart of it. Give the handler a board it cannot finish in one run and
// check that the users it misses are the ones the NEXT run starts with — so
// every user is reached over successive runs instead of the same tail never
// being reached at all.
console.log('--- a run that cannot finish resumes where it stopped');
{
  STORE.clear();
  const names = Array.from({ length: 12 }, (_, i) => `fan${String(i).padStart(2, '0')}`);
  const users = {};
  for (const n of names) users[n] = entry(n);
  STORE.set('bu_leaderboard_v1', { users, banned: [] });

  // A budget that stops the run partway: the pace is 50/s and a first read is
  // ~18 calls per user, so ~360ms of budget reaches roughly the first user or two.
  process.env.SCROBBLE_RUN_BUDGET_MS = '400';

  const seen = new Set();
  const starts = [];
  for (let run = 0; run < 14; run++) {
    reset();
    let body = null;
    const res = { setHeader() {}, status() { return this; }, json(b) { body = b; return this; } };
    await mod.default({ headers: {} }, res);
    if (!body) { bad('the handler answered', `run ${run}`); break; }
    starts.push(body.startedFrom || names[0]);
    for (const u of body.refreshed || []) seen.add(u);
  }
  check(seen.size === names.length,
        `every user was refreshed within 14 partial runs`, `${seen.size}/${names.length}`);
  check(new Set(starts).size > 1, 'and the starting point moved between runs',
        `${new Set(starts).size} distinct starts: ${[...new Set(starts)].slice(0, 6).join(', ')}`);

  // The specific old bug: run after run beginning at the same user.
  check(!(starts.length > 3 && new Set(starts).size === 1),
        'the run never restarts from the same user every time');
  process.env.SCROBBLE_RUN_BUDGET_MS = '600000';
}

// ── 7b. ...and on the day when the cache cannot help ─────────────────────────
// 7 on its own is too kind. With most of the board idle, the one-request gate
// makes the prefix so cheap that the run reaches the tail anyway, so coverage
// there passes even with the rotation taken out. The day that matters is a
// RELEASE day: everybody is scrobbling, nobody is idle-gated, every user costs
// a full read, and a budget-limited run reaches a fixed prefix and no further.
// That is the exact shape of the outage, and only the rotation answers it.
console.log('--- on a day when everyone is active, the tail is still reached');
{
  STORE.clear();
  const names = Array.from({ length: 10 }, (_, i) => `live${String(i).padStart(2, '0')}`);
  const users = {};
  for (const n of names) users[n] = entry(n);
  STORE.set('bu_leaderboard_v1', { users, banned: [] });

  // Nobody is ever idle: the library grows on every gate call, so the cache can
  // never shortcut anyone and each user costs a full read.
  const alwaysActive = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (new URL(url).searchParams.get('method') === 'user.getInfo') playcount += 1;
    return alwaysActive(url);
  };
  process.env.SCROBBLE_RUN_BUDGET_MS = '400';

  const seen = new Set();
  for (let run = 0; run < 12; run++) {
    let body = null;
    const res = { setHeader() {}, status() { return this; }, json(b) { body = b; return this; } };
    await mod.default({ headers: {} }, res);
    for (const u of body?.refreshed || []) seen.add(u);
  }
  globalThis.fetch = alwaysActive;
  check(seen.size === names.length,
        'every active user is reached over successive partial runs',
        `${seen.size}/${names.length}` + (seen.size < names.length
          ? ` — never reached: ${names.filter(n => !seen.has(n)).join(', ')}`
          : ''));
  process.env.SCROBBLE_RUN_BUDGET_MS = '600000';
}

// ── 8. The run reports the shape of its own failure ──────────────────────────
// The outage was green in Actions for days. The body now has to carry enough
// for the workflow to go red on it.
console.log('--- the response says enough to alert on');
{
  STORE.clear();
  STORE.set('bu_leaderboard_v1', { users: { solo: entry('solo') }, banned: [] });
  let body = null;
  const res = { setHeader() {}, status() { return this; }, json(b) { body = b; return this; } };
  await mod.default({ headers: {} }, res);
  check(Number.isFinite(body.lastfmCalls) && body.lastfmCalls > 0,
        'it reports how many Last.fm calls it spent', `${body.lastfmCalls}`);
  check(body.rateLimited === 0, 'and how many users were rate-limited', `${body.rateLimited}`);
  check('stoppedAt' in body, 'and whether it finished the board',
        body.stoppedAt ? `stopped at ${body.stoppedAt}` : 'finished');
}

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
