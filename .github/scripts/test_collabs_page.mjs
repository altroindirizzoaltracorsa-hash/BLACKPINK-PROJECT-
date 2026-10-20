// Drive the REAL /collabs in a browser.
//
// Run: node .github/scripts/test_collabs_page.mjs
//
// This page names another fandom's project next to ours, which is the one thing
// on the site that can misrepresent somebody who is not us. So the checks are
// mostly about restraint rather than layout:
//
//   * A collab nobody has agreed to must NOT be visible to the public. It is
//     readable with ?preview=1 so it can be shown to them, and nowhere else.
//   * The categories on the two sides must not overlap. A trade only exists
//     because the two acts are up for different awards; if that ever stopped
//     being true the page would be telling blinks to vote against themselves.
//   * The bar must not draw 0–0. An empty bar reads as a broken feature and,
//     worse, as a claim that counting is happening when it is not.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PAGES = { '/collabs': '/collabs.html', '/awards': '/awards.html' };
const SPA = /^\/(voting|vote|feedback|votecard-embed)(\/|$)/;

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = PAGES[p] || (p === '/' ? '/awards.html' : SPA.test(p) ? '/index.html' : p);
  try {
    const buf = await readFile(ROOT + file);
    const ext = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
      jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { failures++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const browser = await chromium.launch();
const errs = [];
async function open(path, w = 1200) {
  const page = await browser.newPage({ viewport: { width: w, height: 1000 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  return page;
}

console.log('--- a collab nobody agreed to stays off the public page');
const pub = await open('/collabs');
const data = await pub.evaluate(() => ({
  all: COLLABS.map((c) => ({ id: c.id, status: c.status })),
  drawn: [...document.querySelectorAll('.collab')].map((el) => el.dataset.collab),
  // Scoped to the list, not `.empty` anywhere: an unqualified match once found
  // the empty BAR track and reported the page as showing its empty-state note.
  empty: !!document.querySelector('#list > .empty'),
}));
const proposed = data.all.filter((c) => c.status === 'proposed').map((c) => c.id);
const leaked = proposed.filter((id) => data.drawn.includes(id));
if (proposed.length) {
  leaked.length === 0 ? ok(`${proposed.length} proposed collab(s) hidden`, proposed.join(', '))
                      : bad('proposed collabs hidden', `visible: ${leaked.join(', ')}`);
}
// Exercised whether or not one happens to exist today. This is the guard that
// stops the site announcing a partnership nobody agreed to, and "nothing to
// check" is how it would rot: the day every collab is live, a broken filter
// would pass silently and only show itself on the next proposed one.
const hidden = await pub.evaluate(() => {
  const before = COLLABS.slice();
  COLLABS.push({
    id: '__test-proposed', status: 'proposed', award: 'Test', deadline: null,
    voteUrl: 'https://example.com/', partner: { name: 'Someone', fandom: 'Someones', act: 'Nobody' },
    weGive: [{ cat: 'A', nominee: 'X' }], theyGive: [{ cat: 'B', nominee: 'Y' }],
    why: 'test', tally: null, pending: ['test'],
  });
  render();
  const shown = [...document.querySelectorAll('.collab')].map((el) => el.dataset.collab);
  // innerText, not textContent. textContent includes the inline <script>, so a
  // CODE COMMENT counts as page text — this is the second check in this file
  // to report a leak that was a comment explaining the leak rule. What matters
  // is what a reader can see.
  const body = document.body.innerText;
  COLLABS.length = 0; before.forEach((c) => COLLABS.push(c));
  render();
  return { shown, named: /Someones|Nobody/.test(body) };
});
(!hidden.shown.includes('__test-proposed') && !hidden.named)
  ? ok('a proposed collab injected into the list is not rendered publicly')
  : bad('a proposed collab injected into the list is not rendered publicly',
        hidden.named ? 'the partner was named in the page text' : hidden.shown.join(', '));
// And the page still says something rather than rendering a blank slab.
const nonProposed = data.all.filter((c) => c.status !== 'proposed');
(nonProposed.length ? data.drawn.length === nonProposed.length : data.empty)
  ? ok('the public page shows the right thing', data.empty ? 'the empty note' : `${data.drawn.length} collab(s)`)
  : bad('the public page shows the right thing', JSON.stringify(data));
await pub.close();

console.log('--- ?preview=1 shows them, so they can be sent to the partner');
const prev = await open('/collabs?preview=1');
const shown = await prev.evaluate(() => [...document.querySelectorAll('.collab')].map((el) => ({
  id: el.dataset.collab, status: el.dataset.status,
  statusText: (el.querySelector('.collab-status') || {}).textContent || '',
})));
shown.length === data.all.length ? ok('every collab is drawn in preview', `${shown.length}`)
                                 : bad('every collab is drawn in preview', `${shown.length} of ${data.all.length}`);
for (const s of shown.filter((x) => x.status === 'proposed')) {
  // Even in preview it must read as not-a-partnership on its face: this is the
  // view that gets screenshotted and sent around.
  /proposed|not announced/i.test(s.statusText)
    ? ok(`${s.id} is marked as not announced`, s.statusText.trim())
    : bad(`${s.id} is marked as not announced`, s.statusText.trim() || 'no marker');
}

console.log('--- who is running it, named on the card and coloured by side');
// A collab is the partner pages' work as much as ours, and a tracker with
// nobody credited on it reads as ours alone. Each name is also a public claim
// that that page is in, which is why they are listed per collab and per side
// rather than being a site-wide credit.
{
  const by = await prev.evaluate(() => [...document.querySelectorAll('.collab')].map((el) => ({
    id: el.dataset.collab,
    status: el.dataset.status,
    us: [...el.querySelectorAll('.collab-by .by-us')].map((x) => x.textContent.trim()),
    them: [...el.querySelectorAll('.collab-by .by-them')].map((x) => x.textContent.trim()),
    // Under the title, not in the footer: the heading says who the collab is
    // FOR, this says who arranged it, and they belong together.
    underTitle: (() => {
      const t = el.querySelector('.collab-title'), b = el.querySelector('.collab-by');
      return !!(t && b && b.getBoundingClientRect().top >= t.getBoundingClientRect().top);
    })(),
  })));
  const live = by.find((x) => x.id === 'bvp-kca-2026');
  (live && live.us.length >= 2 && live.them.length >= 2)
    ? ok('every page running it is named', `${live.us.join(' × ')} with ${live.them.join(' × ')}`)
    : bad('every page running it is named', JSON.stringify(live));
  (live && live.us.some((n) => /blinks united/i.test(n)))
    ? ok('including us, not only the partners')
    : bad('including us, not only the partners', JSON.stringify(live && live.us));
  // Each side in its own colour, so four names do not read as one undifferentiated
  // list of strangers.
  (live && live.us.length && live.them.length)
    ? ok('and the two sides are told apart')
    : bad('and the two sides are told apart', JSON.stringify(live));
  live && live.underTitle ? ok('with the credit under the title') : bad('with the credit under the title');
  // Each handle has to reach the actual account. A credit nobody can follow is
  // a name on a page, and these are other people's pages.
  const links = await prev.evaluate(() => [...document.querySelectorAll('.collab-by a')].map((a) => ({
    text: a.textContent.trim(),
    href: a.getAttribute('href'),
    blank: a.getAttribute('target') === '_blank',
    rel: a.getAttribute('rel') || '',
  })));
  const handles = links.filter((l) => l.text.startsWith('@'));
  handles.length >= 3
    ? ok('every handle is a link', handles.map((h) => h.text).join(' '))
    : bad('every handle is a link', `${handles.length} of them`);
  const wrong = handles.filter((h) => h.href !== `https://x.com/${h.text.slice(1)}`);
  wrong.length === 0
    ? ok('and points at that account on x.com')
    : bad('and points at that account on x.com', wrong.map((w) => `${w.text} → ${w.href}`).join(', '));
  // Off-site, so it opens in its own tab and cannot reach back through
  // window.opener — the page someone was reading should still be there.
  handles.every((h) => h.blank && /noopener/.test(h.rel))
    ? ok('and opens in its own tab, with noopener')
    : bad('and opens in its own tab, with noopener', JSON.stringify(handles));
  const ours = links.filter((l) => !l.text.startsWith('@'));
  ours.every((l) => !l.blank)
    ? ok('while our own link stays in the tab', ours.map((l) => l.text).join(', '))
    : bad('while our own link stays in the tab', JSON.stringify(ours));
  // A page that has not agreed is not named anywhere, which the hidden-collab
  // check above covers for the card as a whole — this is the same rule stated
  // for the credit line specifically, since that is the part that names people.
  const leaked = by.filter((x) => x.status === 'proposed' && (x.us.length || x.them.length));
  leaked.length === 0
    ? ok('and no unannounced collab lists anybody')
    : bad('and no unannounced collab lists anybody', JSON.stringify(leaked));
}

console.log('--- the two sides are genuinely different categories');
// The entire premise. If an act appears on both sides, or a category does,
// there is no trade — and the page would be telling blinks to spend a slot
// they needed for BLACKPINK.
const sides = await prev.evaluate(() => COLLABS.map((c) => ({
  id: c.id,
  ours: c.theyGive.map((p) => p.slug),
  theirs: c.weGive.map((p) => p.slug),
  ourNames: c.theyGive.map((p) => p.nominee),
  theirNames: c.weGive.map((p) => p.nominee),
})));
for (const s of sides) {
  const norm = (x) => x.trim().toLowerCase();
  const clash = s.ours.map(norm).filter((c) => s.theirs.map(norm).includes(c));
  clash.length === 0 ? ok(`${s.id}: no category appears on both sides`)
                     : bad(`${s.id}: no category appears on both sides`, clash.join(', '));
  const nameClash = s.ourNames.map(norm).filter((n) => s.theirNames.map(norm).includes(n));
  nameClash.length === 0 ? ok(`${s.id}: no nominee appears on both sides`)
                         : bad(`${s.id}: no nominee appears on both sides`, nameClash.join(', '));
  (s.ours.length && s.theirs.length) ? ok(`${s.id}: both sides have something to do`,
      `${s.theirs.length} for us → ${s.ours.length} for them`)
    : bad(`${s.id}: both sides have something to do`, JSON.stringify(s));
}

console.log('--- the bar never claims to be counting when it is not');
const bars = await prev.evaluate(() => [...document.querySelectorAll('.collab')].map((el) => {
  const id = el.dataset.collab;
  const c = COLLABS.find((x) => x.id === id);
  const counting = !!(c.tally && (c.tally.us || c.tally.them));
  return { id, counting,
           hasBar: !!el.querySelector('.bar'),
           // The fills are the claim. An empty track is honest furniture; a
           // track with segments in it asserts a score.
           fills: el.querySelectorAll('.bar-us, .bar-them').length,
           label: (el.querySelector('.tally-nums') || {}).textContent || '',
           why: (el.querySelector('.tally-why') || {}).textContent || '',
           note: (el.querySelector('.tally-note') || {}).textContent || '' };
}));
for (const b of bars) {
  if (b.counting) {
    (b.hasBar && b.fills === 2) ? ok(`${b.id}: the bar is filled from both sides`)
                                : bad(`${b.id}: the bar is filled from both sides`, JSON.stringify(b));
    /logged, not verified/i.test(b.note)
      ? ok(`${b.id}: the bar says logged, not verified`)
      : bad(`${b.id}: the bar says logged, not verified`, b.note.trim());
  } else {
    // The track may be drawn — it holds the place the bar will take. What it
    // must not do is put anything IN it, because a segment of any width is a
    // score, and a 50/50 one reads as a real tie.
    b.fills === 0 ? ok(`${b.id}: no numbers, so nothing is drawn in the bar`)
                  : bad(`${b.id}: no numbers, so nothing is drawn in the bar`, `${b.fills} fill(s)`);
    /not counting yet/i.test(b.label)
      ? ok(`${b.id}: and the label says so`, b.label.trim())
      : bad(`${b.id}: and the label says so`, b.label.trim() || '(no label)');
    // The reasons stay reachable even though they are folded away.
    /extension|record|counting/i.test(b.why)
      ? ok(`${b.id}: what is missing is still readable`)
      : bad(`${b.id}: what is missing is still readable`, b.why.slice(0, 60));
  }
}

console.log('--- and when there ARE numbers, the bar draws them in proportion');
// Nothing on the page has a tally yet, so without this the filled branch would
// ship having never rendered once. Feed it numbers and re-render: the widths
// are the only thing on this page that could be silently wrong in a way a
// reader would still believe.
const filled = await prev.evaluate(() => {
  const before = JSON.parse(JSON.stringify(COLLABS[0].tally || null));
  // 100 passes through the ballot by the collab as a whole: three picks land on
  // our nominees each time and one on theirs. The two figures are what each act
  // RECEIVED — not what each fandom contributed, which nothing here can know.
  COLLABS[0].tally = {
    forUs:   { picks: 300 },           // votes BLACKPINK, JENNIE & ROSÉ received
    forThem: { picks: 100 },           // votes BINI received
    asOf: new Date().toISOString(), themSource: 'their page',
  };
  render();
  const el = document.querySelector('.collab');
  const pct = (sel) => {
    const n = el.querySelector(sel);
    if (!n) return null;
    const track = el.querySelector('.bar').getBoundingClientRect().width;
    return Math.round(n.getBoundingClientRect().width / track * 100);
  };
  const out = { us: pct('.bar-us'), them: pct('.bar-them'),
                nums: (el.querySelector('.tally-nums') || {}).textContent || '',
                note: (el.querySelector('.tally-note') || {}).textContent || '',
                stillHasWhy: !!el.querySelector('.tally-why') };
  COLLABS[0].tally = before;                 // leave the page as it was
  render();
  return out;
});
// Drawn to scale, NOT normalised. 300 against 100 really is 75/25, and
// flattening it would be inventing a tidier number than the one we have.
// And our acts are drawn in OUR colour: .bar-us is the pink one, and it has to
// be the segment carrying 300 rather than the partner's 100.
(Math.abs(filled.us - 75) <= 1 && Math.abs(filled.them - 25) <= 1)
  ? ok('the totals are drawn to scale, ours in our colour', `${filled.us}% / ${filled.them}%`)
  : bad('the totals are drawn to scale, ours in our colour',
        `${filled.us}% / ${filled.them}% — expected 75/25, pink first`);
(/300/.test(filled.nums) && /100/.test(filled.nums))
  ? ok('and both totals are in the headline', filled.nums.trim())
  : bad('and both totals are in the headline', filled.nums.trim());
// ROSÉ is in our side's total now, so the headline has to name her — she is a
// third of that number.
/ROSÉ/.test(filled.nums)
  ? ok('and ROSÉ is named in the total she is part of')
  : bad('and ROSÉ is named in the total she is part of', filled.nums.trim());
// The whole point of the note. A reader shown 3:1 and not told why will read it
// as a scoreline, and it is not one — neither figure belongs to a fandom.
/not two teams/i.test(filled.note)
  ? ok('and the note says these are not two teams')
  : bad('and the note says these are not two teams', filled.note.replace(/\s+/g, ' ').slice(0, 90));
/slot counts, not standings/i.test(filled.note)
  ? ok('and explains the gap as slot counts')
  : bad('and explains the gap as slot counts', filled.note.replace(/\s+/g, ' ').slice(0, 90));
// The page asks for ALL FOUR and names them.
/one pass through the ballot is 4 votes/i.test(filled.note.replace(/\s+/g, ' '))
  ? ok('and asks for all four votes')
  : bad('and asks for all four votes', filled.note.replace(/\s+/g, ' ').slice(0, 140));
// Totals alone CANNOT give a pass count — 300 is 100 passes with ROSÉ every
// time or 150 with her never — so no number may appear.
!/complete pass/i.test(filled.note)
  ? ok('and claims no pass count from totals alone')
  : bad('and claims no pass count from totals alone', filled.note.replace(/\s+/g, ' ').slice(0, 140));
/logged, not verified/i.test(filled.note)
  ? ok('and it says logged, not verified')
  : bad('and it says logged, not verified', filled.note.trim());
!filled.stillHasWhy ? ok('and the "what has to happen first" note is gone')
                    : bad('and the "what has to happen first" note is gone', 'both states showing');

console.log('--- the ranking threshold is never stated on the page');
// `required: false` exists so a BLOOM who skips ROSÉ's category — which their
// side never agreed to — still reaches the ranking. It is a leniency, not a
// view on whose votes matter, and saying it out loud reads as "do not bother
// with her". The only person it could change the behaviour of is someone who
// would otherwise have voted for her, so it stays in the data and off the page.
const quiet = await prev.evaluate(() => {
  const hasOptional = COLLABS.some((c) =>
    c.theyGive.concat(c.weGive).some((p) => p.required === false));
  // The request form is read with the section hidden, which is also how it is
  // excluded: it marks its own last field "optional", which is a form field
  // and not a category — the rule here is about what the page says of a
  // NOMINEE. innerText ignores a hidden subtree, so hiding it for the read is
  // the whole exemption, and anything added anywhere else is still covered.
  const req = document.getElementById('request');
  if (req) req.style.display = 'none';
  // innerText, not textContent: the latter includes the inline <script>, so
  // the code comment explaining WHY the threshold is quiet registered as the
  // page saying it out loud. What matters is what a reader sees.
  const text = document.body.innerText.replace(/\s+/g, ' ');
  if (req) req.style.display = '';
  return { hasOptional, text };
});
if (!quiet.hasOptional) {
  ok('no category is marked non-required', 'nothing to keep quiet');
} else {
  const leaks = [/optional/i, /not required/i, /never required/i, /obliged/i, /\bexempt/i]
    .filter((re) => re.test(quiet.text)).map((re) => String(re));
  leaks.length === 0
    ? ok('the page never calls a category optional', 'the threshold stays in the data')
    : bad('the page never calls a category optional', leaks.join(', '));
  // And it still asks for every one of them by name.
  const named = await prev.evaluate(() => COLLABS[0].theyGive.concat(COLLABS[0].weGive)
    .map((p) => p.who || p.nominee)
    .filter((n) => !document.body.innerText.includes(n)));
  named.length === 0 ? ok('and every nominee is still named on it')
                     : bad('and every nominee is still named on it', `missing ${named.join(', ')}`);
}

console.log('--- with a per-category breakdown, the pass count ignores the optional one');
// The trap this exists for: ROSÉ is optional, so a pass is complete without
// her. Fold her into the minimum and 100 passes where 60 people also voted
// ROSÉ reports as 60 — undercounting the collab by 40% and, worse, making it
// look as though people who skipped an optional category had not finished.
const passes = await prev.evaluate(() => {
  const before = JSON.parse(JSON.stringify(COLLABS[0].tally || null));
  COLLABS[0].tally = {
    forUs: { picks: 260 }, forThem: { picks: 100 },
    byCat: {
      'favorite-music-group-or-duo': 100,     // BLACKPINK — required
      'favorite-music-collaboration': 100,    // JENNIE — required
      'favorite-female-artist': 60,           // ROSÉ — optional, the trap
      'favorite-global-music-star': 100,      // BINI — required
    },
    themSource: 'their page',
  };
  render();
  const note = document.querySelector('.tally-note').textContent.replace(/\s+/g, ' ');
  COLLABS[0].tally = before; render();
  return note;
});
/\b100\b complete passes/i.test(passes)
  ? ok('100 complete passes, not 60', 'ROSÉ excluded from the minimum')
  : bad('100 complete passes, not 60', passes.slice(0, 200));

console.log('--- tabs, the breakdown behind the bar, the board and the day grid');
// None of this is fed by anything yet, so without a fixture it would ship
// never having rendered. Everything below is driven by real clicks rather than
// by calling the render functions, because the wiring is most of what can
// break: a handler named wrong fails silently and leaves a bar that just does
// not respond.
const FIX = {
  periods: {
    today: { forUs: { picks: 9 }, forThem: { picks: 3 },
      byCat: { 'favorite-music-group-or-duo': 3, 'favorite-music-collaboration': 3,
               'favorite-female-artist': 3, 'favorite-global-music-star': 3 },
      board: [{ name: 'rllyanav', votes: 8, byCat: { 'favorite-music-group-or-duo': 2,
                 'favorite-global-music-star': 2, 'favorite-music-collaboration': 2,
                 'favorite-female-artist': 2 } },
              { name: 'a blink', votes: 4, byCat: { 'favorite-music-group-or-duo': 2 } }] },
    week: { forUs: { picks: 60 }, forThem: { picks: 20 }, byCat: {}, board: [] },
    all: { forUs: { picks: 300 }, forThem: { picks: 100 },
      byCat: { 'favorite-music-group-or-duo': 100, 'favorite-music-collaboration': 100,
               'favorite-female-artist': 60, 'favorite-global-music-star': 100 },
      board: [{ name: 'rllyanav', votes: 160, byCat: { 'favorite-music-group-or-duo': 40 } },
              { name: 'a blink', votes: 120, byCat: { 'favorite-global-music-star': 40 } }] },
  },
  days: [
    { day: '2026-10-16', votes: 40, byCat: { 'favorite-music-group-or-duo': 10, 'favorite-global-music-star': 10 } },
    { day: '2026-10-17', votes: 24, byCat: { 'favorite-music-group-or-duo': 8 } },
    { day: '2026-10-18', votes: 12, byCat: { 'favorite-global-music-star': 3 } },
  ],
  todayKey: '2026-10-18', themSource: 'their page',
};
await prev.evaluate((fix) => { COLLABS[0].tally = fix; render(); }, FIX);
await prev.waitForTimeout(300);

const tabCount = await prev.locator('.tab').count();
tabCount === 3 ? ok('three tabs', 'today / this week / all time')
               : bad('three tabs', `${tabCount}`);
const activeTab = (await prev.locator('.tab.on').textContent()).trim();
activeTab === 'All time' ? ok('all time leads') : bad('all time leads', activeTab);

// The bar opens the split, and the split is per category.
(await prev.locator('.split').count()) === 0
  ? ok('the breakdown starts closed') : bad('the breakdown starts closed');
await prev.locator('button.bar').click();
await prev.waitForTimeout(250);
const split = await prev.evaluate(() => [...document.querySelectorAll('.split-row')].map((r) => ({
  text: r.querySelector('.split-cat').textContent.replace(/\s+/g, ' ').trim(),
  n: r.querySelector('.split-n').textContent.trim(),
  fill: Math.round(parseFloat(r.querySelector('.split-fill').style.width)),
})));
split.length === 4 ? ok('clicking the bar shows all four categories', split.map((r) => r.n).join('/'))
                   : bad('clicking the bar shows all four categories', `${split.length} rows`);
// Ordered biggest first, and ROSÉ's 60 really is the short one.
(split[0].n === '100' && split[split.length - 1].n === '60')
  ? ok('ordered biggest first', `${split[0].n} … ${split[split.length - 1].n}`)
  : bad('ordered biggest first', split.map((r) => r.n).join(', '));
split[split.length - 1].fill < split[0].fill
  ? ok('and each row is drawn to its own share')
  : bad('and each row is drawn to its own share', JSON.stringify(split.map((r) => r.fill)));
split.every((r) => /BLACKPINK|JENNIE|ROSÉ|BINI/.test(r.text))
  ? ok('and each names the act, not just the slug')
  : bad('and each names the act, not just the slug', split.map((r) => r.text).join(' | '));
await prev.locator('button.bar').click();
await prev.waitForTimeout(200);
(await prev.locator('.split').count()) === 0
  ? ok('and clicking again closes it') : bad('and clicking again closes it');

// Tabs move the bar AND the board together.
const allNums = (await prev.locator('.tally-nums').textContent()).trim();
await prev.locator('.tab', { hasText: 'Today' }).click();
await prev.waitForTimeout(250);
const todayNums = (await prev.locator('.tally-nums').textContent()).trim();
(/\b9\b/.test(todayNums) && /\b3\b/.test(todayNums) && todayNums !== allNums)
  ? ok('switching to Today moves the bar', todayNums)
  : bad('switching to Today moves the bar', `${allNums} → ${todayNums}`);
const boardHead = (await prev.locator('.sub-head').first().textContent()).trim();
/today/i.test(boardHead)
  ? ok('and the board follows the same period', boardHead)
  : bad('and the board follows the same period', boardHead);

console.log('--- the board ranks on votes cast, and shows what each person cast');
const board = await prev.evaluate(() => [...document.querySelectorAll('.board tbody tr')].map((tr) => ({
  rank: tr.children[0].textContent.trim(),
  name: tr.children[1].childNodes[0].textContent.trim(),
  cats: [...tr.querySelectorAll('.board-cat')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
  votes: Number(tr.children[2].textContent.replace(/,/g, '')),
})));
board.length === 2 ? ok('every account is listed', `${board.length}`)
                   : bad('every account is listed', `${board.length}`);
(board[0].votes >= board[1].votes)
  ? ok('ranked by votes cast', `${board[0].votes} then ${board[1].votes}`)
  : bad('ranked by votes cast', board.map((r) => r.votes).join(' then '));
board[0].cats.length === 4
  ? ok('and each row shows the votes they cast, by category', board[0].cats.join(' '))
  : bad('and each row shows the votes they cast, by category', `${board[0].cats.length} chips`);
const boardNote = (await prev.locator('.sub-note').first().textContent()).replace(/\s+/g, ' ');
// The eligibility rule, stated on the board itself: an account and nothing
// else. It is the one thing that differs from /voting, and the people it
// matters most to — BLOOMs — have no reason to guess it.
/no scrobbler, and no streaming/i.test(boardNote)
  ? ok('and says an account is all you need')
  : bad('and says an account is all you need', boardNote.slice(0, 120));
/all you need to appear here is an account/i.test(boardNote)
  ? ok('and says it in those words')
  : bad('and says it in those words', boardNote.slice(0, 120));

console.log('--- sharing the numbers');
// A post travels further than the page it came from, so the text has to hold
// the same line the page does: the totals are what each ACT received, never
// what a fandom contributed. It also has to be worth posting before there are
// any numbers, which is when sharing matters most.
{
  // With numbers.
  await prev.evaluate((fix) => { COLLABS[0].tally = fix; PERIOD = 'all'; render(); }, FIX);
  await prev.waitForTimeout(250);
  const COLLABS_ACTS = await prev.evaluate(() =>
    COLLABS[0].theyGive.map((x) => x.who || x.nominee));
  const withNums = await prev.evaluate(() => ({
    text: shareTextFor(COLLABS[0], 'all'),
    len: shareLength(shareTextFor(COLLABS[0], 'all')),
    btn: !!document.querySelector('[data-share]'),
    x: (document.querySelector('[data-share-x]') || {}).href || '',
  }));
  withNums.btn ? ok('there is a share button') : bad('there is a share button');
  (/300/.test(withNums.text) && /100/.test(withNums.text))
    ? ok('and the text carries both totals', withNums.text.split('\n')[2])
    : bad('and the text carries both totals', withNums.text.replace(/\n/g, ' | '));
  // The claim the page refuses to make. "BLOOMs cast 100" is a vote traced to
  // a fandom, which nothing here can know.
  !/(BLOOMs|BLINKs) (cast|got|voted|contributed|gave)/i.test(withNums.text)
    ? ok('and never credits a fandom with votes')
    : bad('and never credits a fandom with votes', withNums.text.replace(/\n/g, ' | '));
  /blinksunited\.com\/collabs/.test(withNums.text)
    ? ok('and links back to the page') : bad('and links back to the page');
  // Every act by name, ROSÉ included. The first version of this joined the
  // list with a replace that dropped its own capture group, so the post read
  // "BLACKPINK, JENNIE & and 100 for BINI" — a member missing from a post
  // asking people to vote for her.
  {
    const want = COLLABS_ACTS.concat(['BINI']);
    const missing = want.filter((n) => !withNums.text.includes(n));
    missing.length === 0
      ? ok('and names every act, ROSÉ included', want.join(', '))
      : bad('and names every act, ROSÉ included', `missing ${missing.join(', ')}`);
  }
  // Something to DO, not just a scoreline — the point of the post is the
  // ballot, and a countdown is what makes somebody open it now.
  /left/i.test(withNums.text)
    ? ok('and says how long is left') : bad('and says how long is left', withNums.text.replace(/\n/g, ' | '));
  withNums.len <= 280
    ? ok('and fits in a post', `${withNums.len} chars as X counts them`)
    : bad('and fits in a post', `${withNums.len} chars`);
  /^https:\/\/x\.com\/intent\/post\?text=/.test(withNums.x)
    ? ok('the X button posts it, pre-filled')
    : bad('the X button posts it, pre-filled', withNums.x.slice(0, 60));
  decodeURIComponent((withNums.x.split('text=')[1] || '')) === withNums.text
    ? ok('with exactly the same text, encoded')
    : bad('with exactly the same text, encoded', decodeURIComponent((withNums.x.split('text=')[1] || '')).slice(0, 80));

  // The period follows the tab: a post saying "today" has to carry today's
  // figures, not all time's.
  const perTab = await prev.evaluate(() => ({
    today: shareTextFor(COLLABS[0], 'today'),
    all: shareTextFor(COLLABS[0], 'all'),
  }));
  (/\b9\b/.test(perTab.today) && /today/.test(perTab.today) && perTab.today !== perTab.all)
    ? ok('and follows the period tab', perTab.today.split('\n')[2])
    : bad('and follows the period tab', perTab.today.replace(/\n/g, ' | '));

  // Nothing counted yet — the case worth sharing most, and the one where a
  // scoreline would read as a dead campaign.
  const empty = await prev.evaluate(() => {
    const before = COLLABS[0].tally;
    COLLABS[0].tally = null; render();
    const out = { text: shareTextFor(COLLABS[0], 'all'),
                  btn: !!document.querySelector('[data-share]') };
    COLLABS[0].tally = before; render();
    return out;
  });
  empty.btn ? ok('the button is there before any votes exist')
            : bad('the button is there before any votes exist');
  !/\b0 votes\b/.test(empty.text)
    ? ok('and does not post a zero')
    : bad('and does not post a zero', empty.text.replace(/\n/g, ' | '));
  /neither side gives anything up/i.test(empty.text)
    ? ok('it posts the invitation instead', empty.text.split('\n')[2].slice(0, 70))
    : bad('it posts the invitation instead', empty.text.replace(/\n/g, ' | '));

  // The share itself: native sheet where there is one, clipboard otherwise,
  // and a cancelled sheet must not fall through to a copy nobody asked for.
  const shared = await prev.evaluate(async () => {
    const calls = { share: null, copy: null };
    const realShare = navigator.share, realClip = navigator.clipboard;
    Object.defineProperty(navigator, 'share',
      { configurable: true, value: (d) => { calls.share = d; return Promise.resolve(); } });
    Object.defineProperty(navigator, 'clipboard',
      { configurable: true, value: { writeText: (t) => { calls.copy = t; return Promise.resolve(); } } });
    shareCollab(COLLABS[0].id);
    await new Promise((r) => setTimeout(r, 80));
    const viaShare = { ...calls };
    calls.share = null; calls.copy = null;
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    shareCollab(COLLABS[0].id);
    await new Promise((r) => setTimeout(r, 80));
    const viaCopy = { ...calls };
    if (realShare) Object.defineProperty(navigator, 'share', { configurable: true, value: realShare });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: realClip });
    return { viaShare, viaCopy };
  });
  (shared.viaShare.share && !shared.viaShare.copy)
    ? ok('the share sheet is used where there is one, and the clipboard is left alone')
    : bad('the share sheet is used where there is one, and the clipboard is left alone',
          JSON.stringify(shared.viaShare).slice(0, 90));
  (shared.viaCopy.copy && /blinksunited/.test(shared.viaCopy.copy))
    ? ok('and it copies when there is not')
    : bad('and it copies when there is not', JSON.stringify(shared.viaCopy).slice(0, 90));
}

console.log('--- who is logging: people by declared side, never a split of the votes');
// The line this block has to hold. The bar above it is what each ACT received
// and cannot be attributed to a fandom — everyone votes the whole ballot. This
// counts PEOPLE, which self-declaration can answer. If the two ever merge, the
// page starts claiming it knows which fandom a vote came from, which is the
// one thing it has said all along that it cannot.
{
  // Shaped like what the ENDPOINT sends: byCat only, with forUs / forThem
  // derived on the page. That deriving step rebuilt the period object, which is
  // where `fandoms` was being dropped — with a fixture that supplies the two
  // totals directly, the branch never runs and the bug is invisible.
  const BARE = JSON.parse(JSON.stringify(FIX));
  delete BARE.periods.all.forUs;
  delete BARE.periods.all.forThem;

  // The bar as it reads with no fandoms at all. Asserted as "unchanged" rather
  // than against a number typed here: the invariant is that declaring a side
  // moves nothing about the per-act totals, and a hardcoded figure would test
  // my arithmetic instead of the page's behaviour.
  await prev.evaluate((fix) => { COLLABS[0].tally = fix; PERIOD = 'all'; render(); }, BARE);
  await prev.waitForTimeout(200);
  const barBefore = await prev.evaluate(() =>
    document.querySelector('.tally-nums').textContent.replace(/\s+/g, ' ').trim());

  const FAN = JSON.parse(JSON.stringify(BARE));
  FAN.periods.all.fandoms = {
    blink: { people: 8, votes: 160 },
    bloom: { people: 2, votes: 120 },
    unsaid: { people: 1, votes: 20 },
  };
  await prev.evaluate((fix) => { COLLABS[0].tally = fix; PERIOD = 'all'; render(); }, FAN);
  await prev.waitForTimeout(250);
  const f = await prev.evaluate(() => {
    const heads = [...document.querySelectorAll('.sub-head')].map((h) => h.textContent.trim());
    const cards = [...document.querySelectorAll('.fandom')].map((el) => ({
      name: el.querySelector('.fandom-name').textContent.trim(),
      top: el.querySelector('.fandom-n').textContent.trim(),
      foot: el.querySelector('.fandom-foot').textContent.replace(/\s+/g, ' ').trim(),
      fill: Math.round(parseFloat(el.querySelector('.fandom-fill').style.width)),
      pink: getComputedStyle(el.querySelector('.fandom-fill')).backgroundColor,
    }));
    const notes = [...document.querySelectorAll('.sub-note')].map((n) => n.textContent.replace(/\s+/g, ' '));
    return { heads, cards, notes, nums: document.querySelector('.tally-nums').textContent.replace(/\s+/g, ' ') };
  });
  f.heads.some((h) => /who is logging/i.test(h))
    ? ok('the block is there and says what it counts', f.heads.find((h) => /who is logging/i.test(h)))
    : bad('the block is there and says what it counts', f.heads.join(' | '));
  f.cards.length === 2 ? ok('both sides are listed', f.cards.map((c) => c.name).join(' / '))
                       : bad('both sides are listed', `${f.cards.length}`);
  (/8 people/.test(f.cards[0].top) && /2 people/.test(f.cards[1].top))
    ? ok('with the headcount each', `${f.cards[0].top} / ${f.cards[1].top}`)
    : bad('with the headcount each', `${f.cards[0].top} / ${f.cards[1].top}`);
  // The number that survives one side simply having more accounts: 160/8 = 20
  // each against 120/2 = 60 each, so the smaller side is AHEAD per person and
  // the page has to show it.
  (/20 votes each/.test(f.cards[0].foot) && /60 votes each/.test(f.cards[1].foot))
    ? ok('and the per-person average, which the headcount hides', f.cards[1].foot)
    : bad('and the per-person average, which the headcount hides',
          `${f.cards[0].foot} | ${f.cards[1].foot}`);
  // The BAR has to draw the comparable number. 8 people × 20 against 2 × 60 is
  // the whole trap: on totals the big side's bar is longer (160 vs 120) while
  // the fairer number printed underneath says the opposite, so the picture
  // would contradict the sentence.
  (f.cards[1].fill > f.cards[0].fill)
    ? ok('and the bar is drawn on votes each, not the total',
         `${f.cards[0].fill}% vs ${f.cards[1].fill}%`)
    : bad('and the bar is drawn on votes each, not the total',
          `${f.cards[0].fill}% vs ${f.cards[1].fill}% — the smaller side averages more and must be longer`);
  // The totals above are untouched by any of it.
  f.nums.trim() === barBefore
    ? ok('the per-act bar is unchanged by the split', barBefore)
    : bad('the per-act bar is unchanged by the split', `${barBefore} → ${f.nums.trim()}`);
  const note = f.notes.join(' ');
  /this is not the bar/i.test(note)
    ? ok('and the block says it is not the bar')
    : bad('and the block says it is not the bar', note.slice(0, 120));
  /cannot be traced to a fandom/i.test(note)
    ? ok('and repeats that a vote cannot be traced to a fandom')
    : bad('and repeats that a vote cannot be traced to a fandom', note.slice(0, 160));
  /self-declared/i.test(note)
    ? ok('and that it is self-declared')
    : bad('and that it is self-declared', note.slice(0, 160));
  /1 person has not said/i.test(note)
    ? ok('and people who did not say are counted honestly, not assigned')
    : bad('and people who did not say are counted honestly, not assigned', note.slice(0, 200));

  // Before anyone has said anything the two sides are STILL drawn. The shape is
  // the explanation — who can appear and what gets compared — and a lone
  // sentence where a structure should be reads as a feature that was never
  // built. That is what it did on the first preview.
  //
  // What it must not do is fill the tracks: a segment of any width is a claim,
  // and two part-full bars read as a dead heat nobody is in.
  const NONE = JSON.parse(JSON.stringify(BARE));
  NONE.periods.all.fandoms = {};
  await prev.evaluate((fix) => { COLLABS[0].tally = fix; render(); }, NONE);
  await prev.waitForTimeout(200);
  const empty = await prev.evaluate(() => ({
    cards: [...document.querySelectorAll('.fandom')].map((el) => ({
      name: el.querySelector('.fandom-name').textContent.trim(),
      waiting: el.classList.contains('fandom-waiting'),
      fills: el.querySelectorAll('.fandom-fill').length,
      foot: el.querySelector('.fandom-foot').textContent.trim(),
      shown: el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
    })),
    notes: [...document.querySelectorAll('.sub-note')].map((n) => n.textContent.replace(/\s+/g, ' ')),
  }));
  (empty.cards.length === 2 && empty.cards.every((c) => c.waiting && c.shown))
    ? ok('with nothing declared, both sides are still drawn AND on screen',
         empty.cards.map((c) => c.name).join(' / '))
    : bad('with nothing declared, both sides are still drawn AND on screen', JSON.stringify(empty.cards));
  empty.cards.every((c) => c.fills === 0)
    ? ok('and neither track is filled, so there is no 0–0 race')
    : bad('and neither track is filled, so there is no 0–0 race', JSON.stringify(empty.cards));
  empty.cards.every((c) => /nobody yet/i.test(c.foot))
    ? ok('and each says it is waiting rather than showing a zero')
    : bad('and each says it is waiting rather than showing a zero',
          empty.cards.map((c) => c.foot).join(' | '));
  empty.notes.some((n) => /no one has said which side/i.test(n))
    ? ok('with the explanation underneath')
    : bad('with the explanation underneath', empty.notes.join(' | ').slice(0, 120));
  // Said here because it is the moment somebody decides whether to bother:
  // a smaller fandom should know it is not structurally losing.
  empty.notes.some((n) => /never behind for being smaller/i.test(n))
    ? ok('and it says a smaller side is not behind for being smaller')
    : bad('and it says a smaller side is not behind for being smaller',
          empty.notes.join(' | ').slice(0, 160));
  await prev.evaluate((fix) => { COLLABS[0].tally = fix; render(); }, FIX);
  await prev.waitForTimeout(200);
}

console.log('--- a day opens its own breakdown');
const dayCells = await prev.locator('.day.has').count();
dayCells === 3 ? ok('the three days with votes are tappable', `${dayCells}`)
               : bad('the three days with votes are tappable', `${dayCells}`);
(await prev.locator('.day-detail').count()) === 0
  ? ok('no day is open to start with') : bad('no day is open to start with');
await prev.locator('.day.has').first().click();
await prev.waitForTimeout(250);
const detail = await prev.evaluate(() => {
  const d = document.querySelector('.day-detail');
  return d && { hd: d.querySelector('.day-detail-hd').textContent.replace(/\s+/g, ' ').trim(),
                rows: d.querySelectorAll('.split-row').length };
});
(detail && /16 Oct/.test(detail.hd) && /\b40\b/.test(detail.hd))
  ? ok('tapping a day opens that day', detail.hd)
  : bad('tapping a day opens that day', JSON.stringify(detail));
(detail && detail.rows === 2)
  ? ok('with that day’s own split', `${detail.rows} categories`)
  : bad('with that day’s own split', JSON.stringify(detail));
await prev.locator('.day.has').first().click();
await prev.waitForTimeout(200);
(await prev.locator('.day-detail').count()) === 0
  ? ok('and tapping it again closes it') : bad('and tapping it again closes it');

// Put the page back for the checks that follow.
await prev.evaluate(() => { COLLABS[0].tally = null; PERIOD = 'all'; render(); });
await prev.waitForTimeout(200);

console.log('--- the page reads /api/collabs and works out the two totals itself');
// The endpoint returns picks keyed by ballot category and nothing else — it
// does not know whose nominee is whose, on purpose, so that list lives in one
// place. Which means the split between the two totals happens HERE, and a
// mis-assignment would show as a bar crediting the wrong act while every
// number on the page still added up. 100 + 100 + 60 ours, 100 theirs.
{
  const API = {
    todayKey: '2026-10-18', from: '2026-10-16',
    periods: {
      today: { byCat: { 'favorite-music-group-or-duo': 3, 'favorite-global-music-star': 1 }, board: [] },
      week:  { byCat: {}, board: [] },
      all:   { byCat: { 'favorite-music-group-or-duo': 100, 'favorite-music-collaboration': 100,
                        'favorite-female-artist': 60, 'favorite-global-music-star': 100 },
               board: [{ name: 'rllyanav', votes: 24, byCat: { 'favorite-music-group-or-duo': 12 } }] },
    },
    days: [{ day: '2026-10-16', votes: 360, byCat: { 'favorite-global-music-star': 100 } }],
  };
  const live = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await live.route('**/api/collabs*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(API),
  }));
  await live.goto(base + '/collabs', { waitUntil: 'domcontentloaded' });
  let got = null;
  for (let i = 0; i < 40 && !got; i++) {
    await live.waitForTimeout(250);
    got = await live.evaluate(() => {
      const n = document.querySelector('.tally-nums');
      if (!n || /not counting/i.test(n.textContent)) return null;
      const track = document.querySelector('.bar').getBoundingClientRect().width;
      const pct = (s) => {
        const el = document.querySelector(s);
        return el ? Math.round(el.getBoundingClientRect().width / track * 100) : null;
      };
      return { nums: n.textContent.replace(/\s+/g, ' ').trim(), us: pct('.bar-us'), them: pct('.bar-them'),
               board: document.querySelectorAll('.board tbody tr').length,
               days: document.querySelectorAll('.day.has').length };
    }).catch(() => null);
  }
  if (!got) bad('the fetched tally is adopted', 'the card still says not counting yet');
  else {
    // 260 of 360 is 72%. If BINI were summed into our side it would read 100%.
    (/\b260\b/.test(got.nums) && /\b100\b/.test(got.nums))
      ? ok('the two totals are summed from the right categories', got.nums)
      : bad('the two totals are summed from the right categories', got.nums);
    (Math.abs(got.us - 72) <= 1 && Math.abs(got.them - 28) <= 1)
      ? ok('and the bar is drawn from them', `${got.us}% / ${got.them}%`)
      : bad('and the bar is drawn from them', `${got.us}% / ${got.them}% — expected 72/28`);
    got.board === 1 ? ok('the board rendered from the endpoint') : bad('the board rendered from the endpoint', `${got.board} rows`);
    got.days === 1 ? ok('and so did the day grid') : bad('and so did the day grid', `${got.days} days`);
  }
  await live.close();

  // An endpoint that answers but has nothing in it must leave the card alone.
  const empty = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await empty.route('**/api/collabs*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ todayKey: '2026-10-18', from: null, days: [],
      periods: { today: { byCat: {}, board: [] }, week: { byCat: {}, board: [] }, all: { byCat: {}, board: [] } } }),
  }));
  await empty.goto(base + '/collabs', { waitUntil: 'domcontentloaded' });
  await empty.waitForTimeout(2500);
  const stillHonest = await empty.evaluate(() =>
    /not counting/i.test(document.querySelector('.tally-nums').textContent)
    && document.querySelectorAll('.bar-us, .bar-them').length === 0);
  stillHonest ? ok('a collab nobody has voted in yet still says so')
              : bad('a collab nobody has voted in yet still says so', 'a 0–0 bar was drawn');
  await empty.close();
}

