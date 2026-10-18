// api/collabs.js — the aggregation behind the collab board.
//
// Run: node .github/scripts/test_collabs_api.mjs
//
// Nothing here can be exercised against a real Supabase from a session, so the
// pure parts are pulled out and run directly. They are also the parts where a
// mistake is invisible: a board that sums one person's days wrongly still
// renders as a perfectly plausible board.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// Same loader shape as test_mama_votes: the handler's one import is stubbed so
// the file can be evaluated without node_modules, and every import has to be
// accounted for rather than only the ones this test knew about.
function load() {
  const src = readFileSync(root + 'api/collabs.js', 'utf8');
  const stripped = src
    .replace(/^import \{ createClient \} from '@supabase\/supabase-js';$/m, '// stubbed by the test')
    .replace(/^export default async function handler/m, 'async function handler')
    .replace(/^export const __test = .*$/m, '');
  const leftover = stripped.match(/^import .*$/gm) || [];
  if (leftover.length) throw new Error('unstubbed import: ' + leftover.join(' / '));
  if (stripped === src) throw new Error('api/collabs.js no longer looks the way this test rewrites it');
  return new Function('createClient', 'process',
    stripped + '\nreturn { kstDay, mondayOf, periodFrom, sumOf, addInto, SLUG_RE };')(
    () => ({}), { env: {} });
}

const api = load();

console.log('--- the KST day, and the week it belongs to');
// 23:30 UTC on the 17th is already the 18th in Seoul. Getting this wrong puts
// a vote in yesterday's bucket for everyone west of Asia, which is most people.
check(api.kstDay(new Date('2026-10-17T23:30:00Z')) === '2026-10-18',
      '23:30 UTC is already tomorrow in Seoul', api.kstDay(new Date('2026-10-17T23:30:00Z')));
check(api.kstDay(new Date('2026-10-17T14:00:00Z')) === '2026-10-17',
      'and 14:00 UTC is not');
// Monday-start. Sunday is the END of its week, not the start of the next —
// the off-by-one that makes "this week" empty every Sunday.
check(api.mondayOf('2026-10-18') === '2026-10-12', 'Sunday belongs to the week that began Monday',
      api.mondayOf('2026-10-18'));
check(api.mondayOf('2026-10-12') === '2026-10-12', 'and Monday is its own week start');
check(api.mondayOf('2026-11-02') === '2026-11-02', 'across a month boundary too',
      api.mondayOf('2026-11-02'));

console.log('--- one period, built from rows');
const rows = [
  { app_user_id: 'a', day: '2026-10-17', votes: 4, cats: { X: 3, Y: 1 }, display_name: null },
  { app_user_id: 'a', day: '2026-10-18', votes: 2, cats: { X: 1, Y: 1 }, display_name: 'ana' },
  { app_user_id: 'b', day: '2026-10-18', votes: 9, cats: { X: 9 }, display_name: 'bee' },
];
const p = api.periodFrom(rows);
check(p.byCat.X === 13 && p.byCat.Y === 2, 'categories are pooled across everybody',
      JSON.stringify(p.byCat));
check(p.total === 15, 'and the total is their sum', String(p.total));
check(p.board.length === 2, 'one line per account, not per row', String(p.board.length));
check(p.board[0].name === 'bee' && p.board[0].votes === 9, 'ordered by votes',
      p.board.map((b) => `${b.name}:${b.votes}`).join(' '));
// a voted on two days; both must land on the one line.
const a = p.board.find((x) => x.name === 'ana');
check(!!a && a.votes === 6, 'a person\'s days are summed onto their line', a && String(a.votes));
check(!!a && a.byCat.X === 4 && a.byCat.Y === 2, 'and so is their category split',
      a && JSON.stringify(a.byCat));
// The first row for `a` had no display_name. A later row that has one must win,
// or the extension writing before a profile has a name blanks it out.
check(!!a, 'a name written later wins over an earlier blank', a ? a.name : 'dropped');

console.log('--- a row\'s votes always equal its own split');
// The table has a CHECK saying exactly this. The API sums the merged map rather
// than adding to the previous total, so a board ordered by `votes` can never
// disagree with the chips printed under it.
const merged = Object.assign({}, { X: 3 }, {});
merged.X += 2; merged.Z = 1;
check(api.sumOf(merged) === 6, 'sumOf matches the map it was built from', String(api.sumOf(merged)));
const into = { X: 1 };
api.addInto(into, { X: 2, Y: 0, Z: -5 });
check(into.X === 3 && into.Y === undefined && into.Z === undefined,
      'and merging drops zero and negative counts', JSON.stringify(into));

console.log('--- what may be used as a category');
for (const [v, want, why] of [
  ['Favorite Music Group or Duo', true, 'a real ballot category'],
  ["Favorite Kids’ Choice", true, 'with a curly apostrophe'],
  ['', false, 'empty'],
  ['<script>x</script>', false, 'markup'],
  ['a'.repeat(100), false, 'absurdly long'],
]) {
  check(api.SLUG_RE.test(v) === want, `${why} is ${want ? 'accepted' : 'refused'}`);
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
