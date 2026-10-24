// api/youtube-history.js — what the read path actually asks Upstash for.
//
// Run: node .github/scripts/test_youtube_history_reads.mjs
//
// This exists because of a real outage. The read pipeline was built as six
// id-length blocks, and the first one re-fetched whichever of the later blocks
// it resolved to — the identical LRANGE, byte for byte, twice in the same
// pipeline, on every call. It also pulled the FULL hourly series (MAX_POINTS =
// 2400 points per video) on every live poll, forty-five seconds apart, to
// re-derive milestones that were already frozen in bu_yt_ms_*.
//
// None of that was visible in the output. The endpoint returned exactly the
// right JSON the whole time; it just bought it several times over. What it cost
// was Upstash bandwidth — roughly 220 MB an hour with the page open — and on
// 2026-10-24 that used up a 10 GB monthly allowance and got the database
// suspended, which took /streams, the leaderboard, badges, the playlist and the
// Shazam stats down with it.
//
// So the assertions here are about the REQUEST, not the response. A test that
// only checked the response shape passed happily throughout.
//
// The blocks are indexed by position (results[k * n + i]), which is the other
// thing that can break silently: shift a block and every video is served
// another video's pin, or a series where a hash should be. The ordering checks
// below pin each block to the field it feeds.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// Same loader shape as test_collabs_api: the file is evaluated directly so the
// real pipeline construction runs, with `fetch` and `process.env` injected.
// It has no imports today; if it grows one, this throws rather than silently
// testing a half-loaded module.
function load() {
  const src = readFileSync(root + 'api/youtube-history.js', 'utf8');
  const stripped = src.replace(/^export default async function handler/m, 'async function handler');
  const leftover = stripped.match(/^import .*$/gm) || [];
  if (leftover.length) throw new Error('unstubbed import: ' + leftover.join(' / '));
  if (stripped === src) throw new Error('api/youtube-history.js no longer looks the way this test rewrites it');
  return new Function('fetch', 'process', stripped + '\nreturn { handler, MAX_POINTS };');
}

const ID = 'LzgE8ift2Uw';                 // in DEFAULT_IDS and in RELEASE
const SECRET = 'test-admin-secret';
const env = {
  UPSTASH_REDIS_REST_URL: 'https://stub.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'stub',
  ADMIN_SECRET: SECRET,
};

// A point as the snapshot job writes it. Distinct view counts per series so a
// mis-indexed block shows up as the wrong NUMBERS, not just the wrong length.
const hourly = [{ t: 1_000, v: 10 }, { t: 2_000, v: 20 }, { t: 3_000, v: 30 }];
const live = [{ t: 4_000, v: 40 }, { t: 5_000, v: 50 }];
const pin = { t: 2_000, v: 20 };
const superseded = [{ t: 1_500, v: 15, supersededAt: 1 }];
// A crossing already frozen into bu_yt_ms_*. Deliberately a threshold nothing
// in `hourly`/`live` could re-derive, so seeing it in the response proves the
// HGETALL block was read as a hash — and not, say, the series block next to it,
// which parseHash() will happily chew into nonsense rather than reject.
const FROZEN_TH = '1000000';
const frozen = { t: 2_500, v: 1_000_000 };

// Answers one pipeline by matching each command, so the reply always lines up
// with whatever order the handler asked in — a stub that replied positionally
// would mask the exact bug these ordering checks are for.
function reply(cmd) {
  const [op, k, lo] = cmd;
  if (op === 'GET' && k === `bu_yt_24h_${ID}`) return JSON.stringify(pin);
  if (op === 'HGETALL' && k === `bu_yt_ms_${ID}`) return { [FROZEN_TH]: JSON.stringify(frozen) };
  if (op === 'LRANGE' && k === `bu_yt_hist_${ID}`) {
    // Honour a tail request the way Redis would, so a bounded read returns
    // bounded data and the test can tell the two apart.
    const arr = hourly.map(p => JSON.stringify(p));
    return lo === '0' ? arr : arr.slice(Number(lo));
  }
  if (op === 'LRANGE' && k === `bu_yt_live_${ID}`) return live.map(p => JSON.stringify(p));
  if (op === 'LRANGE' && k === `bu_yt_24h_prev_${ID}`) return superseded.map(p => JSON.stringify(p));
  return null;
}