console.log('--- the board and the day grid are drawn before any votes exist');
// With no data they used to render as nothing, which is indistinguishable from
// not having been built. The structure is the explanation: a reader should be
// able to see what will be counted, who can appear, and that the campaign runs
// day by day, before the first vote is logged.
{
  const bare = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  // No endpoint at all — the hardest case, and the one that is live today.
  await bare.route('**/api/collabs*', (route) => route.abort());
  await bare.goto(base + '/collabs', { waitUntil: 'domcontentloaded' });
  await bare.waitForTimeout(1200);
  const shape = await bare.evaluate(() => ({
    tabs: document.querySelectorAll('.tab').length,
    headers: [...document.querySelectorAll('.board th')].map((t) => t.textContent.trim()),
    boardRows: document.querySelectorAll('.board tbody tr').length,
    boardEmpty: (document.querySelector('.board-empty') || {}).textContent || '',
    note: (document.querySelector('.sub-note') || {}).textContent || '',
    dayCells: document.querySelectorAll('.day').length,
    filledDays: document.querySelectorAll('.day.has').length,
    hasToday: !!document.querySelector('.day.today'),
    counting: !/not counting/i.test(document.querySelector('.tally-nums').textContent),
  }));
  shape.headers.length === 3 ? ok('the board shows its columns', shape.headers.join(' / '))
                             : bad('the board shows its columns', JSON.stringify(shape.headers));
  // No streams column: that is the rule difference from /voting, and a column
  // headed Streams here would state the opposite of the eligibility note.
  !shape.headers.some((h) => /stream/i.test(h))
    ? ok('and no streams column, unlike /voting')
    : bad('and no streams column, unlike /voting', shape.headers.join(' / '));
  (shape.boardRows === 0 && /be the first/i.test(shape.boardEmpty))
    ? ok('with an empty state rather than a fake row', shape.boardEmpty.trim())
    : bad('with an empty state rather than a fake row', JSON.stringify(shape));
  /all you need to appear here is an account/i.test(shape.note)
    ? ok('and the eligibility rule is readable with no data')
    : bad('and the eligibility rule is readable with no data', shape.note.slice(0, 90));
  // The grid spans the voting window, so it is many days wide on day one.
  shape.dayCells >= 14 ? ok('the day grid covers the whole window', `${shape.dayCells} cells`)
                       : bad('the day grid covers the whole window', `${shape.dayCells} cells`);
  shape.filledDays === 0 ? ok('with no day claiming votes') : bad('with no day claiming votes', `${shape.filledDays}`);
  shape.hasToday ? ok('and today marked on it') : bad('and today marked on it');
  !shape.counting ? ok('while the bar still says it is not counting')
                  : bad('while the bar still says it is not counting');
  shape.tabs === 3 ? ok('and the three tabs are there') : bad('and the three tabs are there', `${shape.tabs}`);
  await bare.close();
}

