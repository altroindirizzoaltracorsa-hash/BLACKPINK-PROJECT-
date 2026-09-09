// Asserts that the admin-only endpoints actually refuse unauthenticated callers,
// by importing each handler and calling it — not by reading the source. A gate
// that has quietly stopped gating looks exactly like one that works, and
// `node --check` cannot tell the difference.
import fs from 'fs';

process.env.ADMIN_SECRET = 'S3CRET';
process.env.UPSTASH_REDIS_REST_URL = 'http://stub/pipeline';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
process.env.YOUTUBE_API_KEY = 'yt';
globalThis.fetch = async () => { throw new Error('network reached — the gate let the request through'); };

const ENDPOINTS = [
  ['youtube-history', { ids: 'LzgE8ift2Uw' }],
  ['youtube-stats',   { ids: 'LzgE8ift2Uw' }],
  ['girlgroups',      {} ],
];

let bad = 0;
const check = (label, ok, extra = '') => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`); };

const call = async (mod, query, headers) => {
  let code = 0, body = null;
  const res = { setHeader(){}, status(c){ code = c; return this; },
                json(b){ body = b; return this; }, end(){ return this; } };
  try { await mod.default({ query, headers, method: 'GET' }, res); }
  catch (e) { return { code: -1, body: { error: e.message } }; }
  return { code, body };
};

for (const [name, query] of ENDPOINTS) {
  const url = new URL(`../../api/${name}.js`, import.meta.url).pathname;
  if (!fs.existsSync(url)) { check(`${name}: file exists`, false); continue; }
  const mod = await import(url + '?v=' + Date.now());

  let r = await call(mod, query, {});
  check(`${name}: no key → 401`, r.code === 401, `got ${r.code} ${JSON.stringify(r.body || {}).slice(0, 80)}`);

  r = await call(mod, query, { 'x-admin-secret': 'nope' });
  check(`${name}: wrong key → 401`, r.code === 401, `got ${r.code}`);

  // ?key= must keep working, jobs and the probe rely on it
  r = await call(mod, { ...query, key: 'S3CRET' }, {});
  check(`${name}: correct ?key= gets past the gate`, r.code !== 401, `got ${r.code}`);

  const src = fs.readFileSync(url, 'utf8');
  check(`${name}: no wildcard CORS`, !src.includes("Access-Control-Allow-Origin', '*'"));
}
console.log(bad ? `\n${bad} FAILURES` : '\nall gates hold');
process.exit(bad ? 1 : 0);
