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
let artistPlays = 500;
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
    // Mutable, like the playcount. A constant here would make the artist-total
    // check below pass whether the code re-read it or served a stale copy —
    // the two values would simply be equal. See section 3b.
    method === 'artist.getInfo'     ? { artist: { stats: { userplaycount: String(artistPlays) } } } :
    method === 'track.getInfo'      ? { track: { userplaycount: '7' } } :
    method === 'user.getRecentTracks' ? recentTracksBody(q) :
    {};
  return { ok: true, json: async () => body };
};
// A scriptable scrobble history. `from` is served INCLUSIVELY on purpose: the
// delta path passes its watermark as `from`, and Last.fm documents that
// parameter as "after this time" — so serving the boundary row here is what
// proves refreshUser filters it out itself rather than trusting the wording.
let feed = [];   // { name, artistName, uts }
const scrobble = (name, artistName, uts) => ({ name, artistName, uts });
// PAGE SIZE IS SETTABLE SO A FULL READ CAN BE TOLD FROM A DELTA READ.
// It was hardcoded to one page, which made the mock answer every request —
// a twelve-page week sweep and a one-page read forward from the watermark —
// with a single page. A test that cannot tell those apart passes against the
// code that re-paginates the whole week, which is exactly the regression that
// took the live board down on 2026-11-22. Default 200 so every other section
// behaves as before.
let pageSize = 200;
function recentTracksBody(q) {
  const from = parseInt(q.get('from') || '0', 10);
  const to   = parseInt(q.get('to')   || '9999999999', 10);
  const page = parseInt(q.get('page') || '1', 10);
  const sel  = feed.filter(s => s.uts >= from && s.uts < to)
                   .sort((a, b) => b.uts - a.uts);
  const pages = Math.max(1, Math.ceil(sel.length / pageSize));
  const slice = sel.slice((page - 1) * pageSize, page * pageSize);
  return { recenttracks: {
    track: slice.map(s => ({ name: s.name, artist: { '#text': s.artistName }, date: { uts: String(s.uts) } })),
    '@attr': { totalPages: String(pages) },
  } };
}
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
//
// THIS CHECK WAS INVERTED ON 2026-11-19 and the old rule is written down here
// because a silently-flipped assertion is worse than none. It used to require
// that ANY scrobble re-read all 18 titles. That is what made an active account
// cost ~32 requests, and on the release day measured in the delta note in
// api/cron-scrobbles.js one run bought 22 users out of ~210 before its clock
// ran out — so a fan's row could go most of a day without the cron reaching
// it. The rule now is narrower and strictly more accurate: re-read the titles
// the account ACTUALLY PLAYED. A Last.fm track playcount moves when you
// scrobble that track and at no other time, so the other seventeen reads were
// re-fetching numbers that could not have changed.
console.log('--- an account that HAS scrobbled re-reads what it played, and only that');
{
  const now = Math.floor(Date.now() / 1000);
  feed = [];
  const cache = {};
  reset(); await mod.refreshUser(entry('bob'), null, null, null, cache);
  check(Number.isFinite(cache.bob?.ts) && Number.isFinite(cache.bob?.tFull),
        'the first read leaves a watermark and an all-time stamp',
        `ts=${cache.bob?.ts} tFull=${!!cache.bob?.tFull}`);

  feed = [scrobble('JUMP', 'BLACKPINK', now - 120)];
  playcount += 1;                       // bob played something
  reset();
  const out = await mod.refreshUser(entry('bob'), null, null, null, cache);
  check(of('track.getInfo') === 1,
        'one title played, one title re-read', `${of('track.getInfo')} of ${mod.TRACKS.length}`);
  check(of('user.getRecentTracks') === 1,
        'and the week is read forward from the watermark, not from scratch',
        `${of('user.getRecentTracks')} page(s)`);
  check(out.scores.overall_jump === 7, 'and the fresh figure is the one stored',
        `overall_jump=${out.scores.overall_jump}`);
  check(out.scores.daily_jump === 1 && out.scores.weekly_jump === 1,
        'the new play lands in the day and week counts', `daily=${out.scores.daily_jump}`);

  // THE WATERMARK ROW IS NOT COUNTED TWICE. The mock serves `from` inclusively
  // (see recentTracksBody), so this run is handed the same JUMP scrobble again.
  playcount += 1;
  reset();
  const again = await mod.refreshUser(entry('bob'), null, null, null, cache);
  check(again.scores.daily_jump === 1,
        'the boundary scrobble is not added a second time', `daily=${again.scores.daily_jump}`);
}

