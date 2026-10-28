// /vs.html polls some rows fast and some slowly, and merges the two.
//
// Run: node .github/scripts/test_vs_poll_split.mjs
//
// On pay-as-you-go the Upstash bill is the COMMAND COUNT, and one live poll
// costs 5 reads per video. Seven videos every 45s is ~2,800 commands an hour
// for as long as this page is open — the largest single consumer on the
// database. The two teaser rows now come once an hour instead, which takes the
// fast poll to five videos.
//
// THE FAILURE THAT MATTERS IS THE MERGE. `histData` was assigned whole on every
// poll, which was correct while every poll carried every video. The moment one
// poll carries a subset, assigning it wipes the rows that were not in that
// request — the teasers' charts would go blank and refill an hour later, and on
// a page nobody watches continuously that reads as "the teasers stopped
// working", not as a caching bug. Nothing throws.
//
// The second failure is slower: SLOW_ROWS naming video ids instead of row keys.
// Ids go stale the day a teaser is replaced, and the new one silently rejoins
// the fast poll — the saving quietly undoes itself.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const src = readFileSync(root + 'vs.html', 'utf8');

console.log('--- the rows, and which of them are slow');
// The REAL lists out of the page, not a copy kept here.
const rowsSrc = (src.match(/const ROWS = \[[\s\S]*?\];/) || [])[0];
const slowSrc = (src.match(/const SLOW_ROWS = \[[^\]]*\];/) || [])[0];
check(!!rowsSrc, 'found ROWS');
check(!!slowSrc, 'found SLOW_ROWS', (slowSrc || '').trim());

const ROWS = new Function(`${rowsSrc}\nreturn ROWS;`)();
const SLOW_ROWS = new Function(`${slowSrc}\nreturn SLOW_ROWS;`)();
const VIDEOS = ROWS.flatMap(r => r.ids);
const slow = ROWS.filter(r => SLOW_ROWS.includes(r.key)).flatMap(r => r.ids);
const fast = VIDEOS.filter(id => !slow.includes(id));

check(SLOW_ROWS.length > 0, 'at least one row is slow, so the split is live');
check(SLOW_ROWS.every(k => ROWS.some(r => r.key === k)),
      'every slow key names a row that exists',
      SLOW_ROWS.filter(k => !ROWS.some(r => r.key === k)).join(', '));
// Keys, not ids. An id list here goes stale the day a teaser is swapped and the
// replacement silently rejoins the fast poll.
check(SLOW_ROWS.every(k => !/^[A-Za-z0-9_-]{11}$/.test(k)),
      'and names it by ROW KEY, not by video id',
      SLOW_ROWS.join(', '));
check(fast.length + slow.length === VIDEOS.length && slow.length > 0 && fast.length > 0,
      `${fast.length} fast + ${slow.length} slow = ${VIDEOS.length} videos`);
// Nothing may be in both, or it would be paid for twice.
check(!fast.some(id => slow.includes(id)), 'and no video is in both');

console.log('\n--- what that saves, in the unit that is billed');
{
  // 5 Redis reads per video per poll, from api/youtube-history.js.
  const api = readFileSync(root + 'api/youtube-history.js', 'utf8');
  const block = (api.match(/const cmds = ids\.map[\s\S]*?;\n/) || [''])[0];
  const perVideo = (block.match(/ids\.map\(/g) || []).length;
  check(perVideo >= 4, `one poll costs ${perVideo} reads per video`, 'counted from the handler');
  const before = VIDEOS.length * perVideo * 80;   // 80 polls an hour at 45s
  const after  = fast.length * perVideo * 80 + slow.length * perVideo;
  check(after < before, `~${before} commands/hour becomes ~${after}`,
        `${Math.round((1 - after / before) * 100)}% fewer`);
}

console.log('\n--- the fast poll does not wipe the slow rows');
{
  // The assignment itself. A merge is the whole correctness of the split.
  const line = (src.match(/^.*histData\s*=.*d\.videos.*$/m) || [''])[0];
  check(/Object\.assign\(\s*\{\s*\}\s*,\s*histData\s*,\s*d\.videos\s*\)/.test(line)
        || /\{\s*\.\.\.histData\s*,\s*\.\.\.d\.videos\s*\}/.test(line),
        'histData is merged, not replaced', line.trim());

  // And the merge really does preserve a key the second payload omits —
  // checked by running it rather than by reading it.
  const merge = new Function('histData', 'd', `return (${
    (line.match(/histData\s*=\s*(.*?);/) || [])[1]
  });`);
  const kept = merge({ teaser: ['old'], mv: ['a'] }, { videos: { mv: ['b'] } });
  check(kept.teaser && kept.teaser[0] === 'old' && kept.mv[0] === 'b',
        'a row absent from the payload keeps its data', JSON.stringify(kept));
  // histData starts null; the merge has to survive that.
  check(JSON.stringify(merge(null, { videos: { mv: ['b'] } })) === '{"mv":["b"]}',
        'and the first poll works from null');
}

console.log('\n--- the slow rows are fetched once up front, not only in an hour');
{
  check(/pollSlow\(\);\s*\n\s*setInterval\(pollSlow/.test(src),
        'pollSlow runs immediately and then on its interval');
  const ms = (src.match(/const SLOW_MS = ([^;]+);/) || [])[1] || '';
  const val = new Function(`return ${ms};`)();
  check(val >= 30 * 60 * 1000 && val <= 2 * 60 * 60 * 1000,
        `the slow interval is ${Math.round(val / 60000)} minutes`, ms.trim());
  // Coming back to the tab refreshes everything: the cost is the repeat, and
  // somebody who just looked wants what is true now.
  const vis = (src.match(/visibilitychange.*$/m) || [''])[0];
  check(/pollSlow\(\)/.test(vis), 'and returning to the tab refreshes them too', vis.trim().slice(0, 90));
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