console.log('--- the bar sits under the countdown, not at the bottom');
// Its position is the point: once a trade is running this is the live number
// people reopen the page for, and it belongs above the reference material
// rather than below two columns of it. Ordering of template expressions, which
// nothing else would notice a change to.
const order = await prev.evaluate(() => [...document.querySelectorAll('.collab')].map((el) => {
  const y = (sel) => { const n = el.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().top) : null; };
  return { id: el.dataset.collab, deadline: y('.collab-deadline'), tally: y('.tally'),
           why: y('.collab-why'), sides: y('.sides') };
}));
for (const o of order) {
  const seq = [o.deadline, o.tally, o.why, o.sides];
  if (seq.some((v) => v === null)) { bad(`${o.id}: every block is present`, JSON.stringify(o)); continue; }
  seq.every((v, i) => i === 0 || v > seq[i - 1])
    ? ok(`${o.id}: countdown → bar → why → the two sides`, seq.join(' < '))
    : bad(`${o.id}: countdown → bar → why → the two sides`, JSON.stringify(o));
}

console.log('--- an upcoming collab counts down to its OPENING, not its deadline');
// A collab both sides have agreed to but whose ballot has not opened. It is
// public — the difference from 'proposed' is consent, not timing — so the one
// thing it must not do is look like something you can act on: a deadline
// countdown, a board with nobody on it and an "open the ballot" button all say
// "you are late" about a thing that has not started.
//
// Injected rather than waited for, for the same reason the proposed case is:
// there is no upcoming collab today, so the branch would otherwise ship having
// never rendered.
{
  const up = await prev.evaluate(() => {
    const before = COLLABS.slice();
    const opens = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10) + 'T04:00:00Z';
    COLLABS.push({
      id: '__test-upcoming', status: 'upcoming', award: 'Test Awards 2027',
      opens: opens, deadline: new Date(Date.now() + 30 * 86400000).toISOString(),
      from: opens.slice(0, 10), voteUrl: 'https://example.com/',
      partner: { name: 'Test Page', fandom: 'Testers', act: 'Nobody' },
      weGive: [{ slug: 'x', cat: 'Theirs', nominee: 'Nobody', who: 'Nobody' }],
      theyGive: [{ slug: 'y', cat: 'Ours', nominee: 'BLACKPINK', who: 'BLACKPINK' }],
      why: 'test', tally: null, pending: [],
    });
    render();
    const el = document.querySelector('[data-collab="__test-upcoming"]');
    const dl = el && el.querySelector('.collab-deadline');
    const out = {
      drawn: !!el,
      status: el ? (el.querySelector('.collab-status') || {}).textContent.trim() : '',
      countdown: dl ? dl.textContent.trim() : '',
      opensFlag: dl ? dl.dataset.opens : null,
      target: dl ? dl.dataset.deadline : null,
      opens: opens,
      // Nothing to count, so none of the counting furniture may appear.
      tally: el ? el.querySelectorAll('.tally').length : -1,
      board: el ? el.querySelectorAll('.board').length : -1,
      days: el ? el.querySelectorAll('.days').length : -1,
      ballotBtn: el ? [...el.querySelectorAll('a.btn')]
        .filter((a) => /open the ballot/i.test(a.textContent)).length : -1,
      soon: el ? (el.querySelector('.collab-soon') || {}).textContent.replace(/\s+/g, ' ').trim() : '',
      // And the groups get headings, because there is now more than one.
      heads: [...document.querySelectorAll('.group-head')].map((h) => h.textContent.trim()),
    };
    COLLABS.length = 0; before.forEach((c) => COLLABS.push(c)); render();
    return out;
  });
  up.drawn ? ok('an agreed-but-not-open collab IS shown publicly')
           : bad('an agreed-but-not-open collab IS shown publicly', 'not rendered');
  /upcoming/i.test(up.status) ? ok('and is marked Upcoming', up.status)
                              : bad('and is marked Upcoming', up.status || '(no marker)');
  // The whole point of the state: the number on the card is time until it
  // STARTS, taken from `opens`, and labelled so it cannot be read as a deadline.
  (up.target === up.opens && up.opensFlag === '1' && /^OPENS IN/.test(up.countdown))
    ? ok('the countdown runs to the opening and says so', up.countdown)
    : bad('the countdown runs to the opening and says so',
          `${up.countdown} → ${up.target} (wanted ${up.opens})`);
  (up.tally === 0 && up.board === 0 && up.days === 0)
    ? ok('and nothing pretends to be counting yet', 'no bar, no board, no day grid')
    : bad('and nothing pretends to be counting yet',
          `tally ${up.tally} / board ${up.board} / days ${up.days}`);
  up.ballotBtn === 0 ? ok('and no button to a ballot that is not open')
                     : bad('and no button to a ballot that is not open', `${up.ballotBtn} button(s)`);
  /voting opens/i.test(up.soon) ? ok('and it says when it opens, in words', up.soon.slice(0, 70))
                                : bad('and it says when it opens, in words', up.soon || '(nothing)');
  // One group needs no heading; two do, or the live and upcoming cards read as
  // one undifferentiated list.
  (up.heads.length >= 2 && up.heads.some((h) => /running/i.test(h)) && up.heads.some((h) => /coming up/i.test(h)))
    ? ok('and the two groups are labelled', up.heads.join(' / '))
    : bad('and the two groups are labelled', up.heads.join(' / ') || '(none)');
  const oneGroup = await prev.evaluate(() => document.querySelectorAll('.group-head').length);
  oneGroup === 0 ? ok('while a single group carries no heading')
                 : bad('while a single group carries no heading', `${oneGroup} heading(s)`);
}