// ── 3b. THE DELTA MUST AGREE WITH A FULL READ ────────────────────────────────
// The whole risk of accumulating instead of re-deriving is that the running
// total drifts away from the truth and nothing ever says so. So: feed the same
// scrobbles to one account an hour at a time and to another all at once, and
// require the two to come out identical.
console.log('--- an account counted incrementally matches one counted from scratch');
{
  const now  = Math.floor(Date.now() / 1000);
  // "Pink Venom" is LAST on purpose. It is BLACKPINK-credited but not in
  // TRACKS, so the final incremental run touches no tracked title at all — and
  // a delta that decided whether to re-read the artist total from `touched`
  // alone would end on a stale one. Put it anywhere earlier and a later
  // campaign track refreshes the figure by accident, and the check passes
  // while the bug is present.
  const plan = [
    scrobble('JUMP', 'BLACKPINK', now - 500),
    scrobble('Shut Down', 'BLACKPINK', now - 400),
    scrobble('JUMP', 'BLACKPINK', now - 300),
    scrobble('GO', 'BLACKPINK', now - 250),
    scrobble('Pink Venom', 'BLACKPINK', now - 200),   // not a campaign track
  ];

  // Incrementally: one scrobble at a time, a fresh run for each.
  const incCache = {};
  feed = []; await mod.refreshUser(entry('inc'), null, null, null, incCache);
  let incOut = null;
  for (const s of plan) {
    feed = [...feed, s];
    playcount  += 1;
    artistPlays += 1;      // every row in the plan is BLACKPINK-credited
    incOut = await mod.refreshUser(entry('inc'), null, null, null, incCache);
  }

  // From scratch: no cache at all, every scrobble present.
  feed = [...plan];
  const fullOut = await mod.refreshUser(entry('full'), null, null, null, {});

  // EVERY figure, not just the per-track ones. The "Pink Venom" row above is in
  // the plan for this: it is BLACKPINK-credited but not a campaign track, so it
  // moves the artist total while touching nothing in TRACKS — and a delta that
  // decided what to re-read from `touched` alone would leave artistPlays stale
  // and no per-track check would notice.
  const keys = [
    ...mod.TRACKS.flatMap(t => [`daily_${t.id}`, `weekly_${t.id}`, `overall_${t.id}`]),
    ...Object.keys(fullOut.scores).filter(k => /artist|blackpink/i.test(k)),
  ];
  const diff = keys.filter(k => (incOut.scores[k] || 0) !== (fullOut.scores[k] || 0));
  check(diff.length === 0, 'every per-track and artist figure matches',
        diff.length ? diff.map(k => `${k}: ${incOut.scores[k]} vs ${fullOut.scores[k]}`).join(', ')
                    : `${keys.length} figures`);
  check(incOut.scores.overall_artist === fullOut.scores.overall_artist,
        '  including the BLACKPINK artist total, which no tracked title moves',
        `${incOut.scores.overall_artist} vs ${fullOut.scores.overall_artist}`);
  check(Number.isFinite(fullOut.scores.overall_artist) && fullOut.scores.overall_artist === artistPlays,
        '  and that figure really did move during the run, so the check is not vacuous',
        `${fullOut.scores.overall_artist} === ${artistPlays}`);
  check(incOut.scores.daily_jump === 2 && incOut.scores.daily_shutdown === 1 && incOut.scores.daily_go === 1,
        'and they are the real counts, not matching zeroes',
        `jump=${incOut.scores.daily_jump} shutdown=${incOut.scores.daily_shutdown} go=${incOut.scores.daily_go}`);
}

