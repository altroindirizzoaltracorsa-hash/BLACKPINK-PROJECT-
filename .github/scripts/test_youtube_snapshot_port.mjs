// THE VERCEL SNAPSHOT MUST BUILD THE SAME ROWS THE PYTHON ONE DOES.
//
// Run: node .github/scripts/test_youtube_snapshot_port.mjs
//
// WHY THIS EXISTS. api/youtube-snapshot.js is a port of
// .github/scripts/snapshot_youtube.py, moved so a Vercel cron can take the
// reading at 00:00 UTC instead of GitHub taking it ~9 hours late (measured:
// scheduled 04:41, ran 13:36 and 13:53 on consecutive days). Both now write
// the same table, and the Python one stays as the backstop. A port that
// disagrees about a single field would corrupt the series silently — the rows
// still arrive, they are just wrong — so the row-building is pinned here
// rather than trusted.
//
// What is checked is buildRows(), because that is where every decision lives:
// the delta, the elapsed hours, and the three NULL-IS-NOT-ZERO fields. The
// Supabase and catalog calls are plumbing and are exercised by running it.
import { readFileSync } from 'node:fs';
import { buildRows } from '../../api/youtube-snapshot.js';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };
const check = (c, m, d) => (c ? ok(m, d) : bad(m, d));

const NOW = Date.parse('2026-11-21T00:00:30Z');   // a punctual midnight reading
const DAY = '2026-11-21';

// ── 1. the delta and the elapsed hours ─────────────────────────────────────
console.log('--- the gain and the gap it was measured over');
{
  const videos = [{ id: 'aaaaaaaaaaa', views: 1_000_000, likes: 10, comments: 5 }];
  const refs   = { aaaaaaaaaaa: 1 };
  const prev   = { 1: [900_000, '2026-11-20T00:00:00Z'] };
  const { rows } = buildRows(videos, refs, prev, NOW, DAY);
  check(rows.length === 1, 'one row per video');
  check(rows[0].daily_delta === 100_000, 'the delta is views minus the previous views',
        `${rows[0].daily_delta}`);
  check(Math.abs(rows[0].hours_since - 24.008) < 0.002,
        'hours_since is the REAL elapsed time, not an assumed 24',
        `${rows[0].hours_since}`);
  check(rows[0].date === DAY, 'the row carries the reading date', rows[0].date);
}

// ── 2. the first reading of a video ────────────────────────────────────────
// NULL, NOT ZERO. A new video has no previous row, and a 0 delta would read as
// "nobody watched it" on the day it is most watched.
console.log('--- a video with no previous reading');
{
  const { rows } = buildRows(
    [{ id: 'bbbbbbbbbbb', views: 5_000, likes: 1, comments: 0 }],
    { bbbbbbbbbbb: 2 }, {}, NOW, DAY);
  check(rows[0].daily_delta === null, 'daily_delta is null, not 0', `${rows[0].daily_delta}`);
  check(rows[0].hours_since === null, 'and hours_since is null too', `${rows[0].hours_since}`);
}

// ── 3. NULL IS NOT ZERO, and 0 IS NOT NULL ─────────────────────────────────
// The half that is easy to get wrong: `v.likes || null` turns a genuine zero
// into a gap, and `?? 0` turns a hidden count into a fact. Both are wrong.
console.log('--- likes and comments: absent vs genuinely zero');
{
  const { rows } = buildRows([
    { id: 'ccccccccccc', views: 10, likes: 0, comments: 0 },          // really zero
    { id: 'ddddddddddd', views: 10 },                                  // hidden / off
  ], { ccccccccccc: 3, ddddddddddd: 4 }, {}, NOW, DAY);
  const zero = rows.find(r => r.video_ref === 3);
  const miss = rows.find(r => r.video_ref === 4);
  check(zero.like_count === 0,    'a real 0 like count stays 0',        `${zero.like_count}`);
  check(zero.comment_count === 0, 'a real 0 comment count stays 0',     `${zero.comment_count}`);
  check(miss.like_count === null, 'a hidden like count is null',        `${miss.like_count}`);
  check(miss.comment_count === null, 'comments switched off is null',   `${miss.comment_count}`);
}

// ── 4. YouTube recounts, and a negative delta is real ──────────────────────
console.log('--- a negative delta is kept, not clamped');
{
  const { rows } = buildRows(
    [{ id: 'eeeeeeeeeee', views: 900, likes: 1, comments: 1 }],
    { eeeeeeeeeee: 5 }, { 5: [1000, '2026-11-20T00:00:00Z'] }, NOW, DAY);
  check(rows[0].daily_delta === -100,
        'YouTube purges bot views; clamping would hide it', `${rows[0].daily_delta}`);
}

