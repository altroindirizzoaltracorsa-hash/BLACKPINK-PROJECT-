// Every per-track column of user_daily_counts has somewhere to go, and every
// column that exists reaches the two surfaces that read it.
//
// Run: node .github/scripts/test_daily_count_columns.mjs
//
// WHY THIS IS A SEPARATE TEST FROM test_scrobbler_track_lists.
//
// That one covers the LIVE paths: the matchers and the *_all sums. A release
// can pass every line of it and still lose its history, because the durable
// per-user/per-day store is reached by places that each name the column by
// hand, and every one of them is deliberately FORGIVING — wrapped in
// try/catch, or tiered on "did this query error" — so that a column which has
// not been migrated yet cannot take the columns beside it down.
//
// That tolerance is correct, and it is also what makes this failure silent.
// Nothing throws, nothing logs, the run goes green, and the number is computed
// and dropped on the floor. JISOO's ADDICTED did exactly this: the code wrote
// it from release day, the column landed a week later, and for that week the
// badges "Today's Challenge" grid had no ADDICTED row at all — which reads as
// "nobody streamed it", not as a missing column.
//
// WHAT IS CHECKED, and what deliberately is not. Three things, each derived
// from the files rather than listed here:
//
//   A. every column the CRON CLAIMS (its own per-user day object is the claim)
//      must exist: a base column in supabase/user_daily_counts.sql, or a
//      column some migration adds — or be on NO_COLUMN_YET, which is a
//      documented decision rather than an oversight. This is the ADDICTED
//      direction: computed every run, nowhere to put it.
//   B. every column that EXISTS must be in the day object api/user-week.js
//      returns, or the badges grid has no row for it however much it is
//      written. This is the other direction: the column is there and a reader
//      never learned about it, which reads as a flat zero forever.
//   C. every column that EXISTS must be in BOTH halves of the voting rank
//      gate (supabase/vma_user_votes.sql). ADDICTED's own migration had to
//      re-apply that file for exactly this reason: a column missing from the
//      gate makes a fan read as having streamed less than they have, and the
//      gate is what decides eligibility.
//
// NOT CHECKED: which of the three upsert shapes writes a given column. There
// are three legitimate ones — the core write, the grouped new-release write,
// and a per-column isolated write — and pinning a shape would reject the next
// correct one. A column is written from the cron's day object either way, and
// A is what proves it is in there.
//
// Static analysis only. No browser, no network.

import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

// The PRESS PLAY EP has no columns, and that is on the record as an open
// decision rather than a slip: 2026_11_addicted_stream_column.sql says so in
// as many words ("a bigger scope decision than one single ... left to be taken
// deliberately rather than smuggled in beside it"). They are excused from A
// and from nothing else. Taking that decision means adding a migration and
// deleting the ids from here, in that order.
const NO_COLUMN_YET = new Set(['v12', 'cobra', 'tarantino', 'cutuoff', 'sweat']);

const NOT_A_TRACK = new Set(['app_user_id', 'day_key', 'updated_at', 'by_source']);

// ── what columns exist ─────────────────────────────────────────────────────
console.log('--- the columns that exist');
const base = new Set(
  [...(read('supabase/user_daily_counts.sql')
        .match(/create table if not exists public\.user_daily_counts \(([\s\S]*?)\);/) || ['', ''])[1]
      .matchAll(/^\s*([a-z0-9_]+)\s+integer\s/gm)].map((m) => m[1])
);
base.size
  ? ok(`${base.size} base column(s)`, [...base].join(' '))
  : bad('the base table declares columns', 'parser found none, so nothing below means anything');

const migrated = new Map();   // column -> migration filename
for (const f of readdirSync(`${ROOT}/supabase/migrations`).filter((n) => n.endsWith('.sql'))) {
  for (const m of read(`supabase/migrations/${f}`).matchAll(
    /alter\s+table\s+(?:public\.)?user_daily_counts\s+add\s+column\s+if\s+not\s+exists\s+([a-z0-9_]+)\s+integer/gi
  )) if (!migrated.has(m[1])) migrated.set(m[1], f);
}
migrated.size
  ? ok(`${migrated.size} migrated column(s)`, [...migrated.keys()].join(' '))
  : bad('a migration adds at least one column', 'parser found none, so nothing below means anything');

const exists = new Map([...[...base].map((c) => [c, 'base table']), ...migrated]);
const trackCols = [...exists.keys()].filter((c) => !NOT_A_TRACK.has(c));

// ── A. every column the cron claims has somewhere to go ────────────────────
// The object the cron builds per user per day IS the claim: every key in it is
// a number it expects the table to be able to hold. Parsed out of the file, so
// a release added to it is checked by having been added to it.
console.log('\n--- A. every column the cron claims has somewhere to go');
const claimBlock = (read('api/cron-scrobbles.js').match(/const dailyByUser[\s\S]*?by_source:/) || [''])[0];
const claimed = [...claimBlock.matchAll(/^\s{10,}([a-z0-9_]+)\s*:\s*s\.daily_\1\s*\|\|\s*0,/gm)].map((m) => m[1]);
claimed.length
  ? ok(`the cron's day object carries ${claimed.length} track(s)`, claimed.join(' '))
  : bad("found the cron's day object", 'the parser missed it, so this direction proves nothing');

for (const col of claimed) {
  if (exists.has(col))        { ok(`  ${col}`, exists.get(col)); continue; }
  NO_COLUMN_YET.has(col)
    ? ok(`  ${col} has no column, deliberately`)
    : bad(`  ${col} has no column`,
          'the cron computes it every run and throws it away — add a migration, or add it to NO_COLUMN_YET on purpose');
}

// ── B. every column that exists reaches the badges grid ────────────────────
console.log('\n--- B. every column that exists is returned by api/user-week.js');
const uw = read('api/user-week.js');
const dayObj = (uw.match(/days\[row\.day_key\]\s*=\s*\{([\s\S]*?)\n\s*\};/) || ['', ''])[1];
const returned = new Set([...dayObj.matchAll(/^\s*([a-z0-9_]+)\s*:/gm)].map((m) => m[1]));
returned.size
  ? ok(`the day object returns ${returned.size} key(s)`, [...returned].join(' '))
  : bad("found api/user-week.js's day object", 'the parser missed it, so this direction proves nothing');
for (const col of trackCols) {
  returned.has(col)
    ? ok(`  ${col}`)
    : bad(`  ${col}`, 'the column exists and is written, but the grid never asks for it — a flat zero forever');
}

// ── C. every column that exists is inside the voting rank gate ─────────────
// Both halves: the all-time sum is the gate itself, the filtered one is the
// per-row "streams today" beside it. Pinning both is the point.
console.log('\n--- C. every column that exists is in both halves of the vote gate');
const voteSums = [...read('supabase/vma_user_votes.sql')
  .matchAll(/sum\(\(?coalesce\(jump,0\)[\s\S]*?\)\)?\s*(?:as\s+\w+|filter)/gi)].map((m) => m[0]);
voteSums.length === 2
  ? ok('the gate has its two sums')
  : bad('the gate has its two sums', `${voteSums.length} found — the lines below cannot be trusted`);
for (const col of trackCols) {
  const inAll = voteSums.length === 2 && voteSums.every((s) => s.includes(`coalesce(${col},0)`));
  inAll ? ok(`  ${col}`)
        : bad(`  ${col}`, 'missing from the gate, so a fan streaming it reads as having streamed less than they have');
}

console.log(fails ? `\n${fails} FAILED` : '\nAll columns accounted for.');
process.exit(fails ? 1 : 0);
