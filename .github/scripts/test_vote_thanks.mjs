// The closed-ballot thank-you panel on a vote card.
//
// Run: node .github/scripts/test_vote_thanks.mjs
//
// Once a ballot shuts, the countdown has nothing left to say and the card
// shows what the community actually cast instead — the same block /vmas
// carries, directly under the VOTING CLOSED line. Three things about it are
// invisible in the source and each has a specific way of going wrong:
//
//   · WHICH TALLY. The endpoint serves several awards off one URL and the VMA
//     dimension is the DEFAULT, i.e. what you get by forgetting the
//     parameter. Forget it under the Kids' Choice ballot and the panel prints
//     a real, large, confidently formatted number that belongs to a different
//     award. Nothing on screen would look wrong. So the request itself is
//     recorded here, not just the number that came back.
//
//   · THE EMPTY CASES. The panel ships hidden with no numbers in it and is
//     revealed only once a real total arrives. A failed fetch, a cold table or
//     a zero must therefore read as "no panel" — never as "nobody voted",
//     which is a claim nobody could correct afterwards, printed over a ballot
//     thousands of blinks worked. Two halves, held separately: the total can
//     be real while the per-blink split is not.
//
//   · WHERE IT SITS. "Under 'voting is closed'" is the whole brief. DOM order
//     is not enough to prove it — a float, a grid row or an `order` on the
//     flex parent moves a box without moving its markup — so the three boxes
//     are read by their on-screen y.
//
// Driven through /votecard-embed, which mounts ONE card standing alone: on
// /voting a closed ballot is folded into the Past Votings details, where every
// box measures zero and a geometry check cannot fail.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA = /^\/(votecard-embed|voting|vote)(\/|$)/;

// What the stubbed endpoint answers next, and what it was asked for.
let reply = { status: 200, body: { total: 0 } };
let asked = [];

