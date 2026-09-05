// Actually invoke the handler with fetch + Upstash stubbed. `node --check` only
// proves the file parses — it happily accepted `const parseList = arr = (...)`,
// which turned a function into an array and 500'd the live endpoint.
import fs from 'fs';
const file = new URL('../../api/girlgroups.js', import.meta.url).pathname;
const mod = `${process.env.RUNNER_TEMP || '/tmp'}/_gg_smoke.mjs`;
fs.writeFileSync(mod, fs.readFileSync(file, 'utf8'));

const stored = {};   // artist id -> array of stored JSON strings
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/pipeline')) {
    const cmds = JSON.parse(opts.body);
    return { ok: true, json: async () => cmds.map(c => {
      const [op, k] = c;
      if (op === 'LRANGE') {
        const list = stored[k] || [];
        return { result: c[2] === '-1' ? list.slice(-1) : list };
      }
      if (op === 'RPUSH') { (stored[k] = stored[k] || []).push(c[2]); return { result: stored[k].length }; }
      return { result: 'OK' };
    }) };
  }
  // a kworb page
  const id = String(url).match(/artist\/([A-Za-z0-9]+)_songs/)[1];
  const NAMES = { '41MozSoPIsD1dJM0CLPjZF':'BLACKPINK','7n2Ycct7Beij7Dj7meI4X0':'TWICE',
    '6HvZYsbFfjnjFrWF950C9d':'NewJeans','4SpbR6yFEvexJuaBpgAU5p':'LE SSERAFIM',
    '6YVMFz59CuY7ngCxTxjpxE':'aespa','36cgvBn0aadzOijnjjwqMN':'ILLIT','1SIocsqdEefUTE6XKGUiVS':'BABYMONSTER' };
  return { ok: true, text: async () => `<title>${NAMES[id]} - Spotify Top Songs</title>
    <div>Last updated: 2026/09/04</div><table>
    <tr><th></th><th>Total</th></tr>
    <tr><td>Streams</td><td>17,743,883,583</td></tr>
    <tr><td>Daily</td><td>4,428,295</td></tr>
    <tr><td>Tracks</td><td>109</td></tr></table>` };
};
process.env.ADMIN_SECRET = 'S3CRET';
process.env.UPSTASH_REDIS_REST_URL = 'http://stub/pipeline';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

const handler = (await import(mod + '?v=' + Date.now())).default;
const call = async (query, headers = {}) => {
  let code = 0, body = null;
  const res = { setHeader(){}, status(c){ code = c; return this; }, json(b){ body = b; return this; } };
  await handler({ query, headers }, res);
  return { code, body };
};

let bad = 0;
const check = (label, ok, extra='') => { if (!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${label}${extra?'  '+extra:''}`); };

let r = await call({}, {});
check('read without a key → 401', r.code === 401, `got ${r.code}`);
r = await call({}, { 'x-admin-secret': 'wrong' });
check('read with a wrong key → 401', r.code === 401, `got ${r.code}`);
r = await call({ snapshot: '1' }, {});
check('snapshot without a key → 401', r.code === 401, `got ${r.code}`);

r = await call({ snapshot: '1' }, { 'x-admin-secret': 'S3CRET' });
check('snapshot writes all seven', r.code === 200 && r.body.written.length === 7, JSON.stringify(r.body).slice(0,120));
r = await call({ snapshot: '1' }, { 'x-admin-secret': 'S3CRET' });
check('re-running the same day holds', r.code === 200 && r.body.held.length === 7 && r.body.written.length === 0);

r = await call({}, { 'x-admin-secret': 'S3CRET' });
check('authorised read → 200', r.code === 200, `got ${r.code}`);
check('read returns seven groups', (r.body.groups || []).length === 7);
check('asOf is the streaming day', r.body.asOf === '2026-09-03', r.body.asOf);
const bp = (r.body.groups || []).find(g => g.name === 'BLACKPINK');
check('BLACKPINK ytd derived', bp && bp.ytd === 17743883583 - 16341883583, bp && String(bp.ytd));
check('no wildcard CORS header', !/Access-Control-Allow-Origin/.test(fs.readFileSync(file,'utf8')));
console.log(bad ? `\n${bad} FAILURES` : '\nall checks passed');
process.exit(bad ? 1 : 0);
