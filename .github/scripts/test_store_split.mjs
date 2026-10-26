// Which endpoints talk to which Redis database.
//
// Run: node .github/scripts/test_store_split.mjs
//
// Upstash suspended the primary database on 2026-10-24 for exceeding its free
// monthly bandwidth. A free plan cannot export or browse a suspended database,
// so the data is intact but unreachable until the allowance resets on the 1st.
//
// The way back without paying is a SECOND free database, holding the endpoints
// whose data rebuilds itself, while the leaderboard keeps pointing at the
// primary and simply stays down. That is not timidity about the leaderboard —
// cron-scrobbles reads bu_leaderboard_v1, mutates it and writes it back rather
// than recomputing it from Supabase, so an empty store would start it at zero
// and never self-heal. Left alone it comes back whole, with nothing to merge.
// (The listening data itself is never at risk either way: ingest-scrobble.js
// writes straight to Supabase and has never touched Redis.)
//
// THE INVARIANT THAT MATTERS: no key family may be touched by files on both
// sides. Split one and half its writes land in a database the other half
// cannot see — a bug with no error message, which surfaces as data that is
// simply missing, or silently stale, depending on which side read last.
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// Endpoints on the SECOND database: caches, and series that regenerate on their
// own cron. Losing their history costs resolution, never correctness.
const SECONDARY = new Set([
  'streams', 'playlist', 'shazam-stats', 'kcharts-live', 'sync-playlist',
  'spotify-auth', 'youtube-history', 'youtube-stats', 'girlgroups', 'proxy-image',
  // Only Redis use is a debug log, already wrapped in "never break ingest over
  // a debug write" — it carries nothing worth stranding on a locked database.
  'ingest-scrobble',
  'statsfm',
  // Read-only diagnostic; follows whichever database is configured.
  'redis-report',
]);
// Endpoints that must stay on the PRIMARY, whatever else moves.
// Votes, like the leaderboard, cannot be merged back from two stores after the
// fact — a tally split across a week is not a tally. It waits instead.
const PRIMARY = new Set(['leaderboard', 'cron-scrobbles', 'beta', 'mama-votes']);

const read = n => readFileSync(`${root}api/${n}.js`, 'utf8');
const all = readdirSync(`${root}api`).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
const usesRedis = n => /UPSTASH|@upstash\/redis/.test(read(n));

console.log('--- every Redis-backed endpoint is assigned to exactly one database');
for (const n of all.filter(usesRedis)) {
  const inS = SECONDARY.has(n), inP = PRIMARY.has(n);
  check(inS !== inP, `api/${n}.js is on exactly one side`,
        inS && inP ? 'listed on both' : (!inS && !inP ? 'listed on neither — decide before it ships' : (inS ? 'secondary' : 'primary')));
}

console.log('\n--- the primary group never reaches for the second database');
// If the leaderboard ever resolves to B it starts from zero, which is the one
// outcome this whole arrangement exists to avoid.
for (const n of PRIMARY) {
  const s = read(n);
  check(!/_B\b|redisClient|storeUrl|storeToken/.test(s.replace(/_BASE/g, '')),
        `api/${n}.js resolves the primary only`);
}

console.log('\n--- the secondary group actually honours the B variables');
for (const n of SECONDARY) {
  const s = read(n);
  const viaSdk = /redisClient\(\)/.test(s) && /UPSTASH_REDIS_REST_URL_B/.test(s);
  const viaRaw = /storeUrl\(\)/.test(s) && /UPSTASH_REDIS_REST_URL_B/.test(s);
  check(viaSdk || viaRaw, `api/${n}.js reads UPSTASH_REDIS_REST_URL_B when set`);
  // A configured-check that still tests the primary would gate on the wrong
  // database: the endpoint would refuse to run while B is perfectly healthy.
  // The helper's own `|| process.env.UPSTASH_REDIS_REST_URL` IS the fallback and
  // must stay; what must not survive is a call site that reads the primary
  // directly and so ignores the split.
  const callSites = s.split('\n')
    .filter(l => !/^(const storeUrl|const storeToken)\b/.test(l.trim()) && !/return Redis\.fromEnv\(\);/.test(l))
    .join('\n');
  check(!/process\.env\.UPSTASH_REDIS_REST_(URL|TOKEN)\b(?!_B)/.test(callSites),
        `api/${n}.js has no call site reading the primary var directly`,
        (callSites.match(/process\.env\.UPSTASH_REDIS_REST_(URL|TOKEN)\b(?!_B)/g) || []).slice(0, 2).join(', '));
}

console.log('\n--- the helpers are called, not referenced');
// They are functions so that a redeploy is not needed to change databases, and
// a function used where a string is expected fails silently in the two worst
// ways: `${storeUrl}` interpolates the SOURCE OF THE FUNCTION into the URL, and
// `if (!storeUrl)` is always false, so the not-configured guard never fires.
// Caught in review on api/statsfm.js, which had both.
for (const n of SECONDARY) {
  const s = read(n);
  const bare = s.match(/\$\{\s*store(Url|Token)\s*\}|[!(=]\s*store(Url|Token)\s*[)&|=]/g) || [];
  check(bare.length === 0, `api/${n}.js calls the helpers`, bare.slice(0, 3).join(', '));
}

console.log('\n--- and the fallback still works: no B vars set means one database');
{
  // Both must be present. Half a configuration pointing half an endpoint at a
  // database with no token is worse than not splitting at all.
  const s = read('streams');
  check(/url && token/.test(s), 'the client requires BOTH B variables before switching');
  check(/return Redis\.fromEnv\(\);/.test(s), 'and falls back to the primary otherwise');
}

console.log('\n--- no key family spans the two databases');
{
  const owner = {};           // key family -> Set of sides
  const where = {};           // key family -> Set of files
  for (const n of all.filter(usesRedis)) {
    const side = SECONDARY.has(n) ? 'secondary' : PRIMARY.has(n) ? 'primary' : '?';
    for (const m of read(n).match(/['"`](bp_[a-z0-9_]*|bu_[a-z0-9_]*|shazam:[a-z0-9:]*)/g) || []) {
      const k = m.slice(1);
      (owner[k] = owner[k] || new Set()).add(side);
      (where[k] = where[k] || new Set()).add(n);
    }
  }
  const split = Object.entries(owner).filter(([, sides]) => sides.size > 1);
  check(split.length === 0, 'no key is written on one side and read on the other',
        split.length ? split.map(([k]) => `${k} (${[...where[k]].join(' + ')})`).join('; ') : `${Object.keys(owner).length} families checked`);
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
