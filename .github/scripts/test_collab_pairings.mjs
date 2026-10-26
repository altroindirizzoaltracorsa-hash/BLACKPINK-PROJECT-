// The per-trade rows on /collabs, and the thing they could quietly get wrong.
//
// Run: node .github/scripts/test_collab_pairings.mjs
//
// The partner asked for the board as four bars, one per pairing: BP × BINI,
// JENNIE × BINI, ROSÉ × BINI, BP × Ahn Hyo-seop. The data supports that — but
// BINI has exactly ONE ballot category, so the same count stands behind all
// three BINI rows, and BLACKPINK's stands behind both of its. Add the rows up
// and you get three times the BINI votes that were ever cast.
//
// That is the failure this guards. A shared slot must be drawn hatched and
// marked, and the rows must never be summed. The page is otherwise careful
// about exactly this ("THIS SPLITS NO VOTES"), and a per-pairing view is the
// obvious way to undo that carefulness by accident.
//
// The second thing it guards is quieter and matters more. These rows are a
// VIEW. BLOOMs agreed to one trade covering BLACKPINK and JENNIE, with ROSÉ
// voted beyond the ask — so showing three BINI rows must not drift into the
// page claiming three agreements. The agreement data is checked to be
// unchanged: naming someone as having agreed to something they did not is the
// one mistake this page exists to avoid.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const page = readFileSync(root + 'collabs.html', 'utf8');

// The real COLLABS array out of the page, not a copy kept here. A test with its
// own copy of the data is a test that agrees with itself.
const src = page.match(/^var COLLABS = \[[\s\S]*?^\];$/m);
if (!src) { console.log('  FAIL could not find COLLABS in collabs.html'); process.exit(1); }
const COLLABS = new Function(`${src[0]}\nreturn COLLABS;`)();
const c = COLLABS.find(x => x.id === 'bvp-kca-2026');

console.log('--- the pairings are real trades between real ballot slots');
check(!!c, 'found the KCA collab');
check(Array.isArray(c.pairings) && c.pairings.length === 4,
      `there are ${c.pairings ? c.pairings.length : 0} pairings`);

const ours   = new Set((c.theyGive || []).map(x => x.slug));
const theirs = new Set((c.weGive   || []).map(x => x.slug));
for (const q of c.pairings || []) {
  check(ours.has(q.us), `${q.us} is a category of ours`);
  check(theirs.has(q.them), `${q.them} is a partner's category`);
  // The whole premise of the trade: neither side is in the other's category,
  // so neither gives anything up. A pairing of a slug with itself would mean
  // telling blinks to vote against themselves.
  check(q.us !== q.them, 'a trade is between two DIFFERENT slots');
}

console.log('\n--- a slot used by more than one trade is marked as shared');
{
  const count = key => c.pairings.reduce((t, q) => (t[q[key]] = (t[q[key]] || 0) + 1, t), {});
  const usN = count('us'), themN = count('them');
  const shared = [...new Set([
    ...Object.keys(usN).filter(k => usN[k] > 1),
    ...Object.keys(themN).filter(k => themN[k] > 1),
  ])];
  // Not "some slot is shared" — the specific ones, because the hazard is
  // exactly BINI's single category standing behind three rows.
  check(shared.includes('favorite-global-music-star'),
        'BINI\'s one category is recognised as shared', shared.join(', '));
  check(shared.includes('favorite-music-group-or-duo'),
        'and so is BLACKPINK\'s', shared.join(', '));

  // The renderer has to act on it. Without the hatch and the asterisk the rows
  // read as four independent results.
  check(/repeat:\s*usUsed\[q\.us\]\s*>\s*1/.test(page) && /repeat:\s*themUsed\[q\.them\]\s*>\s*1/.test(page),
        'the builder flags both sides when their slot repeats');
  // The RULE, not the string. Looking for "pr-repeat" anywhere passed even with
  // the stylesheet rule renamed away, because the class is still written by the
  // builder — the segments would have carried a class that styled nothing and
  // the three BINI rows would have looked like three independent results.
  const rule = (page.match(/\.pr-repeat\s*\{[^}]*\}/) || [])[0];
  check(!!rule, 'there is a .pr-repeat style rule');
  check(!!rule && /repeating-linear-gradient/.test(rule),
        'and it hatches, rather than only changing colour', rule ? rule.slice(0, 60) : '');
  check(/class="pr-seg' \+ \(r\.us\.repeat \? ' pr-repeat' : ''\)/.test(page)
        && /class="pr-seg' \+ \(r\.them\.repeat \? ' pr-repeat' : ''\)/.test(page),
        'and both sides can carry it');

  // AND IT HAS TO SURVIVE THE INLINE STYLE. `background:` is a shorthand that
  // resets background-image to none, and an inline style outranks the
  // stylesheet — so the segments were written with `background:<colour>`, which
  // silently wiped the hatch. The rule existed, the class was applied, every
  // check above passed, and all four rows still rendered solid. Only looking at
  // it found that. The colour must be set as background-COLOR.
  const segWrites = (page.match(/class="pr-seg[^]*?style="[^"]*"/g) || []);
  check(segWrites.length > 0, `found ${segWrites.length} segment style writes`);
  check(segWrites.every(w => !/;\s*background\s*:/.test(w)),
        'segments set background-color, not the background shorthand',
        segWrites.filter(w => /;\s*background\s*:/.test(w)).map(w => w.slice(-46)).join(' | '));
  check(/Do not add these up/.test(page), 'and the rows carry a do-not-sum warning');
}

console.log('\n--- the rows are a view; the agreement is untouched');
// The answer given when this was designed: still ONE BINI trade. Three rows
// showing BINI must not become the page saying BLOOMs agreed to three things,
// or that ROSÉ was ever part of the ask.
{
  const bini = (c.partners || []).find(x => x.act === 'BINI');
  check(!!bini, 'BINI is still one partner entry');
  check(bini && bini.covers.length === 2,
        'covering two categories, as agreed', bini ? bini.covers.join(', ') : '');
  check(bini && !bini.covers.includes('favorite-female-artist'),
        'and NOT ROSÉ, who was never part of the ask');
  const rose = (c.theyGive || []).find(x => x.who === 'ROSÉ');
  check(rose && rose.required === false,
        'ROSÉ is still marked beyond the ask in the data');
  // ...and never rendered. `required` exists so a BLOOM who skips ROSÉ is not
  // held short of the ranking; printing it beside her would read as "do not
  // bother", and the only reader it could change is one who would otherwise
  // have voted for her. So it may be READ as logic and never written into
  // markup. Checked as "no line that touches `required` also builds HTML",
  // which is narrow enough to mean something — an earlier version searched the
  // whole page for the word "optional" and matched an unrelated form field.
  const codeLines = page.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const leaks = codeLines.filter(l => /\brequired\b/.test(l) && /['"`]\s*<|<\/|\+\s*['"`]/.test(l));
  check(leaks.length === 0, 'and `required` is never rendered into the markup',
        leaks.map(l => l.trim().slice(0, 70)).join(' | '));
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