// ── 3c. THE DRIFT IS BOUNDED ─────────────────────────────────────────────────
// Which titles get re-read is decided by OUR matcher (trackKey, which strips
// parentheticals) while the total itself comes from Last.fm's exact-title
// lookup. The two can disagree on a stylized scrobble, and a total skipped on
// that basis would sit stale forever. tFull is what stops forever being the
// answer: once the last COMPLETE read is a day old, the next run does another.
console.log('--- a day-old set of all-time totals is re-read in full');
{
  const now = Math.floor(Date.now() / 1000);
  feed = [];
  const cache = {};
  await mod.refreshUser(entry('gail'), null, null, null, cache);
  cache.gail.tFull = Date.now() - 25 * 60 * 60 * 1000;   // yesterday's full read
  feed = [scrobble('JUMP', 'BLACKPINK', now - 100)];
  playcount += 1;
  reset();
  await mod.refreshUser(entry('gail'), null, null, null, cache);
  check(of('track.getInfo') === mod.TRACKS.length,
        'every title is re-read once the stamp ages out', `${of('track.getInfo')}`);
  check(Date.now() - cache.gail.tFull < 60000, 'and the stamp is renewed',
        `age ${Math.round((Date.now() - cache.gail.tFull) / 1000)}s`);
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


// ── 9. THE NAMES LAST.FM DOES NOT HAVE ───────────────────────────────────────
// About 29 of ~200 rows are not usernames at all — "blackPink@gmail.com", a
// pasted profile URL, "Userlast.fm". Each cost a call and a slice of the run's
// time budget every hour forever, and a run that spends its budget stops
// before the end of the board: those 29 slots were coming out of real blinks
// further down the list.
//
// The two ways a skip list goes wrong are the two things pinned hardest here.
// It must not retire a real account over a bad night at Last.fm (so: 404/403
// only, three in a row), and it must be able to let go (so: one retry a day,
// and a success clears the mark). A skip list that cannot release is worse
// than the waste it removes, because the one fact it hides is its own error.
console.log('--- an account Last.fm does not have stops being asked for');
{
  STORE.clear();
  STORE.set('bu_leaderboard_v1', { users: { ghost: entry('ghost'), real: entry('real') }, banned: [] });
  process.env.SCROBBLE_RUN_BUDGET_MS = '600000';

  // 'ghost' 404s; everyone else is normal.
  const base = globalThis.fetch;
  let mode = '404';
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams;
    const who = q.get('user') || q.get('username');
    if (who === 'ghost') {
      calls.push({ method: q.get('method'), user: who, at: Date.now() });
      return mode === '404'
        ? { ok: false, status: 404, json: async () => ({}) }
        : base(url);
    }
    return base(url);
  };
  const run = async () => {
    reset();
    let body = null;
    const res = { setHeader() {}, status() { return this; }, json(b) { body = b; return this; } };
    await mod.default({ headers: {} }, res);
    return { body, ghostCalls: calls.filter(c => c.user === 'ghost').length };
  };

  const r1 = await run(), r2 = await run(), r3 = await run();
  check(r1.ghostCalls > 0 && r2.ghostCalls > 0 && r3.ghostCalls > 0,
        'it is tried three times before anything is decided',
        `${r1.ghostCalls}/${r2.ghostCalls}/${r3.ghostCalls} calls`);
  check((r3.body.dead || []).length === 0,
        'and is not skipped while that is still happening');

  const r4 = await run();
  check(r4.ghostCalls === 0, 'the fourth run does not call Last.fm for it', `${r4.ghostCalls} calls`);
  check((r4.body.dead || []).some(u => String(u).toLowerCase() === 'ghost'),
        'and says so in the response', JSON.stringify(r4.body.dead));
  check(!(r4.body.failed || []).some(f => f.username === 'ghost'),
        'it is no longer counted as a failure');

  // THE ROW SURVIVES. This is the difference between skipping and deleting,
  // and it is the whole reason this is a skip list.
  const board = STORE.get('bu_leaderboard_v1');
  check(!!(board && board.users && board.users.ghost),
        'the blink keeps their row and their numbers');

  // Everyone else is untouched — the point of the exercise.
  check((r4.body.refreshed || []).length >= 1, 'and the rest of the board still refreshes',
        `${(r4.body.refreshed || []).length} refreshed`);

  // ── It lets go. Age the mark past the daily probe and let the account answer.
  const dead = STORE.get('bu_lfm_dead_v2');
  for (const k of Object.keys(dead || {})) { dead[k].probed = 0; dead[k].last = 0; }
  STORE.set('bu_lfm_dead_v2', dead);
  mode = 'ok';
  const r5 = await run();
  check(r5.ghostCalls > 0, 'a day later it is tried once more', `${r5.ghostCalls} calls`);
  check(!STORE.get('bu_lfm_dead_v2')?.ghost,
        'and an account that comes back is un-skipped for good');

  globalThis.fetch = base;
}

