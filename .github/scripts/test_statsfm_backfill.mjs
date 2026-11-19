// The Stats.fm backfill recovers lost days, and never adds one twice.
//
// Run: node .github/scripts/test_statsfm_backfill.mjs
//
// WHY THE DOUBLE COUNT IS THE THING UNDER TEST. user_daily_counts holds one
// COMBINED number per track per day, across every scrobbler a fan has. So
// "was Stats.fm already in this row?" cannot be answered from the numbers —
// only from `by_source`, the per-scrobbler split stored beside them. Get that
// wrong and the script silently inflates people's history, which is worse than
// the missing days it set out to fix: an understated fan complains and can be
// checked, an overstated one is never questioned and cannot be undone.
//
// The real script is run as a subprocess with globalThis.fetch replaced, so
// what is exercised is the file that will actually run — its argument
// building, its skip rules and its writes — not a re-implementation.
import { writeFileSync, mkdtempSync } from 'node:fs';
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
const TODAY = d(0), Y1 = d(1), Y2 = d(2), Y3 = d(3);

// ── The world the script runs against ───────────────────────────────────────
//   Y1 — a row that already names Stats.fm in by_source  → must be skipped
//   Y2 — a row with by_source but no Stats.fm entry      → must be topped up
//   Y3 — a row whose by_source is NULL                   → ambiguous, skipped
// and Stats.fm reports 5 JUMP + 2 LWM on every one of them.
const world = {
  rows: [
    { day_key: Y1, app_user_id: 'u1', jump: 30, shutdown: 0, ddududu: 0, ltal: 0, go: 0, lwm: 0,
      by_source: { 'Last.fm · lf': { jump: 25 }, 'Stats.fm · sfmfan': { jump: 5 } } },
    { day_key: Y2, app_user_id: 'u1', jump: 25, shutdown: 0, ddududu: 0, ltal: 0, go: 0, lwm: 0,
      by_source: { 'Last.fm · lf': { jump: 25 } } },
    { day_key: Y3, app_user_id: 'u1', jump: 11, shutdown: 0, ddududu: 0, ltal: 0, go: 0, lwm: 0,
      by_source: null },
  ],
  plays: { jump: 5, lwm: 2 },
};

const stub = join(dir, 'stub.mjs');
writeFileSync(stub, `
const WORLD = ${JSON.stringify(world)};
globalThis.__posts = [];
globalThis.__sfmUrls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v), json: async () => v });
  if (u.includes('/api/statsfm')) {
    globalThis.__sfmUrls.push(u);
    const day = new URL(u).searchParams.get('day');
    // Echo the day back, the way the real endpoint does.
    return json({ customId: 'sfmfan', tracks: {}, today: WORLD.plays, day });
  }
  if (u.includes('/rest/v1/linked_accounts')) {
    return json([{ app_user_id: 'u1', source_username: 'sfmfan' }]);
  }
  if (u.includes('/rest/v1/user_daily_counts')) {
    if ((opts.method || 'GET') === 'POST') {
      globalThis.__posts.push(JSON.parse(opts.body));
      return { ok: true, status: 204, text: async () => '', json: async () => null };
    }
    const days = (u.match(/day_key=in\\.\\(([^)]*)\\)/) || [,''])[1].split(',');
    return json(WORLD.rows.filter(r => days.includes(r.day_key)));
  }
  throw new Error('unexpected fetch: ' + u);
};
process.on('exit', () => {
  try { require('fs').writeFileSync(process.env.POST_LOG,
    JSON.stringify({ posts: globalThis.__posts, sfm: globalThis.__sfmUrls })); } catch {}
});
import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
`);

const postLog = join(dir, 'posts.json');
const run = (env) => {
  const out = execFileSync(process.execPath,
    ['--import', 'file://' + stub, join(root, '.github/scripts/backfill_statsfm_days.mjs')],
    { env: { ...process.env, SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_KEY: 'k',
             DAYS: '3', PACE_MS: '1', POST_LOG: postLog, ...env },
      encoding: 'utf8' });
  let log = { posts: [], sfm: [] };
  try { log = JSON.parse(require('node:fs').readFileSync(postLog, 'utf8')); } catch {}
  return { out, ...log };
};
const { readFileSync } = await import('node:fs');
const require = (await import('node:module')).createRequire(import.meta.url);

console.log('--- a dry run reports, and writes nothing');
let r;
{
  r = run({ WRITE: '' });
  check(r.posts.length === 0, 'nothing was written', `${r.posts.length} POST(s)`);
  check(/DRY RUN/.test(r.out), 'and it says so up front');
  check(/rows that WOULD be written : 1 updated/.test(r.out),
        'exactly one day is reported as recoverable', (r.out.match(/rows that WOULD[^\n]*/) || [])[0]);
}

console.log('\n--- it picks the right day, and leaves the other two alone');
{
  check(/already counted       : 1/.test(r.out),
        'the day whose by_source already names Stats.fm is skipped',
        (r.out.match(/already counted[^\n]*/) || [])[0]);
  check(/AMBIGUOUS, skipped    : 1/.test(r.out),
        'the day with a NULL by_source is skipped rather than guessed at',
        (r.out.match(/AMBIGUOUS[^\n]*/) || [])[0]);
  check(r.out.includes(Y2), `and the day that was really missing it is the one picked`, Y2);
  check(!r.out.includes(`  ${Y1}  `), '  not the already-counted one', Y1);
}

console.log('\n--- today is never touched');
{
  check(!r.sfm.some(u => u.includes(`day=${TODAY}`)),
        'today is not fetched — the hourly cron owns it and a write here would race it',
        TODAY);
  check(r.sfm.every(u => /day=\d{4}-\d{2}-\d{2}/.test(u)),
        'and every request names an explicit day', `${r.sfm.length} request(s)`);
}

console.log('\n--- a real run adds the plays ON TOP of what was there');
{
  r = run({ WRITE: '1' });
  check(r.posts.length === 1, 'one row written', `${r.posts.length}`);
  const row = r.posts[0]?.[0] || {};
  check(row.day_key === Y2 && row.app_user_id === 'u1', 'for the right fan and day',
        `${row.app_user_id} ${row.day_key}`);
  // 25 was already there from Last.fm; Stats.fm adds 5. Not 5, and not 30
  // twice over.
  check(row.jump === 30, 'existing 25 + Stats.fm 5 = 30, not 5 and not 35', `jump=${row.jump}`);
  check(row.lwm === 2, 'and a release the old five-key payload never carried arrives', `lwm=${row.lwm}`);
  check(!!row.by_source?.['Stats.fm · sfmfan'],
        'the marker is written in the SAME row, which is what makes a re-run a no-op');
  check(!!row.by_source?.['Last.fm · lf'], '  and the existing breakdown is preserved, not replaced');
}

console.log('\n--- running it again adds nothing');
{
  // The marker the previous run wrote is now on the row, so the day is skipped.
  world.rows[1].by_source = { 'Last.fm · lf': { jump: 25 }, 'Stats.fm · sfmfan': { jump: 5 } };
  world.rows[1].jump = 30;
  writeFileSync(stub, readFileSync(stub, 'utf8')
    .replace(/^const WORLD = .*$/m, `const WORLD = ${JSON.stringify(world)};`));
  const again = run({ WRITE: '1' });
  check(again.posts.length === 0, 'the second run writes nothing', `${again.posts.length} POST(s)`);
  check(/already counted       : 2/.test(again.out), 'and counts that day as already done',
        (again.out.match(/already counted[^\n]*/) || [])[0]);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