const server = createServer(async (req, res) => {
  const [p, qs] = req.url.split('?');
  if (p === '/api/vma-votes') {
    // The whole query, not just the award: the voting board asks this endpoint
    // for its own things (?board=1, ?me=1, …) on the same page, and counting
    // those as tally reads would hide a duplicate of ours among them.
    asked.push(qs || '');
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.status === 200 ? JSON.stringify(reply.body) : '');
    return;
  }
  const file = SPA.test(p) ? '/index.html' : p;
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
const page = await browser.newPage({ viewport: { width: 420, height: 1200 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen', '1'); } catch (e) {} });

// Load the card and read the panel's state off the screen. Returns null if the
// card never mounted, so a load failure cannot pass as "panel hidden".
async function load(card = 'kca') {
  asked = [];
  await page.goto(`${base}/votecard-embed?embed=votecard&card=${card}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('#vc-embed-root .vote-card').first().waitFor({ timeout: 30000 });
  } catch { return null; }
  // The panel is filled by a fetch; give it a moment to land (or not to).
  await page.waitForTimeout(900);
  return page.evaluate(() => {
    const box = document.querySelector('#vc-embed-root .vote-thanks');
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none'
      && el.getBoundingClientRect().height > 0;
    const y = (sel) => {
      const el = document.querySelector('#vc-embed-root ' + sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    return {
      exists: !!box,
      shown: vis(box),
      award: box ? box.dataset.voteThanks : null,
      total: box ? (box.querySelector('[data-thanks-total]')?.textContent || '').trim() : null,
      blinksRow: vis(box && box.querySelector('[data-thanks-blinks-row]')),
      blinks: box ? (box.querySelector('[data-thanks-blinks]')?.textContent || '').trim() : null,
      yClosed: y('.vote-deadline.ended'),
      yPanel: y('.vote-thanks'),
      yFirstCat: y('.vote-cat-row'),
    };
  });
}

console.log('--- with a real total, the panel appears under VOTING CLOSED');
reply = { status: 200, body: { total: 1234567, today: 10, blinksTotal: 842, blinksToday: 7 } };
let s = await load();
if (!s) { bad('the Kids’ Choice card mounted'); }
else {
  ok('the Kids’ Choice card mounted');
  s.exists ? ok('the card carries a thank-you panel') : bad('the card carries a thank-you panel');
  s.shown ? ok('and it is visible once the count arrived') : bad('and it is visible once the count arrived');
  s.total === '1,234,567' ? ok('the total is the award’s own, grouped', s.total)
                          : bad('the total is the award’s own, grouped', s.total);
  s.blinksRow ? ok('the blinks row is shown') : bad('the blinks row is shown');
  s.blinks === '842' ? ok('with the number of blinks', s.blinks) : bad('with the number of blinks', s.blinks);

  // The request, not the rendering. ?award=kca selects the Kids' Choice table;
  // no parameter at all is the VMA dimension, which would print somebody
  // else's total here and look entirely plausible doing it.
  //
  // A tally read is one with no mode flag on it — the board's ?board=1 and
  // ?me=1 calls go to the same endpoint and are not this panel's.
  const tally = asked.filter((q) => !/\b(board|me|sync|live)=/.test(q));
  tally.some((q) => /(^|&)award=kca(&|$)/.test(q))
    ? ok('it asked for the Kids’ Choice tally', tally.join(' | '))
    : bad('it asked for the Kids’ Choice tally',
        asked.length ? `asked: ${asked.join(' | ')}` : 'never called the endpoint');
  tally.some((q) => !/award=/.test(q))
    ? bad('and nothing asked for the default (VMA) tally', `asked: ${tally.join(' | ')}`)
    : ok('and nothing asked for the default (VMA) tally');
  // The panel reads the tally ONCE for the page, however many times the vote
  // list is rebuilt — which it is every time /voting is opened. Rebuild it
  // here and count: the figure under a CLOSED ballot is final, so a second
  // read buys nothing, and a panel that asks per render is a round trip on
  // every visit to the page for a number that cannot have changed.
  const before = asked.length;
  await page.evaluate(() => renderVoteCampaigns());
  await page.waitForTimeout(600);
  const added = asked.slice(before).filter((q) => !/\b(board|me|sync|live)=/.test(q));
  // ...and the FRESH panel is filled from that cache, which is the half a
  // cache that remembered nothing but answered no more would still pass.
  // Read by text, not by geometry: the re-rendered card lands back in the
  // hidden #vote-list rather than in the mounted embed root.
  const refilled = await page.evaluate(() => [...document.querySelectorAll('.vote-thanks')]
    .map((b) => ({ shown: !b.hidden, total: (b.querySelector('[data-thanks-total]')?.textContent || '').trim() })));
  added.length === 0 ? ok('a re-render does not ask again') : bad('a re-render does not ask again', added.join(' | '));
  (refilled.length >= 2 && refilled.every((p) => p.shown && p.total === '1,234,567'))
    ? ok('and the fresh panel is filled from the cache', refilled.map((p) => p.total).join(' / '))
    : bad('and the fresh panel is filled from the cache', JSON.stringify(refilled));

  // Under the closed line, above the nominations.
  (s.yClosed != null && s.yPanel != null && s.yPanel > s.yClosed)
    ? ok('it sits below the VOTING CLOSED line', `closed y${s.yClosed} → panel y${s.yPanel}`)
    : bad('it sits below the VOTING CLOSED line', `closed y${s.yClosed}, panel y${s.yPanel}`);
  (s.yFirstCat != null && s.yPanel != null && s.yPanel < s.yFirstCat)
    ? ok('and above the nominations', `panel y${s.yPanel} → first row y${s.yFirstCat}`)
    : bad('and above the nominations', `panel y${s.yPanel}, first row y${s.yFirstCat}`);
}

console.log('--- and it fits the 280px column /awards gives it');
// The headline is a single nowrap number: it cannot wrap its way out of a
// narrow box, it can only run past the edge. On /awards this card sits in a
// 280px column inside a frame carrying scrolling="no", so an over-wide total
// is not scrolled to — it is cut off, on the width most readers are at.
// Measured with a figure wider than anything the ballot is likely to produce.
{
  reply = { status: 200, body: { total: 98765432, blinksTotal: 54321 } };
  await page.setViewportSize({ width: 280, height: 1200 });
  const s2 = await load();
  if (!s2) bad('the card mounted at 280px');
  else {
    const fit = await page.evaluate(() => {
      const b = document.querySelector('#vc-embed-root .vote-thanks');
      if (!b) return null;
      const docW = document.documentElement.clientWidth;
      const wide = [...b.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().width > docW + 1 || el.scrollWidth > Math.ceil(el.getBoundingClientRect().width) + 1)
        .map((el) => `${el.className} ${Math.round(el.getBoundingClientRect().width)}/${el.scrollWidth}`);
      return { docW, wide, doc: document.documentElement.scrollWidth };
    });
    if (!fit) bad('the panel is there at 280px');
    else {
      fit.wide.length === 0 ? ok(`every line fits the ${fit.docW}px column`)
                            : bad(`every line fits the ${fit.docW}px column`, fit.wide.join(' · '));
      fit.doc <= fit.docW + 1 ? ok('and the card does not scroll sideways', `${fit.doc} in ${fit.docW}`)
                              : bad('and the card does not scroll sideways', `${fit.doc} in ${fit.docW}`);
    }
  }
  await page.setViewportSize({ width: 420, height: 1200 });
}

console.log('--- a total that is real but no per-blink split');
reply = { status: 200, body: { total: 4321, blinksTotal: 0 } };
s = await load();
if (!s) bad('the card mounted (blinks-less case)');
else {
  s.shown ? ok('the panel still appears') : bad('the panel still appears');
  s.total === '4,321' ? ok('with the total', s.total) : bad('with the total', s.total);
  s.blinksRow ? bad('and the blinks row stays away', 'it printed a row with no number in it')
              : ok('and the blinks row stays away');
}

console.log('--- the empty cases say nothing at all');
for (const c of [
  { what: 'the endpoint is down', reply: { status: 500, body: null } },
  { what: 'the tally is zero', reply: { status: 200, body: { total: 0, blinksTotal: 0 } } },
  { what: 'the body is not what we expect', reply: { status: 200, body: { oops: true } } },
]) {
  reply = c.reply;
  s = await load();
  if (!s) { bad(`the card mounted (${c.what})`); continue; }
  s.exists ? ok(`${c.what}: the panel is still in the card`) : bad(`${c.what}: the panel is still in the card`);
  s.shown ? bad(`${c.what}: and stays hidden`, `it showed "${s.total}"`)
          : ok(`${c.what}: and stays hidden`);
  // The dash is the placeholder the panel ships with. If it is ever on screen
  // the reveal ran before the number did.
  s.total === '—' ? ok(`${c.what}: nothing was written into it`) : bad(`${c.what}: nothing was written into it`, s.total);
}

console.log('--- a ballot with no tally of its own has no panel');
// MAMA's winners come from the ceremony and its votes are counted elsewhere,
// so its card declares no `tally` and must not grow this block. This is the
// check that stops the panel becoming something every card carries.
reply = { status: 200, body: { total: 999999, blinksTotal: 10 } };
s = await load('mama');
if (!s) bad('the MAMA card mounted');
else {
  s.exists ? bad('the MAMA card has no thank-you panel', 'it rendered one') : ok('the MAMA card has no thank-you panel');
}

console.log('--- nothing else broke');
errs.length ? bad('no page errors', errs.join(' | ')) : ok('no page errors', 'none');
const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
wide <= 1 ? ok('no sideways scroll at 420px', `${wide}px`) : bad('no sideways scroll at 420px', `${wide}px`);

await browser.close();
server.close();
console.log(`\nFAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