// ── 9b. A BAD NIGHT AT LAST.FM RETIRES NOBODY ────────────────────────────────
// The failure that would make this feature worse than the waste it removes:
// Last.fm having an outage, or throttling us, and the refresh quietly deciding
// that a third of the board does not exist. Only "this account is not here"
// counts, never "I could not reach Last.fm".
console.log('--- a Last.fm outage never retires an account');
{
  STORE.clear();
  STORE.set('bu_leaderboard_v1', { users: { patient: entry('patient') }, banned: [] });
  const base = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams;
    if ((q.get('user') || q.get('username')) === 'patient') {
      calls.push({ method: q.get('method'), user: 'patient', at: Date.now() });
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return base(url);
  };
  for (let i = 0; i < 5; i++) {
    reset();
    const res = { setHeader() {}, status() { return this; }, json() { return this; } };
    await mod.default({ headers: {} }, res);
  }
  check(!STORE.get('bu_lfm_dead_v2')?.patient,
        'five server errors in a row leave the account alone',
        JSON.stringify(STORE.get('bu_lfm_dead_v2') || {}));
  globalThis.fetch = base;
}

// ── 9c. A 403 RETIRES NOBODY EITHER ──────────────────────────────────────────
// REPORTED, not hypothetical. The owner of `blackpinkshazam` found their row
// skipped with "Last.fm has no such account" while
// https://www.last.fm/user/blackpinkshazam plainly exists. markMiss counted
// /HTTP (404|403)/, so a 403 retired the row — and the 403 was not even from
// Last.fm: it came from a Libre.fm handle (`librefm/souralis`) on the same row,
// which under the pre-isolation code aborted the whole fan.
//
// 404 is "no such user", a fact about the account. 403 is REFUSED, a fact
// about the request — a private profile, an edge block, or a service declining
// wholesale. Both Libre.fm handles on the board answer 403, which fits
// libre.fm refusing far better than both accounts having been deleted.
//
// So: isolated by refreshUser (it cannot abort the fan) but NEVER grounds for
// retirement, because a refusal is not an absence and a retired row stops
// being fetched at all.
console.log('--- a 403 is a refusal, not an absence: it retires nobody');
{
  STORE.clear();
  STORE.set('bu_leaderboard_v1', { users: { refused: entry('refused') }, banned: [] });
  const base = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams;
    if ((q.get('user') || q.get('username')) === 'refused') {
      calls.push({ method: q.get('method'), user: 'refused', at: Date.now() });
      return { ok: false, status: 403, json: async () => ({}) };
    }
    return base(url);
  };
  let lastBody = null;
  for (let i = 0; i < 5; i++) {
    reset();
    const res = { setHeader() {}, status() { return this; }, json(b) { lastBody = b; return this; } };
    await mod.default({ headers: {} }, res);
  }
  check(!STORE.get('bu_lfm_dead_v2')?.refused,
        'five 403s in a row leave the row alone',
        JSON.stringify(STORE.get('bu_lfm_dead_v2') || {}));
  // And it is still being ASKED — a retired row is never fetched again, which
  // is what made the reported case invisible to its owner.
  check(calls.filter(c => c.user === 'refused').length > 0,
        'and the row is still being fetched on the fifth run, not skipped',
        `${calls.filter(c => c.user === 'refused').length} calls`);
  check(!(lastBody?.dead || []).some(u => String(u).toLowerCase() === 'refused'),
        'and it is not reported as a skipped row');
  globalThis.fetch = base;
}

