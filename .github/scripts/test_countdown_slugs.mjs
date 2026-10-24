// A countdown slug has to exist in THREE places, and two of them are silent.
//
// Run: node .github/scripts/test_countdown_slugs.mjs
//
//   index.html    data-slug on the card        — the deep link /countdowns/<slug>
//   middleware.js COUNTDOWNS[slug]             — the link preview when shared
//   middleware.js matcher: '/countdowns/<slug>' — or middleware never RUNS there
//
// The matcher is the trap: its own comment says a `:slug*` wildcard does not
// reliably match, so every slug is listed by hand — and a slug missing from
// that list gets the generic site preview with nothing failing anywhere.
// `newtrick` had a card, and a /countdowns/newtrick link in the hub, and
// neither of the other two, for over a month.
import { readFile } from 'node:fs/promises';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const ix = await readFile(ROOT + '/index.html', 'utf8');
const mw = await readFile(ROOT + '/middleware.js', 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const block = (src, start) => {
  const i = src.indexOf(start); if (i < 0) return null;
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return null;
};

const cdBlock = block(mw, 'const COUNTDOWNS =');
if (!cdBlock) { console.log('  FAIL COUNTDOWNS not found in middleware.js'); process.exit(1); }
// Keys may be quoted ('jisoo.io') or bare (addicted).
const previews = [...cdBlock.matchAll(/^  '?([A-Za-z0-9._-]+)'?:\s*\{/gm)].map(m => m[1]);
const matcher  = [...mw.matchAll(/'\/countdowns\/([^']+)'/g)].map(m => m[1]);
const slugs    = [...ix.matchAll(/<div class="cd-card[^"]*"[^>]*data-slug="([^"]+)"/g)].map(m => m[1]);

console.log(`    ${slugs.length} cards · ${previews.length} previews · ${matcher.length} matcher entries`);
slugs.length ? ok('card slugs parsed', slugs.join(', ')) : bad('card slugs parsed');

const noPreview = slugs.filter(s => !previews.includes(s));
noPreview.length ? bad('every card slug has a link preview', noPreview.join(', '))
                 : ok('every card slug has a link preview');
const noMatch = slugs.filter(s => !matcher.includes(s));
noMatch.length ? bad('every card slug is in the middleware matcher', noMatch.join(', '))
               : ok('every card slug is in the middleware matcher');
// The other direction: a preview for a card that no longer exists is dead
// weight, and usually means a card was renamed and this was left behind.
const orphan = previews.filter(p => !slugs.includes(p));
orphan.length ? bad('no preview without a card', orphan.join(', '))
              : ok('no preview without a card');
const dupes = [...new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))];
dupes.length ? bad('card slugs are unique — two cards cannot share a deep link', dupes.join(', '))
             : ok('card slugs are unique');

// ADDICTED specifically: one worldwide instant, so it must NOT carry the
// midnight-local attribute the PRESS PLAY EP needs.
const card = ix.match(/<div class="cd-card[^"]*"[^>]*data-slug="addicted"[^>]*>/);
if (!card) { bad('the ADDICTED card exists'); }
else {
  ok('the ADDICTED card exists');
  /data-target="2026-10-30T04:00:00Z"/.test(card[0])
    ? ok('it counts to 2026-10-30T04:00:00Z', '13:00 KST')
    : bad('it counts to 2026-10-30T04:00:00Z', card[0].slice(0, 120));
  /data-target-local/.test(card[0])
    ? bad('it is a single instant, not midnight-local — data-target-local must be absent')
    : ok('it is a single instant, not midnight-local');
}
// The worldwide-times list must be generated from the same instant the card
// counts to; two copies of a date is two chances to be wrong.
const after = ix.slice(ix.indexOf('data-slug="addicted"'));
const times = after.slice(0, after.indexOf('</div>\n          <!--'));
times.includes('data-times-for="2026-10-30T04:00:00Z"')
  ? ok('the worldwide-times list uses that same instant')
  : bad('the worldwide-times list uses that same instant');

console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