async function call(query) {
  const sent = [];
  const fetchStub = async (_url, opt) => {
    const cmds = JSON.parse(opt.body);
    sent.push(cmds);
    return { json: async () => cmds.map(c => ({ result: reply(c) })) };
  };
  const mod = load()(fetchStub, { env });
  let body = null, status = 0;
  const res = {
    setHeader() {},
    status(s) { status = s; return this; },
    json(j) { body = j; return this; },
    end() { return this; },
  };
  await mod.handler({ method: 'GET', query, headers: { 'x-admin-secret': SECRET } }, res);
  // The last pipeline is the NX heal write; the read is the first one.
  return { status, body, reads: sent[0] || [], all: sent, MAX_POINTS: mod.MAX_POINTS };
}

const fmt = c => c.join(' ');

console.log('--- the pipeline asks for each thing once');
// The regression itself. Two identical commands in one pipeline is always
// waste: Redis has no reason to answer the same question twice in a row, and
// the handler has both answers in hand either way.
for (const q of [{ ids: ID }, { ids: ID, live: '1' }]) {
  const { reads } = await call(q);
  const seen = reads.map(fmt);
  const dupes = seen.filter((c, i) => seen.indexOf(c) !== i);
  check(dupes.length === 0,
        `no command is sent twice (${q.live ? 'live' : 'hourly'} poll)`,
        dupes.length ? 'duplicated: ' + [...new Set(dupes)].join(', ') : `${seen.length} commands`);
}

console.log('\n--- the live poll does not drag the whole hourly series along');
// The expensive half. The live poll runs on a timer while the page sits open,
// so an unbounded read here is paid for over and over; the hourly poll reads
// the full series and does the complete derivation, which is what keeps the
// self-heal honest.
{
  const { reads, MAX_POINTS } = await call({ ids: ID, live: '1' });
  const hist = reads.filter(c => c[0] === 'LRANGE' && c[1] === `bu_yt_hist_${ID}`);
  check(hist.length === 1, 'the hourly series is read exactly once on a live poll', `${hist.length}x`);
  const lo = hist[0] && hist[0][2];
  check(lo !== '0', 'and it is a bounded tail, not the whole list', `lo=${lo}`);
  const tail = Math.abs(Number(lo));
  check(tail > 0 && tail < MAX_POINTS,
        `the tail is smaller than MAX_POINTS (${MAX_POINTS})`, `${tail} points`);
}
{
  const { reads } = await call({ ids: ID });
  const hist = reads.filter(c => c[0] === 'LRANGE' && c[1] === `bu_yt_hist_${ID}`);
  check(hist.length === 1 && hist[0][2] === '0',
        'the hourly poll still reads the FULL series, so derivation and healing stay complete',
        hist[0] ? `lo=${hist[0][2]}` : 'not read');
}

console.log('\n--- each block still lands in the field it feeds');
// Positional indexing is the failure mode that survives a syntax check and a
// response-shape check: every field is populated, just from the wrong block.
{
  const { status, body } = await call({ ids: ID, live: '1' });
  check(status === 200, 'live poll answers 200', String(status));
  check(JSON.stringify(body.videos[ID]) === JSON.stringify(live),
        'live poll serves the FINE series as videos[]',
        JSON.stringify(body.videos[ID]));
  check(body.milestones[ID] && body.milestones[ID].t === pin.t,
        'the 24h pin block lands on milestones[]');
  check(body.milestones[ID] && JSON.stringify(body.milestones[ID].superseded) === JSON.stringify(superseded),
        'the superseded block lands on milestones[].superseded');
  const vm = body.viewMilestones[ID] || {};
  check(JSON.stringify(vm[FROZEN_TH]) === JSON.stringify([frozen]),
        'the frozen-crossings hash lands on viewMilestones[], parsed as a hash',
        JSON.stringify(vm).slice(0, 120));
}
{
  const { body } = await call({ ids: ID });
  check(JSON.stringify(body.videos[ID]) === JSON.stringify(hourly),
        'hourly poll serves the HOURLY series as videos[]',
        JSON.stringify(body.videos[ID]));
}

console.log('\n--- vs.html does not poll faster than the data moves');
// The other half of the same bill, and the half that is not in the API file at
// all. The live chart is grown client-side by poll() every 15s; these two only
// carry the stored series and the frozen pins, and the hourly series gains a
// point about once an hour.
{
  const page = readFileSync(root + 'vs.html', 'utf8');
  const every = name => {
    const m = page.match(new RegExp(`setInterval\\(${name},\\s*([^)]+)\\)`));
    return m ? Math.round(Function(`return (${m[1]})`)() / 1000) : null;
  };
  const hist = every('pollHistory'), hourlyMs = every('pollHourly');
  check(hist !== null && hist >= 120,
        'pollHistory runs no more than once every 2 minutes', `${hist}s`);
  check(hourlyMs !== null && hourlyMs >= 900,
        'pollHourly runs no more than once every 15 minutes', `${hourlyMs}s`);
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
