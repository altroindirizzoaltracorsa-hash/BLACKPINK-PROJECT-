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
//   * no closing date is claimed — Nickelodeon has not published one, and the
//     show date (Nov 14) is NOT it, because voting closes before the show
//   * the ~100/day figure is attributed to blinks, not to Nickelodeon, because
//     no vote page states any limit and a web search traced that number to a
//     different award entirely
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
    voteBtn: card.querySelector('.vote-btn')?.getAttribute('href'),
    inPast: !!card.closest('.vote-past, .vote-ended, [data-past]'),
  };
});

console.log('--- the card is there and live');
check(!kca.missing, 'a Kids’ Choice card renders in #vote-list');
check(!kca.inPast, 'in the active list, not folded into Past Votings');
check(kca.deadline === 'VOTING OPEN',
      `and it says VOTING OPEN rather than counting down (${kca.deadline})`);

console.log('\n--- no deadline is invented');
check(kca.data.deadline === undefined,
      'the campaign carries no `deadline` at all — none has been announced');
// The show is Nov 14. Using it as the deadline would be a countdown to the
// wrong instant, since voting closes before the ceremony.
check(!JSON.stringify(kca.data).includes('2026-11-14'),
      'and the show date is not quietly used as one');

console.log('\n--- the three categories, with the links that were probed');
const want = {
  'Favorite Music Group or Duo': 'https://kca.nick.tv/vote/favorite-music-group-or-duo',
  'Favorite Female Artist': 'https://kca.nick.tv/vote/favorite-female-artist',
  'Favorite Music Collaboration': 'https://kca.nick.tv/vote/favorite-music-collaboration',
};
check(kca.cats.length === 3, `three categories (${kca.cats.length})`);
for (const [name, href] of Object.entries(want)) {
  const row = kca.cats.find(c => c.name === name);
  check(!!row, `"${name}" is on the card`);
  check(row && row.href === href, `and links to ${href.split('/').pop()}`);
}

console.log('\n--- ours is marked, and the field is real');
const byName = Object.fromEntries(kca.cats.map(c => [c.name, c]));
check(byName['Favorite Music Group or Duo'].us.join() === 'BLACKPINK',
      `BLACKPINK is the highlighted chip (${byName['Favorite Music Group or Duo'].us.join()})`);
check(byName['Favorite Female Artist'].us.join() === 'ROSÉ',
      `ROSÉ is the highlighted chip (${byName['Favorite Female Artist'].us.join()})`);
check(/Dracula/.test(byName['Favorite Music Collaboration'].us.join()),
      `Dracula is the highlighted chip (${byName['Favorite Music Collaboration'].us.join()})`);
// The rivals matter: a category listing only us reads like a poll we invented.
check(byName['Favorite Music Group or Duo'].all === 6,
      `the group field has all six nominees (${byName['Favorite Music Group or Duo'].all})`);
check(byName['Favorite Female Artist'].all === 8,
      `the female-artist field has all eight (${byName['Favorite Female Artist'].all})`);

// Two rows with a picture and a third without reads as a broken asset rather
// than a choice, so the card has to be all or nothing.
check(new Set(kca.cats.map(c => c.thumb)).size === 1,
      `every category row treats thumbnails the same (${kca.cats.map(c => c.thumb).join(', ')})`);

console.log('\n--- the unverified rule is attributed, not asserted');
const rules = kca.rules.join(' ');
check(/100 per category, per day, per device/.test(rules),
      'the figure blinks are circulating is still passed on');
check(/Blinks report/.test(rules) && /doesn.{0,3}t publish a vote limit/.test(rules),
      'but as a fan report against a page that states no limit — not as a Nickelodeon rule');
check(/closing date hasn.{0,3}t been announced/i.test(rules),
      'and the missing deadline is said out loud');
check(/Nov 14/.test(rules), 'with the show date, which is the part that IS known');

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