// ── 5. a bogus gap is refused ──────────────────────────────────────────────
// Clock skew or two readings at the same instant. A rate cannot come from it,
// and a wrong hours_since is worse than none because the page DIVIDES by it.
console.log('--- a non-positive gap gives no hours_since');
{
  const { rows } = buildRows(
    [{ id: 'fffffffffff', views: 10, likes: 1, comments: 1 }],
    { fffffffffff: 6 }, { 6: [5, '2026-11-22T00:00:00Z'] }, NOW, DAY);  // "previous" is later
  check(rows[0].hours_since === null, 'hours_since is null rather than negative',
        `${rows[0].hours_since}`);
  check(rows[0].daily_delta === 5, 'but the delta is still recorded', `${rows[0].daily_delta}`);
}

// ── 6. a video with no row id is skipped and counted ───────────────────────
console.log('--- a video the upsert did not return is skipped, not guessed');
{
  const { rows, skipped } = buildRows(
    [{ id: 'ggggggggggg', views: 1 }, { id: 'hhhhhhhhhhh', views: 2 }],
    { ggggggggggg: 7 }, {}, NOW, DAY);
  check(rows.length === 1 && skipped === 1, 'one written, one skipped',
        `${rows.length}/${skipped}`);
}

// ── 7. the two implementations agree on the field set ──────────────────────
// A port that writes a column the other does not, or spells one differently,
// produces rows that look fine and are missing data. Read the Python's own
// literal rather than restating it here.
console.log('--- the same columns as snapshot_youtube.py writes');
{
  const py = readFileSync(root + '.github/scripts/snapshot_youtube.py', 'utf8');
  const block = py.slice(py.indexOf('rows.append({', py.indexOf('def build_rows')));
  const pyFields = new Set([...block.slice(0, block.indexOf('})')).matchAll(/"(\w+)":/g)].map(m => m[1]));
  const { rows } = buildRows([{ id: 'iiiiiiiiiii', views: 1, likes: 1, comments: 1 }],
                             { iiiiiiiiiii: 9 }, {}, NOW, DAY);
  const jsFields = new Set(Object.keys(rows[0]));
  const onlyPy = [...pyFields].filter(f => !jsFields.has(f));
  const onlyJs = [...jsFields].filter(f => !pyFields.has(f));
  check(pyFields.size >= 7, 'read the python row literal', `${pyFields.size} fields`);
  check(onlyPy.length === 0, 'nothing the python writes is missing here', onlyPy.join(', ') || 'none');
  check(onlyJs.length === 0, 'and nothing extra is written', onlyJs.join(', ') || 'none');
}

// ── 8. the backstop cannot clobber the punctual reading ────────────────────
// Without this guard the ~9-hours-late GitHub run would overwrite the midnight
// row every day and silently undo the entire point of the move.
console.log('--- the python backstop skips a date that already has rows');
{
  const py = readFileSync(root + '.github/scripts/snapshot_youtube.py', 'utf8');
  check(/if not FORCE:/.test(py), 'the guard is there and is default-on');
  check(/youtube_video_daily_stats"[\s\S]{0,200}?eq\.\{day\}/.test(py),
        'it asks whether the day already has rows');
  check(/FORCE = os\.environ\.get\("FORCE"\) == "1"/.test(py),
        'FORCE is opt-in, not the default');
  const wf = readFileSync(root + '.github/workflows/youtube-daily-snapshot.yml', 'utf8');
  check(/FORCE: \$\{\{ github\.event\.inputs\.force \}\}/.test(wf),
        'and the workflow can pass it for a deliberate re-run');
  check(!/cron: '41 4 \* \* \*'/.test(wf), 'the old primary slot is gone');
}

// ── 9. the cron is at midnight UTC ─────────────────────────────────────────
console.log('--- the Vercel cron takes the reading at 00:00 UTC');
{
  const vj = JSON.parse(readFileSync(root + 'vercel.json', 'utf8'));
  const c = (vj.crons || []).find(x => x.path.includes('youtube-snapshot'));
  check(!!c, 'the cron exists');
  if (c) check(c.schedule === '0 0 * * *',
               'at 00:00 UTC — the same day boundary as the rest of the site', c.schedule);
}

console.log('');
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('All correct.');