console.log('--- the worked example of that card is reachable, and only on purpose');
// The state is invisible while nothing is in it, so ?demo=upcoming draws one
// to look at. It names nobody real and it must never appear without the flag:
// an example card on the public page is indistinguishable, to a reader, from
// an announced partnership.
{
  const noFlag = await prev.evaluate(() => ({
    cards: [...document.querySelectorAll('.collab')].map((el) => el.dataset.collab),
    text: /EXAMPLE/.test(document.body.innerText),
  }));
  (!noFlag.cards.includes('__demo-upcoming') && !noFlag.text)
    ? ok('no example card on the page as served')
    : bad('no example card on the page as served', noFlag.cards.join(', '));
  const demo = await open('/collabs?demo=upcoming');
  const shownDemo = await demo.evaluate(() => {
    const el = document.querySelector('[data-collab="__demo-upcoming"]');
    return el && {
      status: (el.querySelector('.collab-status') || {}).textContent.trim(),
      opens: !!el.querySelector('.collab-deadline[data-opens="1"]'),
      says: el.innerText.replace(/\s+/g, ' '),
      others: document.querySelectorAll('.collab').length,
    };
  });
  shownDemo ? ok('?demo=upcoming draws one', `${shownDemo.others} cards`)
            : bad('?demo=upcoming draws one', 'nothing rendered');
  if (shownDemo) {
    (/upcoming/i.test(shownDemo.status) && shownDemo.opens)
      ? ok('as an upcoming card counting down to its opening')
      : bad('as an upcoming card counting down to its opening', JSON.stringify(shownDemo.status));
    // It says what it is, in the card itself — not only in the URL, which is
    // the part that does not survive a screenshot.
    /this card is an example, not a real collab/i.test(shownDemo.says)
      ? ok('and says on its face that it is an example')
      : bad('and says on its face that it is an example', shownDemo.says.slice(0, 90));
  }
  await demo.close();
}

