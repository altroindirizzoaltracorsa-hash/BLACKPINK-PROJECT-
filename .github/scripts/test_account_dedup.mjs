// ONE LINKED ACCOUNT IS COUNTED ONCE, however it is spelled.
//
// Run: node .github/scripts/test_account_dedup.mjs
//
// WHAT WAS FOUND, 2026-11-20. A real leaderboard row carried the same Stats.fm
// account twice:
//
//     [('statsfm', 'epp399…'), ('statsfm', '@epp399…')]
//
// MEASURED BEFORE CHANGING ANYTHING, because the obvious reading was wrong.
// The suspicion was a double count. It was not:
//
//     bare handle  -> today.sunshowers = 13, full payload
//     '@' handle   -> today: undefined, tracks: undefined
//     board stored -> daily_sunshowers = 13
//
// Stats.fm's API does not resolve '@name'. So the duplicate was a DEAD FETCH
// contributing zero, not inflation — 13, not 26.
//
// WHICH IS WHY THE OBVIOUS FIX WAS THE DANGEROUS ONE. Normalising '@name' to
// 'name' makes both spellings resolve, and the refresh loop adds every linked
// account's counts unconditionally — so stripping the '@' on its own would
// have turned a harmless dead entry into a real double count. The fix for a
// bug that did not exist would have manufactured one.
//
// So both halves are pinned here, and the second one is the point:
//   1. a handle with a leading '@' is normalised, so it resolves at all
//   2. the same account on a row twice is counted ONCE
//   3. the skip is REPORTED, not silent
//   4. two DIFFERENT accounts of the same type are both still counted — the
//      dedup must not eat a fan's second real account
//   5. the same name under two different providers is two accounts
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const src = readFileSync(root + 'api/cron-scrobbles.js', 'utf8');
const IMPORTS = [
  "import { Redis } from '@upstash/redis';",
  "import { createClient } from '@supabase/supabase-js';",
];
for (const line of IMPORTS) {
  if (!src.includes(line)) {
    console.log(`  FAIL harness: expected import line not found: ${line}`);
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
export { refreshUser, TRACKS, normHandle };
`;
const dir = mkdtempSync(join(tmpdir(), 'bu-dedup-'));
const modPath = join(dir, 'cron-scrobbles.mjs');
writeFileSync(modPath, built);

process.env.LASTFM_RATE_PER_SEC = '200';
process.env.SCROBBLE_RUN_BUDGET_MS = '600000';
delete process.env.CRON_SECRET;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
globalThis.__store = STORE;

const mod = await import('file://' + modPath);
check(typeof mod.normHandle === 'function', 'harness built the real module');

// ── 1. the normaliser itself ───────────────────────────────────────────────
console.log('--- a leading @ is not part of the handle');
{
  check(mod.normHandle('@epp399') === 'epp399', "'@epp399' -> 'epp399'");
  check(mod.normHandle('  @epp399  ') === 'epp399', 'surrounding spaces go too');
  check(mod.normHandle('epp399') === 'epp399', 'a bare handle is unchanged');
  check(mod.normHandle('@@epp399') === 'epp399', 'a doubled @ is still one handle');
  // An @ INSIDE the name is not a prefix and must survive — some scrobbler
  // handles are email-shaped, and eating the rest would point at nobody.
  check(mod.normHandle('a@b.com') === 'a@b.com', 'an @ inside the name is left alone');
  check(mod.normHandle(null) === '' && mod.normHandle(undefined) === '',
        'a missing handle normalises to empty, not to "null"');
}

// ── A Stats.fm that answers for the bare handle only if asked bare ─────────
// The endpoint now strips the '@' itself, so after the fix BOTH spellings
// resolve — which is exactly the condition under which a missing dedup would
// double count. The mock therefore answers for either spelling.
let sfmCalls = [];
let lfmUsers = [];
const SFM_TODAY = 13;
globalThis.fetch = async (url) => {
  const u = new URL(url, 'https://example.test');
  if (u.pathname.includes('/api/statsfm')) {
    const who = String(u.searchParams.get('user') || '');
    sfmCalls.push(who);
    const bare = who.replace(/^@+/, '');
    if (!bare) return { ok: true, json: async () => ({}) };
    const tracks = {}; const today = {};
    for (const t of mod.TRACKS) { tracks[t.id] = 0; today[t.id] = 0; }
    today[mod.TRACKS[0].id] = SFM_TODAY;
    return { ok: true, json: async () => ({ tracks, today, week: today }) };
  }
  const q = u.searchParams;
  const method = q.get('method');
  if (method) lfmUsers.push(q.get('user') || q.get('username'));
  const body =
    method === 'user.getInfo'   ? { user: { playcount: '1000' } } :
    method === 'artist.getInfo' ? { artist: { stats: { userplaycount: '0' } } } :
    method === 'track.getInfo'  ? { track: { userplaycount: '0' } } :
    method === 'user.getRecentTracks'
      ? { recenttracks: { track: [], '@attr': { totalPages: '1' } } } : {};
  return { ok: true, json: async () => body };
};

const FIRST = mod.TRACKS[0].id;
const run = async (accounts) => {
  STORE.clear(); sfmCalls = []; lfmUsers = [];
  const entry = { username: 'fan', displayName: 'fan', linkedAccounts: accounts, scores: {} };
  return mod.refreshUser(entry, null, null, null, {}, 'https://example.test');
};

// ── 2. the real row: same Stats.fm account under two spellings ─────────────
console.log('--- the same account linked twice is fetched once and counted once');
{
  const out = await run([
    { type: 'statsfm', username: 'epp399nk7yx9nl9qamkdgefh3' },
    { type: 'statsfm', username: '@epp399nk7yx9nl9qamkdgefh3' },
  ]);
  check(sfmCalls.length === 1, 'Stats.fm is asked once, not twice',
        `${sfmCalls.length} call(s): ${JSON.stringify(sfmCalls)}`);
  check(out.scores[`daily_${FIRST}`] === SFM_TODAY,
        'and the plays are counted once',
        `daily_${FIRST}=${out.scores[`daily_${FIRST}`]}, expected ${SFM_TODAY} (${SFM_TODAY * 2} would be the double count)`);
  check(sfmCalls[0] === 'epp399nk7yx9nl9qamkdgefh3',
        'the handle it asks for carries no @', `asked for ${sfmCalls[0]}`);
}

// ── 3. order must not matter ──────────────────────────────────────────────
// If the '@' spelling comes FIRST, the surviving one is the '@' entry — and it
// must still be fetched by its normalised handle, or the row that happens to
// be ordered that way gets a dead fetch and a zero.
console.log('--- and it does not matter which spelling is listed first');
{
  const out = await run([
    { type: 'statsfm', username: '@epp399nk7yx9nl9qamkdgefh3' },
    { type: 'statsfm', username: 'epp399nk7yx9nl9qamkdgefh3' },
  ]);
  check(sfmCalls.length === 1, 'still one fetch', `${sfmCalls.length}`);
  check(sfmCalls[0] === 'epp399nk7yx9nl9qamkdgefh3',
        'and still asked without the @', `asked for ${sfmCalls[0]}`);
  check(out.scores[`daily_${FIRST}`] === SFM_TODAY,
        'and counted once', `daily_${FIRST}=${out.scores[`daily_${FIRST}`]}`);
}

// ── 4. THE DEDUP MUST NOT EAT A SECOND REAL ACCOUNT ───────────────────────
// Fans legitimately link several accounts of the same type — one row in this
// board has four Last.fm handles. A dedup that swallowed those would be a far
// worse bug than the one being fixed.
console.log('--- two DIFFERENT accounts of the same type are both counted');
{
  await run([
    { type: 'statsfm', username: 'alpha' },
    { type: 'statsfm', username: 'beta' },
  ]);
  check(sfmCalls.length === 2, 'both are fetched', `${JSON.stringify(sfmCalls)}`);
}
{
  await run([
    { type: 'lastfm', username: 'one' },
    { type: 'lastfm', username: 'two' },
    { type: 'lastfm', username: 'three' },
  ]);
  const uniq = [...new Set(lfmUsers)];
  check(uniq.length === 3, 'three distinct Last.fm accounts all refresh',
        JSON.stringify(uniq));
}

// ── 5. the same NAME on two providers is two accounts ─────────────────────
console.log('--- the same name under two providers is not a duplicate');
{
  await run([
    { type: 'lastfm',  username: 'samename' },
    { type: 'statsfm', username: 'samename' },
  ]);
  check(lfmUsers.length > 0, 'the Last.fm one is refreshed');
  check(sfmCalls.length === 1, 'and the Stats.fm one is too', JSON.stringify(sfmCalls));
}

// ── 6. the skip is reported, not silent ───────────────────────────────────
console.log('--- a skipped duplicate is reported');
{
  const text = readFileSync(root + 'api/cron-scrobbles.js', 'utf8');
  check(/duplicateAccounts/.test(text), 'the run collects duplicateAccounts');
  check(/duplicateAccounts,/.test(text), 'and returns them in the response body');
  const wf = readFileSync(root + '.github/workflows/refresh-scrobbles.yml', 'utf8');
  check(/duplicateAccounts/.test(wf), 'and the workflow prints them');
}

// ── 7. the endpoint strips it too ─────────────────────────────────────────
// Normalising only in the refresh would leave the badges page and any direct
// caller still asking Stats.fm for '@name' and getting nothing back.
console.log('--- /api/statsfm resolves either spelling');
{
  const sfm = readFileSync(root + 'api/statsfm.js', 'utf8');
  const line = (sfm.match(/const username = [^\n]*/) || [''])[0];
  check(/replace\(\/\^@\+?\/|replace\(\/\^@/.test(line),
        'the endpoint strips a leading @ from ?user=', line.trim().slice(0, 80));
}

console.log('');
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('All correct.');
