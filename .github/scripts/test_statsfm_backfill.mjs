// The Stats.fm backfill raises a day to the truth, and never past it.
//
// Run: node .github/scripts/test_statsfm_backfill.mjs
//
// ── THE RULE THIS FILE USED TO TEST, AND WHY IT WAS WRONG ──────────────────
// The first version ADDED the missing Stats.fm figures to the stored row, and
// decided whether to do so from `by_source` — the per-scrobbler split the cron
// writes beside the numbers. This file asserted that rule and passed.
//
// It was wrong because api/leaderboard.js ALSO writes user_daily_counts (its
// live submit path) and never writes by_source. So a day can hold Stats.fm
// plays with no marker: the fan opens /badges, the client POSTs totals that
// already include Stats.fm, and the cron writes no marker because every
// campaign-five count was zero. That is a fan streaming one song outside the
// campaign five — which described most of the plays the first dry run
// proposed to add. The rule was airtight against the cron and blind to the
// other writer.
//
// ── THE RULE NOW ───────────────────────────────────────────────────────────
// Recompute the day from every reachable source and MAX-MERGE. A max can only
// raise a day, so it is safe without knowing what the stored number was made
// of, and an already-counted day recomputes to the same figure and moves
// nothing. No marker is consulted at all. That is what is tested here, with
// the awkward cases the marker version got wrong:
//   · a day already counted through the markerless client path
//   · a day holding a source that cannot be re-fetched (Musicat)
//   · a day where Stats.fm does not answer
//
// The real script runs as a subprocess with globalThis.fetch replaced, so what
// is exercised is the file that will actually run.
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const dir = mkdtempSync(join(tmpdir(), 'bu-bf-'));
const d = n => {
  const t = new Date();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - n))
    .toISOString().slice(0, 10);
};
const TODAY = d(0), D1 = d(1), D2 = d(2), D3 = d(3);

// Stats.fm reports 5 JUMP + 2 LWM every day. Last.fm reports 20 JUMP every day.
// So the truth for any day is jump 25, lwm 2.
//   D1 — stored jump 25: already counted, through a path that left NO marker.
//        Must not move. This is the case that broke the old rule.
//   D2 — stored jump 20: Last.fm only, Stats.fm missing. Must be raised to 25.
//   D3 — stored jump 90: holds Musicat we cannot re-fetch. Must be left alone.
const world = {
  rows: [
    { day_key: D1, app_user_id: 'u1', jump: 25, shutdown: 0, ddududu: 0, ltal: 0, go: 0, lwm: 2, by_source: null },
    { day_key: D2, app_user_id: 'u1', jump: 20, shutdown: 0, ddududu: 0, ltal: 0, go: 0, lwm: 0, by_source: { 'Last.fm · lf': { jump: 20 } } },
    { day_key: D3, app_user_id: 'u1', jump: 90, shutdown: 0, ddududu: 0, ltal: 0, go: 0, lwm: 9, by_source: null },
  ],
};

const stub = join(dir, 'stub.mjs');
const writeStub = (opts = {}) => writeFileSync(stub, `
const WORLD = ${JSON.stringify(world)};
const SFM_ANSWERS = ${opts.sfmSilent ? 'false' : 'true'};
globalThis.__posts = [];
globalThis.__sfm = [];
const json = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v), json: async () => v });
globalThis.fetch = async (url, o = {}) => {
  const u = String(url);
  if (u.includes('/api/statsfm')) {
    const day = new URL(u).searchParams.get('day');
    globalThis.__sfm.push(day);
    if (!SFM_ANSWERS) return { ok: false, status: 502, text: async () => '', json: async () => ({}) };
    return json({ customId: 'sfmfan', tracks: {}, today: { jump: 5, lwm: 2 }, day });
  }
  if (u.includes('ws.audioscrobbler.com') || u.includes('libre.fm')) {
    const q = new URL(u).searchParams;
    if (q.get('method') === 'user.getRecentTracks') {
      // 20 JUMP inside the requested window.
      const from = Number(q.get('from'));
      const track = Array.from({ length: 20 }, () => ({
        name: 'JUMP', artist: { '#text': 'BLACKPINK' }, date: { uts: String(from + 60) } }));
      return json({ recenttracks: { track, '@attr': { totalPages: '1' } } });
    }
    return json({});
  }
  if (u.includes('/rest/v1/rpc/extension_counts')) return json([]);
  if (u.includes('/rest/v1/linked_accounts')) {
    return json([
      { app_user_id: 'u1', source: 'statsfm', source_username: 'sfmfan' },
      { app_user_id: 'u1', source: 'lastfm',  source_username: 'lf' },
    ]);
  }
  if (u.includes('/rest/v1/user_daily_counts')) {
    if ((o.method || 'GET') === 'POST') {
      globalThis.__posts.push(JSON.parse(o.body));
      return { ok: true, status: 204, text: async () => '', json: async () => null };
    }
    const days = (u.match(/day_key=in\\.\\(([^)]*)\\)/) || [,''])[1].split(',');
    return json(WORLD.rows.filter(r => days.includes(r.day_key)));
  }
  throw new Error('unexpected fetch: ' + u);
};
process.on('exit', () => {
  try { require('fs').writeFileSync(process.env.POST_LOG,
    JSON.stringify({ posts: globalThis.__posts, sfm: globalThis.__sfm })); } catch {}
});
import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
`);

