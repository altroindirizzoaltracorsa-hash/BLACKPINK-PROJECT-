// The Redis-backed endpoints, when Redis is not there.
//
// Run: node .github/scripts/test_store_unavailable.mjs
//
// On 2026-10-24 Upstash suspended the database for exceeding its monthly
// bandwidth. Every command came back non-2xx, the SDK threw on each one, and
// because nothing caught it the four endpoints below answered:
//
//     HTTP 500 · 96 bytes
//     A server error has occurred / FUNCTION_INVOCATION_FAILED
//
// That page names nothing. The site's own cards fell back to a seeded July
// snapshot with no error shown, so the whole thing read as a Spotify
// scraper-quota problem, and working out that it was neither the scrapers nor
// the env vars took a dozen probes against the live deployment.
//
// Two distinct failures have to be covered, and only the first is obvious:
//
//   1. module init — Redis.fromEnv() throws when the UPSTASH_* vars are absent,
//      at module scope, so the function dies before the handler is entered.
//   2. request time — the vars are present and init SUCCEEDS, and the calls
//      throw instead. This is the one that actually happened, and a guard
//      written only for (1) would have sailed straight past it. (It is also
//      how /api/shazam-stats could answer 400 for a missing param while
//      500ing the moment it reached a redis call.)
import { readFileSync } from 'node:fs';
import nodeCrypto from 'node:crypto';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// The query each endpoint needs in order to actually REACH a redis call.
// /api/shazam-stats rejects a missing `page` before it touches the store, so
// probing it bare measures the argument check, not the store — which is the
// very distinction that identified this outage (bare: 400, ?page=…: 500).
const FILES = {
  'streams': {},
  'leaderboard': {},
  'playlist': {},
  'shazam-stats': { page: 'blackpink' },
};

// Anything the handler touches on the client throws, however it is reached —
// redis.get, redis.pipeline().exec(), a destructured method. A stub that only
// defined the handful of methods one endpoint happens to call would quietly
// pass the others.
const throwingRedis = () => new Proxy({}, {
  get() { throw new Error('max daily request limit exceeded'); },
});

function load(name, { initThrows }) {
  const src = readFileSync(`${root}api/${name}.js`, 'utf8');
  const stripped = src.replace(/^import \{ Redis \} from '@upstash\/redis';$/m, '// stubbed by the test');
  const leftover = (stripped.match(/^import .*$/gm) || [])
    .filter(l => !/@supabase\/supabase-js|from 'crypto'/.test(l));
  if (leftover.length) throw new Error(`${name}: unstubbed import: ` + leftover.join(' / '));
  if (stripped === src) throw new Error(`api/${name}.js no longer imports Redis the way this test rewrites it`);
  const Redis = {
    fromEnv() {
      if (initThrows) throw new Error('Unable to find environment variable: `UPSTASH_REDIS_REST_URL`');
      return throwingRedis();
    },
  };
  const body = stripped
    .replace(/^import \{ createClient \} from '@supabase\/supabase-js';$/m, '// stubbed by the test')
    .replace(/^import crypto from 'crypto';$/m, '// stubbed by the test')
    .replace(/^export default async function handler/m, 'async function handler')
    .replace(/^export const config = /m, 'const config = ')
    + '\nreturn { handler };';
  return new Function('Redis', 'process', 'fetch', 'createClient', 'crypto', body)(
    Redis,
    { env: { UPSTASH_REDIS_REST_URL: 'https://stub.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'stub' } },
    async () => { throw new Error('no network in this test'); },
    () => ({}),
    nodeCrypto,
  );
}

async function call(name, opts, query) {
  const mod = load(name, opts);
  let body = null, status = 0, sent = false;
  const res = {
    setHeader() {}, get headersSent() { return sent; },
    status(s) { status = s; return this; },
    json(j) { body = j; sent = true; return this; },
    end() { sent = true; return this; },
  };
  try {
    await mod.handler({ method: 'GET', query: query || {}, headers: {} }, res);
    return { status, body, threw: null };
  } catch (e) {
    return { status, body, threw: e };
  }
}

for (const [label, opts] of [
  ['the env vars are missing (module init throws)', { initThrows: true }],
  ['the database is suspended (every call throws)', { initThrows: false }],
]) {
  console.log(`\n--- ${label}`);
  for (const [name, query] of Object.entries(FILES)) {
    const { status, body, threw } = await call(name, opts, query);
    check(!threw, `/api/${name} does not crash the function`, threw ? threw.message : '');
    check(status === 503, `/api/${name} answers 503, not an opaque 500`, `got ${status || 'nothing'}`);
    check(body && body.error === 'store_unavailable',
          `/api/${name} names the cause`, body ? JSON.stringify(body).slice(0, 110) : 'no body');
    // The detail is the whole point — "FUNCTION_INVOCATION_FAILED" is what this
    // replaces, and a 503 with no reason is barely better.
    check(body && typeof body.detail === 'string' && body.detail.length > 0,
          `/api/${name} carries the underlying message`, body ? String(body.detail).slice(0, 80) : '');
  }
}

console.log('\n--- a request that never needs the store is still answered');
// Cheap rejections must not be dragged into the outage: an argument check that
// can be made without the database should still be made. This is also the pair
// of probes that located the fault — same function, 400 when it returns before
// the store and 500 when it reaches it, which is what ruled out the env vars.
{
  const { status, body } = await call('shazam-stats', { initThrows: false }, {});
  check(status === 400 && body && body.error === 'invalid page',
        '/api/shazam-stats still rejects a missing page without touching Redis',
        `${status} ${JSON.stringify(body)}`);
}

console.log('\n--- the stream cards admit when they are not live');
// The other half of the same outage: the cards render a seeded placeholder
// while the API loads, and when the API never answers it just stays there.
{
  const page = readFileSync(root + 'index.html', 'utf8');
  const m = page.match(/\} catch\(e\) \{[\s\S]{0,1600}?\n  \}\n\}\nwindow\.addEventListener\('DOMContentLoaded'/);
  const c = m ? m[0] : '';
  check(!!c, 'found the fetchSpotifyStreams catch block');
  check(/unavailable/i.test(c), 'it tells the reader the live count is unavailable');
  check(/increase-/.test(c) && /history-/.test(c),
        'and it marks BOTH the figure and the chart, not just the count line');
  check(!/Live count coming soon/.test(c),
        '"coming soon" is gone — nothing is coming, it is broken');
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
