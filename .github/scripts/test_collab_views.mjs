// The two views of the collab trade block, measured in a browser.
//
// Run: node .github/scripts/test_collab_views.mjs
//
// One selector switches between the same four trades read two ways:
//
//   BY TRADE — what each ballot slot received, one row per pairing.
//   BY VOTER — the same four, each split into one row per self-declared side:
//     "40 blinks voted for BLACKPINK and 40 for BINI; 34 blooms voted for
//     BLACKPINK and 34 for BINI".
//
// THE CLAIM THIS CHANGES. The page used to say a vote could not be traced to a
// fandom. The second view attributes — not a vote, which carries no fandom, but
// a PERSON: somebody says once which side they are on and their own picks are
// recorded per round, so a row is a sum over people who answered. The reach of
// that is exactly those people, which is why "didn't say" has to be a row of
// its own and never spread across the others — doing that would put votes under
// a fandom on the strength of nothing.
//
// Three failures live here and none of them throws.
//
//   1. Summing. BINI's one ballot category stands behind three of the four
//      trades, and splitting each trade by side multiplies the same votes again.
//      The hatch and the * have to survive into this view.
//   2. The denominator. Rows inside a trade share one, so the bar lengths are
//      the sides' sizes; scaled to its own total, a side that logged two votes
//      draws the same bar as one that logged a thousand.
//   3. The source. `fandomCats` is built in the API from every row; derived on
//      the page from `board` it would be right until the collab passes
//      BOARD_MAX voters and then quietly go short, which looks like a quiet
//      week. The page must not reconstruct it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PAGES = { '/collabs': '/collabs.html' };

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = PAGES[p] || p;
  try {
    const buf = await readFile(ROOT + file);
    const ext = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript',
      css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const browser = await chromium.launch();
const errs = [];
async function open(path, w = 1200) {
  const page = await browser.newPage({ viewport: { width: w, height: 1400 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  return page;
}

const page = await open('/collabs?demo=b');

console.log('--- the selector offers both views and starts on the trade');
{
  const tabs = await page.$$eval('.pr-tabs .tab', (els) => els.map((e) => ({
    label: e.textContent.trim(), on: e.classList.contains('on'),
    pressed: e.getAttribute('aria-pressed'),
  })));
  check(tabs.length === 2, `there are ${tabs.length} view tab(s)`, tabs.map((t) => t.label).join(' / '));
  check(tabs.filter((t) => t.on).length === 1, 'exactly one is lit');
  check(tabs[0] && tabs[0].on, 'and it is the trade view', tabs.map((t) => `${t.label}${t.on ? '*' : ''}`).join(' '));
  check(tabs.every((t) => t.pressed === (t.on ? 'true' : 'false')), 'aria-pressed matches what is lit');
}

console.log('\n--- the voter view is the same trades, each split by side');
await page.click('.pr-tabs .tab:nth-child(2)');
await page.waitForTimeout(400);
const v = await page.evaluate(() => {
  const groups = [...document.querySelectorAll('.pairings .pr-group')].map((g) => ({
    trade: g.querySelector('.pr-trade').textContent.replace(/\s+/g, ' ').trim(),
    rows: [...g.querySelectorAll('.pr-row')].map((r) => ({
      name: r.querySelector('.pr-name').textContent.trim(),
      nums: r.querySelector('.pr-nums').textContent.trim(),
      segs: [...r.querySelectorAll('.pr-seg')].map((s) => ({
        px: Math.round(s.getBoundingClientRect().width),
        hatched: s.classList.contains('pr-repeat'),
      })),
    })),
  }));
  const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
  const p = c.tally.periods[PERIOD];
  return { groups, pairings: c.pairings, byCat: p.byCat, fandomCats: p.fandomCats,
           sides: c.fandoms.map((x) => ({ key: x.key, label: x.label })),
           head: document.querySelector('.pairings-head').textContent.trim(),
           note: document.querySelector('.pairings .pr-note').textContent };
});
{
  check(v.groups.length === v.pairings.length,
        `${v.groups.length} group(s) for ${v.pairings.length} trade(s)`,
        v.groups.map((g) => g.trade).join(' | '));
  // The trade names are the ones the other view prints: the split is of these
  // four trades, not of some other grouping that happens to have four rows.
  check(v.groups.every((g) => /×/.test(g.trade)), 'each names its trade', v.groups[0] && v.groups[0].trade);
  check(v.groups.every((g) => g.rows.length > 0), 'and carries rows under it');
  check(v.groups.every((g) => g.rows.every((r) => r.segs.length === 2)),
        'every row has the two segments of a trade, ours and theirs');
  // The fandom names the ROW. A segment coloured by fandom would be drawing a
  // vote as belonging to one, which is the thing this view does not claim.
  const labels = v.sides.map((s) => s.label).concat(['Didn’t say']);
  check(v.groups.every((g) => g.rows.every((r) => labels.some((l) => r.name.includes(l)))),
        'and is named for a side', v.groups[0] && v.groups[0].rows.map((r) => r.name).join(', '));
}

console.log('\n--- the numbers are the real per-side, per-category counts');
{
  const key = {};
  for (const s of v.sides) key[s.label] = [s.key];
  const strays = Object.keys(v.fandomCats).filter((k) => !v.sides.some((s) => s.key === k));
  key['Didn’t say'] = strays;
  let wrong = [];
  v.groups.forEach((g, i) => {
    const q = v.pairings[i];
    for (const r of g.rows) {
      const ks = key[Object.keys(key).find((l) => r.name.includes(l))] || [];
      const want = [q.us, q.them].map((sl) =>
        ks.reduce((a, k) => a + ((v.fandomCats[k] || {})[sl] || 0), 0));
      const got = r.nums.replace(/[*\s]/g, '').split('/').map((x) => Number(x.replace(/,/g, '')));
      if (got[0] !== want[0] || got[1] !== want[1]) {
        wrong.push(`${g.trade} ${r.name}: ${got.join('/')} want ${want.join('/')}`);
      }
    }
  });
  check(wrong.length === 0, 'every row prints that side\'s own two counts', wrong.join(' | '));

  // The property that makes the split honest: the sides under one trade are
  // everybody, so they come to that trade's own numbers. If "didn't say" were
  // dropped, or a stray key ignored, this is what would go short.
  let off = [];
  v.groups.forEach((g, i) => {
    const q = v.pairings[i];
    const tot = g.rows.reduce((a, r) => {
      const n = r.nums.replace(/[*\s]/g, '').split('/').map((x) => Number(x.replace(/,/g, '')));
      return [a[0] + n[0], a[1] + n[1]];
    }, [0, 0]);
    if (tot[0] !== v.byCat[q.us] || tot[1] !== v.byCat[q.them]) {
      off.push(`${g.trade}: ${tot.join('/')} vs ${v.byCat[q.us]}/${v.byCat[q.them]}`);
    }
  });
  check(off.length === 0, 'and down a trade they add up to that trade\'s totals', off.join(' | '));
}

console.log('\n--- a shared ballot slot stays marked after the split');
// BINI's one category stands behind three trades. Splitting each of those by
// side multiplies the same votes again, so the hatch and the * matter MORE
// here, not less.
{
  const used = {};
  for (const q of v.pairings) { used[q.us] = (used[q.us] || 0) + 1; used[q.them] = (used[q.them] || 0) + 1; }
  const shared = v.pairings.map((q, i) => ({ i, us: used[q.us] > 1, them: used[q.them] > 1 }));
  check(shared.some((s) => s.us || s.them), 'the sample really has a shared slot',
        shared.map((s) => `${s.us ? 'us' : ''}${s.them ? 'them' : ''}`).join(','));
  let bad = [];
  shared.forEach((s) => {
    for (const r of v.groups[s.i].rows) {
      if (!!r.segs[0].hatched !== s.us || !!r.segs[1].hatched !== s.them) {
        bad.push(`${v.groups[s.i].trade} ${r.name}`);
      }
    }
  });
  check(bad.length === 0, 'and every row of a shared trade is hatched on that side', bad.join(' | '));
  const stars = v.groups.filter((g, i) => shared[i].us || shared[i].them)
    .every((g) => g.rows.every((r) => r.nums.includes('*')));
  check(stars, 'and carries the asterisk in its numbers');
  check(/do not add these up/i.test(v.note), 'and the note still says not to sum them');
}

console.log('\n--- rows inside a trade share one denominator');
// Scaled to its own total, a side that logged two votes draws the same bar as
// one that logged a thousand — the picture then contradicts the numbers printed
// beside it. Measured off the rendered elements, not off the style string.
{
  let bad = [];
  v.groups.forEach((g) => {
    const tot = g.rows.map((r) => ({
      name: r.name,
      n: r.nums.replace(/[*\s]/g, '').split('/').map((x) => Number(x.replace(/,/g, ''))).reduce((a, b) => a + b, 0),
      px: r.segs.reduce((a, s) => a + s.px, 0),
    }));
    const top = tot.reduce((a, b) => (b.n > a.n ? b : a));
    for (const t of tot) {
      if (Math.abs(t.px / top.px - t.n / top.n) > 0.05) {
        bad.push(`${g.trade} ${t.name} ${Math.round(t.px / top.px * 100)}% vs ${Math.round(t.n / top.n * 100)}%`);
      }
    }
  });
  check(bad.length === 0, 'a bigger side draws a longer bar, in proportion', bad.join(' | '));
  // And the rule is visible rather than vacuous: the sides in a trade really
  // do differ in size, so a per-row denominator would have been caught.
  const spread = v.groups.every((g) => {
    const ns = g.rows.map((r) => r.nums.replace(/[*\s]/g, '').split('/')
      .map((x) => Number(x.replace(/,/g, ''))).reduce((a, b) => a + b, 0));
    return Math.max(...ns) > Math.min(...ns) * 1.3;
  });
  check(spread, 'and the sample has sides of different sizes, so the check can tell');
}

console.log('\n--- a side that logged nothing is accounted for in words');
// Sixteen empty tracks are not an account of anything, but a side that simply
// vanishes reads as "they are not in this".
{
  const got = await page.evaluate(() => {
    const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
    const quiet = JSON.parse(JSON.stringify(c.tally.periods.all.fandomCats));
    delete quiet.pauljjak;
    const groups = voterTradeRows(c, { fandomCats: quiet });
    const silent = voterSilent(c, { fandomCats: quiet });
    const box = document.createElement('div');
    box.innerHTML = voterViewHtml(c, groups, silent);
    return { silent, rows: [...box.querySelectorAll('.pr-row')].map((r) => r.textContent),
             note: box.querySelector('.pr-note').textContent };
  });
  check(got.silent.length === 1 && /Pauljjak/.test(got.silent[0]),
        'the quiet side is identified', got.silent.join(', '));
  check(!got.rows.some((t) => /Pauljjak/.test(t)), 'it draws no rows');
  check(/Nothing logged yet under Pauljjak/.test(got.note), 'and the note says so', got.note.slice(-120));
}

console.log('\n--- "didn\'t say" is its own row, never spread across the others');
// The reach of the attribution is the people who answered. Folding their votes
// into the declared sides would put votes under a fandom on the strength of
// nothing at all — which is the one claim this page has always refused.
{
  const got = await page.evaluate(() => {
    const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
    const fc = { blink: { 'favorite-music-group-or-duo': 10, 'favorite-global-music-star': 10 },
                 'a-side-this-collab-dropped': { 'favorite-music-group-or-duo': 3, 'favorite-global-music-star': 3 },
                 unsaid: { 'favorite-music-group-or-duo': 7, 'favorite-global-music-star': 7 } };
    const g = voterTradeRows(c, { fandomCats: fc })
      .filter((x) => x.us.slug === 'favorite-music-group-or-duo')[0];
    return { rows: g.rows.map((r) => ({ label: r.label, us: r.us, them: r.them })) };
  });
  const blink = got.rows.filter((r) => /BLINK/i.test(r.label))[0] || {};
  const other = got.rows.filter((r) => /Didn/i.test(r.label))[0] || {};
  check(blink.us === 10, 'a declared side carries only its own votes', String(blink.us));
  check(!!other, 'and there is a row for everybody else');
  // Both the never-answered and a key the collab no longer has: same situation,
  // one row, and keeping it is what makes the trade add up.
  check(other.us === 10, 'carrying the undeclared AND the dropped side', String(other.us));
}

console.log('\n--- the split comes from the API, not rebuilt from the capped board');
{
  const src = await readFile(ROOT + '/collabs.html', 'utf8');
  const api = await readFile(ROOT + '/api/collabs.js', 'utf8');
  check(/fandomCats\[k\]\s*\|\|\s*\(fandomCats\[k\]\s*=\s*\{\}\)/.test(api)
        && /for \(const e of per\.values\(\)\)[\s\S]{0,420}fandomCats/.test(api),
        'the API builds it from every row, not from `board`');
  check(/return \{ byCat, board, fandoms, fandomCats, total/.test(api), 'and sends it');
  // The page may READ p.fandomCats and must never assemble one of its own out
  // of board rows — which would be right until the 201st voter.
  const lines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const leak = lines.filter((l) => /\.board\b/.test(l) && /fandom/i.test(l));
  check(leak.length === 0, 'and the page never reconstructs it from the board',
        leak.map((l) => l.trim().slice(0, 70)).join(' | '));
  // No fandomCats, no view: an older deployment loses the tab rather than
  // showing a split of nothing.
  const none = await page.evaluate(() => {
    const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
    return voterTradeRows(c, { byCat: c.tally.periods.all.byCat }).length;
  });
  check(none === 0, 'and without it the view has no rows at all', String(none));
}

console.log('\n--- the page no longer claims it cannot tell who logged a vote');
// It used to say "nothing here can tell which fandom a vote came from". That
// was the right instinct about the wrong object: the BAR is not a fandom score,
// but the claim as written is about capability, and this view attributes
// through the person. Saying both would be the page contradicting itself.
{
  const notes = await page.evaluate(() => ({
    tally: document.querySelector('.tally-note').textContent.replace(/\s+/g, ' '),
    turnout: [...document.querySelectorAll('.sub-note')].map((n) => n.textContent.replace(/\s+/g, ' ')).join(' '),
  }));
  const all = notes.tally + ' ' + notes.turnout + ' ' + v.note.replace(/\s+/g, ' ');
  check(!/cannot be traced to a fandom|can tell which fandom a vote came from/i.test(all),
        'the old blanket claim is gone', (all.match(/[^.]*fandom a vote[^.]*\./) || [])[0] || '');
  check(/not a blink’s vote|carries no fandom of its own/i.test(all),
        'replaced by the narrower true one: a vote carries no fandom');
  check(/self-declared/i.test(all), 'and the attribution is still marked self-declared');
  check(/Didn’t say/i.test(v.note), 'and the voter note names where the unanswered go');
  check(/not two teams/i.test(notes.tally), 'the bar still says it is not two teams');
}

console.log('\n--- a collab with no sides keeps the trade rows and loses the control');
{
  const plain = await open('/collabs?demo=a');
  const got = await plain.evaluate(() => ({
    tabs: document.querySelectorAll('.pr-tabs').length,
    rows: document.querySelectorAll('.pairings .pr-row').length,
    head: (document.querySelector('.pairings-head') || {}).textContent || '',
  }));
  check(got.tabs === 0, 'no selector is drawn', `${got.tabs} found`);
  check(got.rows === 4, 'the four trade rows are still there', String(got.rows));
  check(/trade/i.test(got.head), 'under the trade heading', got.head.trim());
  await plain.close();
}

console.log('\n--- nothing threw');
check(errs.length === 0, 'no page errors', errs.join(' | '));

await browser.close();
server.close();
console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