const postLog = join(dir, 'posts.json');
const run = (env) => {
  const out = execFileSync(process.execPath,
    ['--import', 'file://' + stub, join(root, '.github/scripts/backfill_statsfm_days.mjs')],
    { env: { ...process.env, SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_KEY: 'k',
             LASTFM_RATE_PER_SEC: '200', DAYS: '3', PACE_MS: '1', POST_LOG: postLog, ...env },
      encoding: 'utf8' });
  let log = { posts: [], sfm: [] };
  try { log = JSON.parse(readFileSync(postLog, 'utf8')); } catch {}
  return { out, ...log };
};

writeStub();

console.log('--- it uses the cron\'s own matcher, not a copy');
let r = run({ WRITE: '' });
{
  // 20 JUMP from Last.fm only lands if the real countByTrack/TRACKS matched
  // them, which only happens if the module really was built.
  check(/jump 20→25/.test(r.out), 'Last.fm 20 + Stats.fm 5 = 25, matched by the real module',
        (r.out.match(/jump \d+→\d+/) || [])[0]);
}

console.log('\n--- a day already counted through a path that left NO marker');
{
  // The case that broke the first version: by_source is NULL and the day is
  // nonetheless complete. The recompute equals the stored figure, so nothing
  // moves — without ever asking what the stored figure was made of.
  check(!r.out.includes(`  ${D1}  `), 'is left exactly as it is', D1);
  check(r.posts.length === 0, 'and the dry run writes nothing anyway');
}

console.log('\n--- a day that really is missing Stats.fm');
{
  check(r.out.includes(`  ${D2}  `), 'is the one picked up', D2);
  check(/days that WOULD be raised : 1/.test(r.out), 'and it is the only one',
        (r.out.match(/days that WOULD[^\n]*/) || [])[0]);
}

console.log('\n--- a day holding a source we cannot re-fetch');
{
  // Musicat pushed this day to 90. The recompute reaches 25, which is lower,
  // so a max leaves it alone. Under-recovery, never corruption.
  check(!r.out.includes(`  ${D3}  `), 'is left alone rather than lowered to what we can see', D3);
  check(/stored already >= truth : 2/.test(r.out),
        'and is reported as such, so the size of that gap is visible',
        (r.out.match(/stored already[^\n]*/) || [])[0]);
}

console.log('\n--- today is never touched');
{
  check(!r.sfm.includes(TODAY), 'the hourly cron owns today; a write here would race it', TODAY);
  check(r.sfm.length === 3, 'exactly the three past days were asked for', r.sfm.join(' '));
}

console.log('\n--- a real run raises the day to the recomputed truth');
{
  const w = run({ WRITE: '1' });
  check(w.posts.length === 1, 'one row written', `${w.posts.length}`);
  const row = w.posts[0]?.[0] || {};
  check(row.day_key === D2, 'the right day', row.day_key);
  // SET to 25, not stored+5. The distinction is the whole point: an add would
  // have made an already-counted day 30.
  check(row.jump === 25, 'jump is SET to the recomputed 25, not stored+5', `jump=${row.jump}`);
  check(row.lwm === 2, 'and a release the old five-key payload never carried arrives', `lwm=${row.lwm}`);
}

console.log('\n--- running it again changes nothing');
{
  world.rows[1].jump = 25; world.rows[1].lwm = 2;   // what the run above wrote
  writeStub();
  const again = run({ WRITE: '1' });
  check(again.posts.length === 0, 'the second run writes nothing', `${again.posts.length} POST(s)`);
}

console.log('\n--- Stats.fm staying silent cannot lower anybody');
{
  // The property that makes this safe to re-run: a missing source makes the
  // recompute smaller, and a max ignores a smaller number.
  world.rows[1].jump = 20; world.rows[1].lwm = 0;
  writeStub({ sfmSilent: true });
  const silent = run({ WRITE: '1' });
  check(silent.posts.length === 0, 'nothing is written when Stats.fm does not answer',
        `${silent.posts.length} POST(s)`);
  check(/Stats.fm no answer      : 3/.test(silent.out), 'and the run says so plainly',
        (silent.out.match(/Stats\.fm no answer[^\n]*/) || [])[0]);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
