// The MMA 2026 card on /voting, driven in a real browser.
//
// Run: node .github/scripts/test_vote_mma.mjs
//
// MMA is the first card here with TWO ballots, and which one the button points
// at is the whole decision in it. Melon's vote needs an identity-verified
// Korean ID; Berriz is the half open to everyone outside South Korea, which is
// almost all of this site's readers. A card that sends them to Melon sends
// them to a ballot they cannot cast — and it would look completely fine.
//
// The links were verified live before being written down (probe-page against
// both hosts). That is also how the shortener was caught: the Melon link we
// were given, https://kko.to/b9y8esFUZL, resolves to
//
//   https://m2.melon.com/en/mma/2026/?date=202611011500&snsGate=Y&ref=copyurl
//
// — a dated page with a copy-link tracking tag on it. The clean URL serves the
// identical 85,838-byte page with no redirect, so that is what the card uses.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const SPA = /^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const TY = { html:'text/html', js:'text/javascript', css:'text/css', json:'application/json',
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', svg:'image/svg+xml', mp4:'video/mp4' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/sw.js') { res.writeHead(404); res.end(''); return; }
  if (p.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const f = p === '/' ? '/index.html' : SPA.test(p) ? '/index.html' : p;
  try { const b = await readFile(ROOT + f);
    res.writeHead(200, { 'content-type': TY[f.split('.').pop()] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 1200 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen','1');
  localStorage.setItem('ltal_reminder_dismissed_v1','1'); localStorage.setItem('ext_update_dismissed_1.9.8','1'); } catch (e) {} });
await page.goto(`http://127.0.0.1:${server.address().port}/voting`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof VOTE_CAMPAIGNS !== 'undefined', null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2200);

const r = await page.evaluate(() => {
  // A top-level `const` in a classic script resolves as a bare identifier but
  // is NOT a property of window — reading it off window gives undefined.
  const all = typeof VOTE_CAMPAIGNS !== 'undefined' ? VOTE_CAMPAIGNS : [];
  const c = all.find((x) => x.id === 'mma-2026');
  const title = [...document.querySelectorAll('.vote-title')].find((t) => t.textContent.trim() === 'MMA 2026');
  // closest('.vote-card'), NOT a walk looking for /vote-card/ — the title sits
  // inside `.vote-card-top`, which matches that pattern and is only the header
  // band. Stopping there found the countdown and ZERO links, and the link
  // checks below then passed on an empty list: "every link is clean (0 links)".
  const card = title ? title.closest('.vote-card') : null;
  return {
    found: !!c,
    url: c && c.url,
    deadline: c && c.deadline,
    rules: c ? c.rules.length : 0,
    ruleText: c ? c.rules.join(' ') : '',
    alert: c ? c.alert : '',
    cats: c ? c.categories.map((k) => ({ name: k.name, url: k.url || '', us: k.nominees.filter((n) => n.us).length })) : [],
    rendered: !!title && !!title.offsetParent,
    cardText: card ? card.innerText.replace(/\s+/g, ' ') : '',
    // Every link the card shows, as the browser resolved it.
    hrefs: card ? [...card.querySelectorAll('a[href]')].map((a) => a.href) : [],
  };
});

console.log('--- the card is on the page');
check(r.found, 'mma-2026 is registered in VOTE_CAMPAIGNS');
check(r.rendered, 'and its card renders on /voting', r.cardText.slice(0, 60));
// A card with a dead countdown is a card nobody trusts; this also catches a
// deadline that has already passed, which would file it under "ended".
check(/\d+D\s*\d+H/.test(r.cardText), 'with a running countdown on it',
      (r.cardText.match(/\d+D\s*\d+H\s*\d+M/) || ['none'])[0]);
check(errs.length === 0, 'and the page throws nothing', errs[0] || 'clean');

console.log('\n--- the button goes to the ballot our readers can actually cast');
// THE POINT OF THIS FILE. Melon needs an identity-verified Korean ID; Berriz
// is the global half. Swapping these looks like a tidy-up and silently sends
// everyone outside Korea to a ballot that will refuse them.
check(/(^|\.)berriz\./.test(new URL(r.url).hostname), 'the primary button is the Berriz ballot, not Melon', r.url);
check(r.hrefs.some((h) => /melon\.com/.test(h)), 'and Melon is still reachable from the card', 'linked in the rules');
check(/identity-verified|Outside Korea/i.test(r.alert), 'the alert says which app to use, above the button');

console.log('\n--- no shortener, no tracking, no dated page');
// The exact families this repo strips everywhere else, plus the shortener the
// Melon link arrived as — a kko.to redirect lands on a ?date=…&ref=copyurl URL
// pinned to the minute it was copied.
const DIRTY = [/kko\.to/, /[?&]ref=/, /[?&]date=/, /[?&]snsGate=/, /utm_[a-z]+=/, /[?&]si=/, /[?&]is=/];
const bad = [...new Set([r.url, ...r.hrefs, ...r.cats.map((c) => c.url)])]
  .filter(Boolean).filter((h) => DIRTY.some((re) => re.test(h)));
check(bad.length === 0, 'every link is clean and canonical', bad.length ? bad.join(' ') : `${r.hrefs.length} links`);

console.log('\n--- the categories');
check(r.cats.length > 0, 'the card lists categories', r.cats.map((c) => c.name).join(', '));
const noUs = r.cats.filter((c) => c.us === 0);
check(noUs.length === 0, 'every category names at least one of ours', noUs.map((c) => c.name).join(', ') || 'all do');
// Berriz's own guide says its ballot is MMA2026 Global TOP10 and nothing else,
// so pointing any other category at Berriz is a link to a vote that is not
// there. Melon is where the rest of the categories live.
const wrongHost = r.cats.filter((c) => c.name !== 'Global TOP10' && /berriz/.test(c.url));
check(wrongHost.length === 0, 'only Global TOP10 links to Berriz — it is the only category Berriz runs',
      wrongHost.map((c) => c.name).join(', ') || 'correct');

console.log('\n--- the dates');
const close = Date.parse(r.deadline);
const SHOW = Date.parse('2026-11-14T00:00:00+09:00');   // the ceremony, Gocheok Sky Dome
check(Number.isFinite(close), 'the deadline parses', r.deadline);
// House rule, set by the KCA card: voting shuts BEFORE the ceremony, so the
// countdown must never run to the show date.
check(close < SHOW, 'voting closes before the ceremony, not on it',
      `${r.deadline} vs show ${new Date(SHOW).toISOString()}`);
check(close > Date.now(), 'and it has not already passed', `${((close - Date.now()) / 86400000).toFixed(1)} days left`);

console.log('\n--- the rules carry the parts that cost a vote');
// Each of these is a line from the two in-app guides that changes what someone
// does. Checked as substrings of the rules blob so rewording is free, but
// dropping the fact is not.
for (const [needle, why] of [
  ['50%',        'that the two platforms are half each'],
  ['00:00 KST',  'when the daily vote refreshes'],
  // 'cancel', not 'cancelled' — the fact is that a Berriz vote cannot be taken
  // back, and pinning the inflection would fail a rewrite that still says so.
  ['cancel',     'that a Berriz vote cannot be taken back'],
  ['Bonus votes', 'how Melon bonus votes work'],
  ['13 Nov',     'when voting closes'],
]) check(r.ruleText.includes(needle), `the rules say ${why}`, needle);

// THE WEIGHTING CLAIM, pinned as a claim rather than as the string "20%".
// Searching for "20%" passed when the sentence was changed to "The vote
// decides Global TOP10" — because "judging (20%)" later in the same rule still
// carried the characters. A substring that occurs twice cannot test the
// meaning of either occurrence. Overstating what the vote does is the failure
// worth catching here: it is the difference between "turn up daily" and
// "we can win this on votes".
const SAYS_20 = /20%\s*of\s*Global\s*TOP10|vot\w*\s+is\s+(?:only\s+)?20%/i;
const OVERSTATES = /vote\s+(decides|determines|wins)/i;
check(SAYS_20.test(r.ruleText), 'the rules say voting is 20% of Global TOP10, as a claim and not just a number',
      (r.ruleText.match(SAYS_20) || ['missing'])[0]);
check(!OVERSTATES.test(r.ruleText), 'and nowhere claim the vote decides it',
      (r.ruleText.match(OVERSTATES) || ['clean'])[0]);
check(r.ruleText.includes('60%'), 'with the chart half named too', '60%');

await browser.close();
server.close();
console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
