// Drive the real /voting page and check the Kids' Choice Awards card.
//
// Run: node .github/scripts/test_vote_kca.mjs
//
// A voting page is the one place on this site where being wrong costs a blink
// something real — a dead link, a category that isn't ours, or a made-up rule
// sends them somewhere useless. So the things asserted here are the things that
// were actually verified against the live vote pages in probe-kca.yml
// (run 37930904572), and the things that were NOT verified are asserted to be
// absent:
//
//   * the deadline is the END of the last day the official rules name
//     (Oct 8 - Nov 13), not the show date (Nov 14) — voting shuts before the
//     ceremony
//   * the "100 a day" figure is contradicted, not repeated: the published rules
//     allow repeat voting and state NO number, and a search traced that figure
//     to a different award entirely
//   * the card links ONCE, to the hub. Nothing is submitted until a round is
//     finished, so a per-category deep link drops someone exactly where a round
//     gets abandoned. The card used to carry three of them; it must not again.
//   * the round rule is not in the rules list at all. It is the one line that
//     COSTS the vote if missed, and in a grey 0.7rem list it read like "no
//     account needed" — so it is a band of its own, directly above the button
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const INDEX = new URL('../../index.html', import.meta.url).pathname;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

const p = await b.newPage({ viewport: { width: 412, height: 1200 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.route('**/*', async route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/voting' || u.pathname === '/')
    return route.fulfill({ path: INDEX, contentType: 'text/html' });
  if (u.hostname.includes('fonts.g')) return route.continue();
  if (u.pathname.startsWith('/api/'))
    return route.fulfill({ contentType: 'application/json', body: '{}' });
  return route.fulfill({ status: 204, body: '' });
});
await p.goto('https://www.blinksunited.com/voting', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.evaluate(() => {
  try { closeTutorial(); } catch {}
  document.getElementById('tutorial-overlay')?.remove();
  document.getElementById('ext-update-overlay')?.remove();
});
await p.evaluate(() => { try { renderVoteCampaigns(); } catch (e) { console.error(e); } });
await p.waitForTimeout(400);

const kca = await p.evaluate(() => {
  // A top-level `const` in a classic script lives in the global LEXICAL
  // environment, so it resolves as a bare identifier but is NOT a property
  // of window — reading it off window silently gives undefined.
  const all = typeof VOTE_CAMPAIGNS !== 'undefined' ? VOTE_CAMPAIGNS : [];
  const c = all.find(x => x.id === 'kca-2026');
  const card = [...document.querySelectorAll('#vote-list .vote-card')]
    .find(el => /Kids.{0,3} Choice/i.test(el.textContent));
  if (!card) return { missing: true, data: c || null };
  return {
    data: c,
    deadline: card.querySelector('.vote-deadline')?.textContent.trim(),
    cats: [...card.querySelectorAll('.vote-cat-row')].map(r => ({
      name: r.querySelector('.vote-category-name')?.textContent.replace(/Vote ↗/, '').trim(),
      href: r.querySelector('.vote-cat-link')?.getAttribute('href') || null,
      us: [...r.querySelectorAll('.vote-chip.us')].map(x => x.textContent.trim()),
      all: [...r.querySelectorAll('.vote-chip')].length,
      thumb: !!r.querySelector('.vote-cat-thumb'),
    })),
    rules: [...card.querySelectorAll('.vote-rules li')].map(x => x.textContent.trim()),
    alert: card.querySelector('.vote-alert-text')?.textContent.trim() || null,
    // Where it sits relative to the button is the whole point of promoting it.
    alertBeforeBtn: (() => {
      const a = card.querySelector('.vote-alert'), btn = card.querySelector('.vote-btn');
      if (!a || !btn) return null;
      return !!(a.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING);
    })(),
    alertSize: (() => {
      const a = card.querySelector('.vote-alert-text');
      const li = card.querySelector('.vote-rules li');
      if (!a || !li) return null;
      return [parseFloat(getComputedStyle(a).fontSize), parseFloat(getComputedStyle(li).fontSize)];
    })(),
    voteBtn: card.querySelector('.vote-btn')?.getAttribute('href'),
    inPast: !!card.closest('.vote-past, .vote-ended, [data-past]'),
  };
});

console.log('--- the card is there and live');
check(!kca.missing, 'a Kids’ Choice card renders in #vote-list');
check(!kca.inPast, 'in the active list, not folded into Past Votings');
check(/\d+D/.test(kca.deadline || ''),
      `with a live countdown now that the period is published (${kca.deadline})`);

console.log('\n--- the deadline is the end of the stated period, not the show');
const dl = Date.parse(kca.data.deadline);
check(!Number.isNaN(dl), `a deadline is set (${kca.data.deadline})`);
// The official rules say Oct 8 - Nov 13 with no clock time and note that
// closing times differ by region, so the deadline must land INSIDE Nov 13
// somewhere on earth and before the Nov 14 ceremony.
check(dl > Date.parse('2026-11-13T08:00:00Z') && dl < Date.parse('2026-11-14T12:00:00Z'),
      'it falls at the end of Nov 13, not mid-day and not on show day');
check(dl < Date.parse('2026-11-14T17:00:00Z'),
      'and well before the ceremony — the show date is never the deadline');
check(kca.deadline !== 'VOTING OPEN' && /\d/.test(kca.deadline || ''),
      `so the card counts down instead of saying VOTING OPEN (${kca.deadline})`);

console.log('\n--- the three categories, and exactly one link off the card');
const want = ['Favorite Music Group or Duo', 'Favorite Female Artist',
              'Favorite Music Collaboration'];
check(kca.cats.length === 3, `three categories (${kca.cats.length})`);
for (const name of want) {
  check(kca.cats.some(c => c.name === name), `"${name}" is on the card`);
}
// The deep links are the regression to guard. A round only submits at the end,
// so landing someone inside one category is landing them where rounds die.
check(kca.cats.every(c => c.href === null),
      `no per-category "Vote ↗" link (${kca.cats.map(c => c.href).join(', ')})`);
check(!JSON.stringify(kca.data.categories).includes('kca.nick.tv'),
      'and no category carries a url at all in the data');

console.log('\n--- ours, and only ours');
const byName = Object.fromEntries(kca.cats.map(c => [c.name, c]));
check(byName['Favorite Music Group or Duo'].us.join() === 'BLACKPINK',
      `BLACKPINK is the highlighted chip (${byName['Favorite Music Group or Duo'].us.join()})`);
check(byName['Favorite Female Artist'].us.join() === 'ROSÉ',
      `ROSÉ is the highlighted chip (${byName['Favorite Female Artist'].us.join()})`);
check(/Dracula/.test(byName['Favorite Music Collaboration'].us.join()),
      `Dracula is the highlighted chip (${byName['Favorite Music Collaboration'].us.join()})`);
// One chip per category, same as every other card here. The rival fields were
// listed at first and put eighteen chips between the countdown and the button.
check(kca.cats.every(c => c.all === 1),
      `one chip per category — ours (${kca.cats.map(c => c.all).join(', ')})`);
check(kca.cats.every(c => c.all === c.us.length),
      'and every chip shown is marked as ours, so none is a rival in disguise');
check(!JSON.stringify(kca.data.categories).match(/BTS|Taylor Swift|Sabrina|Weezer|Shakira/),
      'no rival names left in the data either');

// Two rows with a picture and a third without reads as a broken asset rather
// than a choice, so the card has to be all or nothing.
check(new Set(kca.cats.map(c => c.thumb)).size === 1,
      `every category row treats thumbnails the same (${kca.cats.map(c => c.thumb).join(', ')})`);

console.log('\n--- the round rule is a band, not a bullet');
const rules = kca.rules.join(' ');
check(/Vote every category to the end/i.test(kca.alert || ''),
      `the alert band carries it (${kca.alert})`);
check(/nothing is submitted until you finish/i.test(kca.alert || ''),
      'and says why in the same breath');
// The regression to guard: it drifting back into the rules list, where it read
// like "no account needed".
check(!/Vote every category/i.test(rules),
      'and it is NOT also a grey bullet in the rules list');
check(kca.alertBeforeBtn === true,
      'the band sits immediately above the Vote Now button, not buried at the top');
check(kca.alertSize && kca.alertSize[0] > kca.alertSize[1] * 1.25,
      `and is rendered bigger than a rules bullet (${kca.alertSize?.join('px vs ')}px)`);
check((kca.alert || '').length <= 130,
      `still short enough to read at a glance — ${(kca.alert || '').length} characters`);
check(/Vote Again/.test(rules), 'and the way to go round again is still said');

console.log('\n--- the circulating limit is corrected, not repeated');
check(/no number/i.test(rules) && /No vote limit/i.test(rules),
      'the card says there is no limit and that none is published');
check(/isn.{0,3}t Nickelodeon.{0,3}s/.test(rules) && /100/.test(rules),
      'and names the "100 a day" figure to correct it rather than leaving it to spread');
check(/Oct 8\s*–\s*Nov 13/.test(rules), 'the voting period is stated as the rules give it');
check(/vary by region/i.test(rules), 'including that closing times vary by region');
check(/Bots, scripts and macros/i.test(rules) && /Vote by hand/i.test(rules),
      'and the organiser\'s ban on automated voting is passed on');

console.log('\n--- the top button');
check(kca.voteBtn === 'https://kca.nick.tv/vote/',
      `Vote Now goes to the hub (${kca.voteBtn})`);

console.log('\n--- nothing else broke');
const order = await p.evaluate(() =>
  [...document.querySelectorAll('#vote-list .vote-card .vote-title')].map(x => x.textContent.trim()));
check(order.length >= 3, `the other campaigns still render (${order.join(' · ')})`);
check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
const of = await p.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(of <= 1, `no horizontal overflow at 412px (${of}px)`);

await p.screenshot({ path: '/tmp/kca-card.png', fullPage: true }).catch(() => {});
await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