// ── A CORRECTED TITLE MUST REACH AN IDLE ACCOUNT ──────────────────────────
// The idle gate serves a cached all-time figure without asking Last.fm. That
// is the whole saving — and it means a figure read under a WRONG SPELLING
// would be served forever to anyone who has stopped scrobbling, which is
// exactly the person a correction needs to reach.
//
// REAL CASE, 2026-11-22. Sun Showers' `track` was corrected from the bare
// title to the suffixed one once Last.fm finished indexing and the two turned
// out to be separate tracks (1,716 listeners against 15 total). Before this
// guard, `covered` checked only that every track ID had a finite cached value
// — and every ID still did, so an idle account would have gone on being
// served the 0 that the wrong spelling produced.
//
// The cache therefore records the spelling it was written under, and a
// mismatch forces a full re-read.
console.log('--- a cache written under a different spelling is not reused');
{
  STORE.clear();
  reset();
  feed = [];
  const cache = {};
  await mod.refreshUser(entry('carol'), null, null, null, cache);
  const sig = cache.carol?.sig;
  check(sig && typeof sig === 'object' && !Array.isArray(sig),
        'the entry records a signature PER TRACK, not one string for the list',
        `${Object.keys(sig || {}).length} entries`);
  check(Object.keys(sig || {}).length === mod.TRACKS.length,
        'one per tracked title', `${Object.keys(sig || {}).length} of ${mod.TRACKS.length}`);
  check(String(sig?.[mod.TRACKS[0].id] || '').includes(mod.TRACKS[0].track),
        'and it records the TITLE, not just the id', mod.TRACKS[0].track);

  // Unchanged playcount and unchanged titles: the idle path, one request.
  reset();
  await mod.refreshUser(entry('carol'), null, null, null, cache);
  check(calls.length === 1, 'an unchanged entry still costs one request', `${calls.length}`);

  // ── ONE RENAMED TITLE COSTS ONE RE-READ, NOT TWENTY ─────────────────────
  // A global signature could only say "something changed", so the only safe
  // response was to re-read every title for every account. Measured live on
  // 2026-11-22: 185 Last.fm calls per user, THREE users in a 150s run — the
  // board would have taken days to come back from a one-word correction.
  {
    const renamed = mod.TRACKS[1];
    cache.carol.sig = { ...cache.carol.sig, [renamed.id]: 'OldArtist\u001fOld Title' };
    reset();
    await mod.refreshUser(entry('carol'), null, null, null, cache);
    check(of('track.getInfo') === 1,
          'exactly the renamed title is re-read',
          `${of('track.getInfo')} call(s) — twenty would be the blunt version`);
    check(String(cache.carol.sig[renamed.id]).includes(renamed.track),
          'and its signature is brought up to date', renamed.track);
  }

  // ── AN ENTRY FROM BEFORE SIGNATURES EXISTED TAKES ONE FULL READ ─────────
  {
    STORE.clear(); reset(); feed = [];
    const legacy = {};
    await mod.refreshUser(entry('dave'), null, null, null, legacy);
    delete legacy.dave.sig;                       // written before signatures
    reset();
    await mod.refreshUser(entry('dave'), null, null, null, legacy);
    check(of('track.getInfo') === mod.TRACKS.length,
          'a signature-less entry re-reads everything, once',
          `${of('track.getInfo')} of ${mod.TRACKS.length}`);
    check(Number.isFinite(legacy.dave.tFull),
          'and THAT is a complete read, so tFull is stamped');
  }

  // ── A PARTIAL RE-READ MUST NOT CLAIM TO BE A COMPLETE ONE ───────────────
  // tFull means "every title read together, just now". Stamping it after
  // re-reading one renamed title would let the delta path go on trusting
  // figures older than it thinks they are.
  {
    STORE.clear(); reset(); feed = [];
    const c2 = {};
    await mod.refreshUser(entry('erin'), null, null, null, c2);
    const before = c2.erin.tFull;
    await new Promise(r => setTimeout(r, 5));
    c2.erin.sig = { ...c2.erin.sig, [mod.TRACKS[2].id]: 'x\u001fy' };
    reset();
    await mod.refreshUser(entry('erin'), null, null, null, c2);
    check(c2.erin.tFull === before,
          'a one-title re-read leaves tFull alone',
          `${before} -> ${c2.erin.tFull}`);
  }

  // ── AND THE WEEK IS STILL NOT RE-PAGINATED ──────────────────────────────
  {
    const now2 = Math.floor(Date.now() / 1000);
    pageSize = 2;
    STORE.clear(); reset();
    feed = [];
    for (let k = 0; k < 8; k++) {
      feed.push(scrobble(mod.TRACKS[0].track, mod.TRACKS[0].artist, now2 - 3600 * (k + 2)));
    }
    const c3 = {};
    await mod.refreshUser(entry('faye'), null, null, null, c3);
    const fullPages = of('user.getRecentTracks');
    check(fullPages > 1, 'the mock really does paginate a full week read',
          `${fullPages} pages — if this is 1 the next check cannot fail`);

    feed.push(scrobble(mod.TRACKS[0].track, mod.TRACKS[0].artist, now2 - 60));
    playcount += 1;
    c3.faye.sig = { ...c3.faye.sig, [mod.TRACKS[1].id]: 'q\u001fr' };
    reset();
    await mod.refreshUser(entry('faye'), null, null, null, c3);
    check(of('user.getRecentTracks') === 1,
          'the week is read forward from the watermark, not re-paginated',
          `${of('user.getRecentTracks')} page request(s), vs ${fullPages} for a full read`);
    pageSize = 200;
  }
  feed = [];
}

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
