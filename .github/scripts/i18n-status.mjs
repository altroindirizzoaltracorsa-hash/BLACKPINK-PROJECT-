// Where each language stands, and whether its keys still match the page.
//
// Run: node .github/scripts/i18n-status.mjs
//
// Two failures this guards against, both of which look like nothing:
//
//   ORPHANED KEYS. A translation whose English no longer exists on the site.
//   It is not an error, it is never looked up — the work is just silently
//   wasted, and nobody finds out until someone reads the file.
//
//   English drift. Reword a sentence and every language loses it at once,
//   falling back to English. The site keeps working, which is the point of the
//   fallback, and that is exactly why it needs reporting: nothing breaks, so
//   nothing tells you.
//
// Counts coverage against the strings a blink is most likely to read first,
// not just the total — 100% of the chart axis labels and 0% of the voting
// rules is not 50% of a translated site.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const strings = JSON.parse(readFileSync(root + 'i18n/strings.json', 'utf8'));
const all = strings.strings;
const known = new Set(all.map((x) => x.s));

// Where a mistranslation or a missing one costs something, roughly in order.
const TIERS = [
  ['voting + guides', (x) => x.where.some((w) => w === 'vote' || /vote-|extension-link/.test(w))],
  ['every page (nav)', (x) => x.where.includes('chrome')],
  ['feedback',         (x) => x.where.includes('feedback')],
  ['badges + board',   (x) => x.where.some((w) => w === 'badges' || w === 'leaderboard')],
  ['everything else',  () => true],
];

function tierOf(x) {
  for (const [name, test] of TIERS) if (test(x)) return name;
  return 'everything else';
}
const tierTotals = {};
for (const x of all) { const t = tierOf(x); tierTotals[t] = (tierTotals[t] || 0) + 1; }

const files = readdirSync(root + 'i18n').filter((f) => f.endsWith('.json') && f !== 'strings.json');
if (!files.length) { console.log('no dictionaries yet'); process.exit(0); }

console.log(`English on the page: ${all.length} strings\n`);
const header = 'lang      total   ' + TIERS.map(([n]) => n.slice(0, 15).padStart(16)).join('');
console.log(header);
console.log('-'.repeat(header.length));

let anyOrphans = false;
const orphansBy = {};
for (const f of files.sort()) {
  const lang = f.replace(/\.json$/, '');
  const dict = JSON.parse(readFileSync(root + 'i18n/' + f, 'utf8'));
  const keys = Object.keys(dict);
  const orphans = keys.filter((k) => !known.has(k));
  if (orphans.length) { anyOrphans = true; orphansBy[lang] = orphans; }
  const have = new Set(keys);
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
  const cells = TIERS.map(([name]) => {
    const inTier = all.filter((x) => tierOf(x) === name);
    const done = inTier.filter((x) => have.has(x.s)).length;
    return `${done}/${inTier.length} ${pct(done, inTier.length)}`.padStart(16);
  });
  const done = all.filter((x) => have.has(x.s)).length;
  console.log(lang.padEnd(8) + `${pct(done, all.length)}`.padStart(6) + '   ' + cells.join(''));
}

if (anyOrphans) {
  console.log('\nORPHANED — translated, but this English is no longer on the site.');
  console.log('Either the English was reworded (re-point the key) or the text is gone (delete it).');
  for (const [lang, list] of Object.entries(orphansBy)) {
    console.log(`\n  ${lang}: ${list.length}`);
    for (const k of list.slice(0, 10)) console.log('    - ' + k.slice(0, 110));
  }
}

const generated = strings.generated;
console.log(`\nstrings.json generated ${generated}. Re-run i18n-extract.mjs after changing any English.`);
process.exit(anyOrphans ? 1 : 0);
