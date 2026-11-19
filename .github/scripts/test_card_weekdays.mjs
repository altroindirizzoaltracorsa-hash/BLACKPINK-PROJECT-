// Every weekday a countdown card prints is the real weekday for that date.
//
// Run: node .github/scripts/test_card_weekdays.mjs
//
// WHY. The Power Trip card shipped its first draft reading "Thu, Nov 20,
// 2026". Nov 20 2026 is a Friday. Nothing would have caught it: the date was
// right, the countdown was right, the card rendered perfectly, and the only
// wrong thing was a three-letter word that every reader would have trusted
// and nobody would have checked. It was spotted because the SAME card prints
// the reader's own clock through data-local-target, and Intl wrote "Fri" two
// inches below the hand-typed "Thu".
//
// That is not a lucky catch to rely on. Weekdays are typed by hand on every
// card, they are the one part of a date that cannot be verified by reading it
// back, and they are wrong in a way that looks authoritative. So: find every
// "Ddd, Mmm D, YYYY" on the page and check the day name against the date.
//
// Deliberately NOT limited to countdown cards. A wrong weekday is wrong
// wherever it is printed, and this costs nothing to apply to the whole file.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const FILES = ['index.html', 'middleware.js', 'awards.html', 'vmas.html', 'achievements.html'];
const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Fri, Nov 20, 2026" and "Thu Oct 29, 2026" — comma after the day optional,
// because both spellings are already in the file.
const RE = /\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:day|sday|nesday|rsday|urday)?,?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/g;

let checked = 0;
for (const f of FILES) {
  let src;
  try { src = readFileSync(root + f, 'utf8'); } catch { continue; }
  for (const m of src.matchAll(RE)) {
    const [whole, dayName, monName, dayNum, year] = m;
    const d = new Date(Date.UTC(Number(year), MONTHS.indexOf(monName), Number(dayNum)));
    const real = DAYS[d.getUTCDay()];
    checked++;
    if (real !== dayName) {
      // The line it is on, so the failure points at the card rather than at a
      // character offset nobody can act on.
      const line = src.slice(0, m.index).split('\n').length;
      bad(`${f}:${line} — "${whole}"`, `${monName} ${dayNum} ${year} is a ${real}, not ${dayName}`);
    }
  }
}
if (!checked) {
  bad('harness: no dated strings found at all', 'the pattern stopped matching — fix this test');
} else if (!fails) {
  ok(`every weekday matches its date`, `${checked} checked`);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll correct.');
process.exit(fails ? 1 : 0);
