// A fan's Stats.fm plays count on days they never open the site — and are
// never counted twice.
//
// Run: node .github/scripts/test_statsfm_sync.mjs
//
// WHAT WAS WRONG. api/cron-scrobbles.js left Stats.fm entirely to
// `providerScores` — whatever the badges page last submitted — on the stated
// grounds that "these providers expose no per-day history to re-derive it, so
// on a later day it's simply 0 until the fan opens their badges again". The
// second half was the lived consequence: open /badges on Monday, stream all
// week, and Tuesday through Sunday counted nothing from Stats.fm. The first
// half was never true — /api/statsfm asks Stats.fm for an explicit window and
// always had; it had simply never been asked for any window but today's.
//
// WHY IT IS DELICATE, and what every case below is really about: the submitted
// `providerScores.overall` is Musicat and Stats.fm ADDED TOGETHER. Once this
// run fetches a fan's Stats.fm itself, there is no way to subtract that half
// back out of a combined number. So "fetch it server-side" is one line and
// "fetch it server-side without double counting anybody" is this file. A
// double count is worse than the bug it replaces: the original understates a
// fan, this would overstate them, and an inflated leaderboard is the kind of
// thing fans notice and nobody can explain afterwards.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

// ── Build the real module, same way test_scrobble_rate.mjs does ──────────────
const src = readFileSync(root + 'api/cron-scrobbles.js', 'utf8');
const IMPORTS = [
  "import { Redis } from '@upstash/redis';",
  "import { createClient } from '@supabase/supabase-js';",
];
for (const line of IMPORTS) {
  if (!src.includes(line)) {
    console.log(`  FAIL harness: expected import line not found: ${line}`);
    console.log('         fix this harness; do not let it pass by testing nothing.');
    process.exit(1);
  }
}
const prelude = `
const Redis = { fromEnv: () => ({ get: async () => null, set: async () => 'OK', del: async () => 1 }) };
const createClient = () => { throw new Error('supabase must not be constructed in this test'); };
`;
let built = src;
for (const line of IMPORTS) built = built.replace(line, '');
built = prelude + built + `\nexport { refreshUser, TRACKS };\n`;
const dir = mkdtempSync(join(tmpdir(), 'bu-sfm-'));
const modPath = join(dir, 'cron-scrobbles.mjs');
writeFileSync(modPath, built);

process.env.LASTFM_RATE_PER_SEC = '200';
const mod = await import('file://' + modPath);
check(typeof mod.refreshUser === 'function', 'harness built the real module', 'refreshUser present');

// ── A Last.fm that reports nothing, and a scriptable Stats.fm ────────────────
// Last.fm is deliberately silent so every number below is traceable to one
// source. If Last.fm contributed, a double count and a correct count could
// look the same.
const SFM_HANDLE = 'sfmfan';
let sfmPayload = null;     // what /api/statsfm answers
let sfmStatus  = 200;
let sfmCalls   = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/statsfm')) {
    sfmCalls.push(u);
    if (sfmStatus !== 200) return { ok: false, status: sfmStatus, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => sfmPayload };
  }
  const q = new URL(u).searchParams;
  const method = q.get('method');
  const body =
    method === 'user.getInfo'         ? { user: { playcount: '0' } } :
    method === 'artist.getInfo'       ? { artist: { stats: { userplaycount: '0' } } } :
    method === 'track.getInfo'        ? { track: { userplaycount: '0' } } :
    method === 'user.getRecentTracks' ? { recenttracks: { track: [], '@attr': { totalPages: '1' } } } :
    {};
  return { ok: true, json: async () => body };
};