console.log('--- ?demo=a / ?demo=b: the two versions a fanbase is choosing between');
// A fanbase is being asked which version it wants, and an empty board cannot
// be judged. Both links show the SAME invented figures so the only difference
// is the thing being voted on — and both say, on the card, that the figures
// are invented, because a screenshot travels further than a URL does.
{
  const clean = await prev.evaluate(() => ({
    banner: document.querySelectorAll('.demo-banner').length,
    counting: !/not counting/i.test(document.querySelector('.tally-nums').textContent),
  }));
  (clean.banner === 0 && !clean.counting)
    ? ok('no sample numbers on the page as served')
    : bad('no sample numbers on the page as served', JSON.stringify(clean));

  const shots = {};
  for (const opt of ['a', 'b']) {
    const d = await open(`/collabs?demo=${opt}`);
    shots[opt] = await d.evaluate(() => ({
      banner: (document.querySelector('.demo-banner') || {}).textContent || '',
      nums: (document.querySelector('.tally-nums') || {}).textContent.replace(/\s+/g, ' ').trim(),
      sides: document.querySelectorAll('.fandom').length,
      board: document.querySelectorAll('.board tbody tr').length,
      days: document.querySelectorAll('.day.has').length,
      bannerFirst: (() => {
        const card = document.querySelector('.collab');
        const b = card.querySelector('.demo-banner'), t = card.querySelector('.tally');
        return !!(b && t && b.getBoundingClientRect().top < t.getBoundingClientRect().top);
      })(),
    }));
    await d.close();
  }
  for (const opt of ['a', 'b']) {
    /sample numbers/i.test(shots[opt].banner)
      ? ok(`${opt}: says the figures are made up`)
      : bad(`${opt}: says the figures are made up`, shots[opt].banner.slice(0, 60));
    // Above the numbers, not under them: a banner below the bar is cropped out
    // of the screenshot that gets shared.
    shots[opt].bannerFirst
      ? ok(`${opt}: and says it ABOVE the numbers, where a crop keeps it`)
      : bad(`${opt}: and says it ABOVE the numbers, where a crop keeps it`);
    new RegExp(`option ${opt}`, 'i').test(shots[opt].banner)
      ? ok(`${opt}: and names which option this is`)
      : bad(`${opt}: and names which option this is`, shots[opt].banner.slice(0, 90));
    (shots[opt].board > 0 && shots[opt].days > 0)
      ? ok(`${opt}: the board and the day grid have something in them`,
           `${shots[opt].board} rows, ${shots[opt].days} days`)
      : bad(`${opt}: the board and the day grid have something in them`, JSON.stringify(shots[opt]));
  }
  // The whole point of the pair: identical except for the one thing being
  // chosen. If the totals differed, the fanbase would be comparing two
  // different collabs rather than two presentations of one.
  shots.a.nums === shots.b.nums
    ? ok('both options show the same votes', shots.a.nums)
    : bad('both options show the same votes', `${shots.a.nums} vs ${shots.b.nums}`);
  (shots.a.sides === 0 && shots.b.sides === 2)
    ? ok('and differ only in the turnout block', `a: ${shots.a.sides} · b: ${shots.b.sides}`)
    : bad('and differ only in the turnout block', `a: ${shots.a.sides} · b: ${shots.b.sides}`);
  // Option B's sample has to show the case the block exists for, or it is a
  // picture that flatters the bigger fandom and the choice is made on it.
  const b = await open('/collabs?demo=b');
  const each = await b.evaluate(() => [...document.querySelectorAll('.fandom')].map((el) => ({
    name: el.querySelector('.fandom-name').textContent.trim(),
    foot: el.querySelector('.fandom-foot').textContent.replace(/\s+/g, ' ').trim(),
    fill: Math.round(parseFloat(el.querySelector('.fandom-fill').style.width)),
  })));
  await b.close();
  (each.length === 2 && each[1].fill > each[0].fill)
    ? ok('and the smaller side leads per person, as the block is meant to show',
         `${each[0].foot} | ${each[1].foot}`)
    : bad('and the smaller side leads per person, as the block is meant to show',
          JSON.stringify(each));
}

console.log('--- the request form: a collab can be proposed from here');
// The page could only ever describe trades we had already arranged. A partner
// page that finds us has to be able to ask, and the "no collabs" note links
// #request — which pointed at nothing at all until this existed.
{
  const form = await prev.evaluate(() => {
    const sec = document.getElementById('request');
    return {
      exists: !!sec,
      fields: ['req-page', 'req-act', 'req-award', 'req-cats', 'req-contact', 'req-note']
        .filter((id) => !document.getElementById(id)),
      required: ['req-page', 'req-act', 'req-award', 'req-cats', 'req-contact']
        .filter((id) => !document.getElementById(id)?.required),
      // The promise the status machinery actually keeps, made to the person
      // proposing: their name does not go up until they have said yes.
      says: (sec || {}).innerText || '',
    };
  });
  form.exists ? ok('#request exists, so the empty-state link resolves')
              : bad('#request exists, so the empty-state link resolves');
  form.fields.length === 0 ? ok('every field is present') : bad('every field is present', `missing ${form.fields.join(', ')}`);
  form.required.length === 0 ? ok('and the four facts plus a contact are required')
                             : bad('and the four facts plus a contact are required', form.required.join(', '));
  /nothing appears on this page until both sides have agreed/i.test(form.says.replace(/\s+/g, ' '))
    ? ok('and it promises not to announce them before they agree')
    : bad('and it promises not to announce them before they agree', form.says.replace(/\s+/g, ' ').slice(0, 120));

  // Submitting, with the POST captured. The body is the whole deliverable here:
  // four labelled facts in a fixed order, the contact, and a reply channel
  // DERIVED from what the contact looks like rather than asked twice.
  const send = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  let posted = null;
  await send.route('**/api/feedback', (route) => {
    posted = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await send.goto(base + '/collabs', { waitUntil: 'domcontentloaded' });
  await send.waitForTimeout(400);

  // Whitespace is not an answer. `required` is satisfied by a single space, so
  // without the trimmed check a proposal with no act at all would be accepted
  // and sit in the queue as a mystery.
  await send.fill('#req-page', '  ');
  await send.fill('#req-act', 'Nobody');
  await send.fill('#req-award', 'Test Awards');
  await send.fill('#req-cats', 'Some Category');
  await send.fill('#req-contact', '@nobody');
  await send.click('#req-btn');
  await send.waitForTimeout(250);
  (posted === null && /fill in/i.test(await send.locator('#req-msg').textContent()))
    ? ok('a blank-but-not-empty field is refused, and nothing is sent')
    : bad('a blank-but-not-empty field is refused, and nothing is sent', JSON.stringify(posted));

  await send.fill('#req-page', 'Test Voting Page');
  await send.fill('#req-cats', 'Favorite Test Act\nBest Test');
  await send.fill('#req-note', 'Voting opens next week.');
  await send.click('#req-btn');
  await send.waitForTimeout(500);
  if (!posted) bad('submitting posts the proposal', 'nothing was posted');
  else {
    posted.category === 'collab'
      ? ok('posted to the feedback inbox as a collab', posted.category)
      : bad('posted to the feedback inbox as a collab', String(posted.category));
    // A handle, not an address → answered by hand. The queue decides who is
    // still waiting from this field, so a wrong one leaves them unanswered.
    posted.replyVia === 'handle'
      ? ok('a handle is routed to the by-hand reply', posted.replyVia)
      : bad('a handle is routed to the by-hand reply', String(posted.replyVia));
    posted.contact === '@nobody' ? ok('and the contact is carried') : bad('and the contact is carried', String(posted.contact));
    // `username` means a scrobbler name everywhere else on the site and the
    // admin queue prints it as "Last.fm …", so a page name must not go there.
    !posted.username ? ok('and no page name is passed off as a scrobbler username')
                     : bad('and no page name is passed off as a scrobbler username', String(posted.username));
    const msg = String(posted.message || '');
    const wanted = [/COLLAB REQUEST/, /Page \/ fandom: Test Voting Page/, /Act: Nobody/,
                    /Award: Test Awards/, /Favorite Test Act · Best Test/, /Voting opens next week\./];
    const missing = wanted.filter((re) => !re.test(msg));
    missing.length === 0
      ? ok('and every field is in the one message the inbox stores', `${msg.length} chars`)
      : bad('and every field is in the one message the inbox stores', missing.join(', '));
    // The note goes last and is capped in the form, so the API's 2000-character
    // truncation can only ever cut the end of the note rather than one of the
    // four facts the proposal is judged on.
    // Asserted as "the note is the LAST thing in the message" rather than
    // "after the award line": a note tucked between two facts also satisfies
    // the looser version while leaving a fact exposed to the cut.
    (msg.trimEnd().endsWith('Voting opens next week.') && msg.length < 2000)
      ? ok('with the free text last, so truncation cannot eat a fact')
      : bad('with the free text last, so truncation cannot eat a fact', `${msg.length} chars`);
    /thank you/i.test(await send.locator('#req-msg').textContent())
      ? ok('and the sender is told it went') : bad('and the sender is told it went');
  }

  // An address takes the route that can send on its own.
  posted = null;
  await send.reload({ waitUntil: 'domcontentloaded' });
  await send.waitForTimeout(400);
  for (const [sel, v] of [['#req-page', 'Test Page'], ['#req-act', 'Nobody'],
                          ['#req-award', 'Test Awards'], ['#req-cats', 'Best Test'],
                          ['#req-contact', 'them@example.com']]) await send.fill(sel, v);
  await send.click('#req-btn');
  await send.waitForTimeout(400);
  (posted && posted.replyVia === 'email')
    ? ok('an email address is routed to the email reply', posted.replyVia)
    : bad('an email address is routed to the email reply', posted ? String(posted.replyVia) : 'nothing posted');

  // A failure has to say so and leave the proposal re-sendable, not swallow it.
  posted = null;
  await send.unroute('**/api/feedback');
  await send.route('**/api/feedback', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Feedback service not configured' }) }));
  await send.reload({ waitUntil: 'domcontentloaded' });
  await send.waitForTimeout(400);
  for (const [sel, v] of [['#req-page', 'Test Page'], ['#req-act', 'Nobody'],
                          ['#req-award', 'Test Awards'], ['#req-cats', 'Best Test'],
                          ['#req-contact', '@nobody']]) await send.fill(sel, v);
  await send.click('#req-btn');
  await send.waitForTimeout(400);
  const failState = await send.evaluate(() => ({
    msg: document.getElementById('req-msg').textContent,
    cls: document.getElementById('req-msg').className,
    disabled: document.getElementById('req-btn').disabled,
    kept: document.getElementById('req-act').value,
  }));
  (/not configured/i.test(failState.msg) && /err/.test(failState.cls)
    && !failState.disabled && failState.kept === 'Nobody')
    ? ok('a rejected proposal says why, keeps what they typed and can be re-sent', failState.msg)
    : bad('a rejected proposal says why, keeps what they typed and can be re-sent', JSON.stringify(failState));
  await send.close();
}

console.log('--- the page itself');
// It carries the same escape hatch as the other standalone pages.
const backOk = await prev.evaluate(() => {
  const a = document.querySelector('a.back');
  return !!(a && a.getAttribute('href') === '/index.html' && a.getClientRects().length);
});
backOk ? ok('links back to the homepage') : bad('links back to the homepage');

const links = await prev.evaluate(() => [...document.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute('href')));
for (const href of [...new Set(links)]) {
  const r = await prev.request.get(base + href);
  r.ok() ? ok(`${href} resolves`) : bad(`${href} resolves`, `HTTP ${r.status()}`);
}
// A deadline that has already passed would show a live "open the ballot" button.
const stale = await prev.evaluate(() => COLLABS.filter((c) =>
  c.status !== 'ended' && c.deadline && new Date(c.deadline).getTime() <= Date.now()).map((c) => c.id));
stale.length === 0 ? ok('no collab is past its deadline but still marked open')
                   : bad('no collab is past its deadline but still marked open', stale.join(', '));

for (const w of [390, 1200]) {
  await prev.setViewportSize({ width: w, height: 1000 });
  await prev.waitForTimeout(300);
  const over = await prev.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  over <= 0 ? ok(`no sideways scroll at ${w}px`) : bad(`no sideways scroll at ${w}px`, `${over}px`);
}
if (errs.length) bad('no page errors', errs.join(' | ')); else ok('no page errors', 'none');

await prev.close();
await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