const zero = () => Object.fromEntries(mod.TRACKS.map(t => [t.id, 0]));
const withJump = (n) => ({ ...zero(), jump: n });
const ddmmUTC = (d) => `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
const TODAY     = ddmmUTC(new Date());
const YESTERDAY = ddmmUTC(new Date(Date.now() - 86400000));

const entry = (providerScores) => ({
  username: 'fan', displayName: 'fan', scores: {},
  linkedAccounts: [
    { type: 'lastfm',  username: 'fan' },
    { type: 'statsfm', username: SFM_HANDLE },
  ],
  ...(providerScores ? { providerScores } : {}),
});

const run = async (providerScores) => {
  sfmCalls = [];
  return mod.refreshUser(entry(providerScores), null, null, null, {}, 'example.test');
};

// Stats.fm says: 500 of JUMP all time, 7 today, 20 this week.
sfmPayload = { customId: SFM_HANDLE, tracks: withJump(500), today: withJump(7), week: withJump(20), day: null };

console.log('\n--- a fan who has not opened their badges at all');
{
  const out = await run(null);
  check(sfmCalls.length === 1, 'Stats.fm is fetched once, server-side', `${sfmCalls.length} call(s)`);
  check(/weekFrom=\d+/.test(sfmCalls[0] || ''), '  and the week is asked for in the same request',
        (sfmCalls[0] || '').replace(/^.*\/api/, '/api'));
  check(out.scores.overall_jump === 500, 'their all-time Stats.fm plays count', `${out.scores.overall_jump}`);
  check(out.scores.daily_jump === 7, 'their DAY counts — this is the bug being fixed', `${out.scores.daily_jump}`);
  check(out.scores.weekly_jump === 20, 'and their week is the real week, not a copy of the day',
        `${out.scores.weekly_jump}`);
}

console.log('\n--- an OLD submit from a previous day (the reported case)');
{
  // The combined `overall` already holds their Stats.fm all-time as of that
  // visit, and cannot be split. So the all-time comes from the submit and the
  // day/week — which the submit has nothing fresh to say about — comes from
  // this run. Neither is counted twice.
  const out = await run({
    overall: { jump: 500, shutdown: 0, ddududu: 0, ltal: 0, go: 0 },
    today:   { jump: 99,  shutdown: 0, ddududu: 0, ltal: 0, go: 0 },
    dailyDate: YESTERDAY,
    breakdown: [{ source: 'statsfm', username: SFM_HANDLE, today: { jump: 99 } }],
  });
  check(out.scores.overall_jump === 500, 'the all-time figure is counted ONCE, not 1000',
        `${out.scores.overall_jump}`);
  check(out.scores.daily_jump === 7, "yesterday's submitted day is ignored; today's fetch is used",
        `${out.scores.daily_jump}`);
  check(out.scores.weekly_jump === 20, 'and the week likewise', `${out.scores.weekly_jump}`);
}

console.log('\n--- a submit from TODAY, old shape: the day is already in it');
{
  const out = await run({
    overall: { jump: 500, shutdown: 0, ddududu: 0, ltal: 0, go: 0 },
    today:   { jump: 7,   shutdown: 0, ddududu: 0, ltal: 0, go: 0 },
    dailyDate: TODAY,
    breakdown: [{ source: 'statsfm', username: SFM_HANDLE, today: { jump: 7 } }],
  });
  check(out.scores.overall_jump === 500, 'all-time counted once', `${out.scores.overall_jump}`);
  check(out.scores.daily_jump === 7, 'and the day counted once, not 14', `${out.scores.daily_jump}`);
  check(out.scores.weekly_jump === 7, 'and the week once', `${out.scores.weekly_jump}`);
}

console.log('\n--- a NEW-shape submit: Musicat still counts, Stats.fm is skipped');
{
  // The whole point of per-source `overall`. Musicat cannot be fetched here
  // (~41 requests a fan), so losing it would be a real regression.
  const out = await run({
    overall: { jump: 800, shutdown: 0, ddududu: 0, ltal: 0, go: 0 },  // 500 sfm + 300 musicat
    today:   { jump: 11,  shutdown: 0, ddududu: 0, ltal: 0, go: 0 },  // 7 sfm + 4 musicat
    dailyDate: TODAY,
    breakdown: [
      { source: 'statsfm', username: SFM_HANDLE, overall: withJump(500), today: withJump(7) },
      { source: 'musicat', username: 'mcfan',    overall: withJump(300), today: withJump(4) },
    ],
  });
  check(out.scores.overall_jump === 800, 'Musicat 300 + our Stats.fm 500, each once',
        `${out.scores.overall_jump}`);
  check(out.scores.daily_jump === 11, 'and the day: Musicat 4 + our Stats.fm 7',
        `${out.scores.daily_jump}`);
  check(out.scores.weekly_jump === 24, 'and the week: Musicat 4 + our real Stats.fm week 20',
        `${out.scores.weekly_jump}`);
}

console.log('\n--- a release the old five-key payload could not carry');
{
  // providerScores.overall/.today are five keys. Everything since Less Than a
  // Lover was therefore submitted as nothing. The server fetch has no such
  // limit, so a Stats.fm play of Leave With Me now lands.
  sfmPayload = { customId: SFM_HANDLE, tracks: { ...zero(), lwm: 40 }, today: { ...zero(), lwm: 3 },
                 week: { ...zero(), lwm: 9 }, day: null };
  const out = await run({
    overall: { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 },
    today:   { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 },
    dailyDate: TODAY,
    breakdown: [{ source: 'statsfm', username: SFM_HANDLE, today: { jump: 0 } }],
  });
  check(out.scores.overall_lwm === 40, 'Leave With Me all-time arrives', `${out.scores.overall_lwm}`);
  check(out.scores.daily_lwm === 3, 'and its day', `${out.scores.daily_lwm}`);
  sfmPayload = { customId: SFM_HANDLE, tracks: withJump(500), today: withJump(7), week: withJump(20), day: null };
}

console.log('\n--- Stats.fm not answering leaves the fan exactly as they were');
{
  // The failure mode this provider has form for: a throttled scrape writing a
  // confident 0 over a real number. null must mean "not answered", never 0.
  sfmStatus = 502;
  const out = await run({
    overall: { jump: 500, shutdown: 0, ddududu: 0, ltal: 0, go: 0 },
    today:   { jump: 7,   shutdown: 0, ddududu: 0, ltal: 0, go: 0 },
    dailyDate: TODAY,
    breakdown: [{ source: 'statsfm', username: SFM_HANDLE, today: { jump: 7 } }],
  });
  check(out.scores.overall_jump === 500, 'the submitted all-time still stands', `${out.scores.overall_jump}`);
  check(out.scores.daily_jump === 7, 'and the submitted day is NOT zeroed', `${out.scores.daily_jump}`);
  sfmStatus = 200;
}

console.log('\n--- a wrong-day answer is refused rather than filed');
{
  // The backfill asks for a date. If the endpoint ever answered with today's
  // numbers instead, every backfilled day would be written with the same
  // figures and would look like it worked.
  sfmPayload = { customId: SFM_HANDLE, tracks: withJump(500), today: withJump(7), week: withJump(20),
                 day: '2026-01-01' };   // not the day a caller would have asked for
  const out = await run(null);
  check(out.scores.daily_jump === 7,
        'a day-less request is unaffected by the echoed day', `${out.scores.daily_jump}`);
  sfmPayload = { customId: SFM_HANDLE, tracks: withJump(500), today: withJump(7), week: withJump(20), day: null };
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
