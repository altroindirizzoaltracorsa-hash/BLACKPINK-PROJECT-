// The feedback queue's admin view, and where its key is allowed to come from.
//
// Run: node .github/scripts/test_feedback_admin.mjs
//
// /feedback used to read its key only from ?admin= and its own sessionStorage,
// while the admin panel kept the SAME secret in localStorage. One key, one
// device, one person — two logins. The page now falls back to the panel's copy.
//
// Nothing here is the security boundary: /api/feedback re-checks the key on
// every call and a browser can claim whatever it likes. These tests are about
// not asking twice, and about not leaving a stale secret sitting in storage
// producing a red banner after it has been rotated.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const GOOD = 'the-real-secret';
const fails = [];
const check = (ok, label) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) fails.push(label); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// Loads /feedback with a given starting state and reports what the page did.
async function load({ panelKey, sessionKey, urlKey }) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 1200 } });
  const page = await ctx.newPage();
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.includes('fonts.g')) return route.continue();
    // The server is the real gate, so it is stubbed to behave like one.
    if (u.pathname === '/api/feedback' && u.searchParams.get('admin')) {
      if (u.searchParams.get('key') !== GOOD) {
        return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"bad key"}' });
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        messages: [{ id: 1, message: 'hello from a blink', reply_via: 'none', created_at: new Date().toISOString() }],
        mail: false,
      }) });
    }
    const f = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (existsSync(root + f) && /\.(html|js|json|css|png|jpg|jpeg|svg|webp)$/.test(f)) return route.fulfill({ path: root + f });
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"board":{"ranked":[],"unranked":[]},"messages":[],"total":0}' });
    if (u.hostname === 'www.blinksunited.com' && !/\.\w{2,4}$/.test(u.pathname)) return route.fulfill({ path: root + 'index.html', contentType: 'text/html' });
    return route.fulfill({ status: 204, body: '' });
  });
  await page.addInitScript(([pk, sk]) => {
    try { if (pk) localStorage.setItem('bu_admin_key', pk); } catch (e) {}
    try { if (sk) sessionStorage.setItem('fbAdminKey', sk); } catch (e) {}
  }, [panelKey, sessionKey]);
  await page.goto('https://www.blinksunited.com/feedback' + (urlKey ? '?admin=' + encodeURIComponent(urlKey) : ''),
                  { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  await page.evaluate(() => { try { closeTutorial(); } catch (e) {} document.getElementById('tutorial-overlay')?.remove(); });
  await page.waitForTimeout(600);
  const out = await page.evaluate(() => {
    const card = document.getElementById('feedback-admin-card');
    return {
      shown: !!card && card.style.display !== 'none',
      text: (document.getElementById('feedback-admin-list') || {}).textContent || '',
      panelKeyLeft: localStorage.getItem('bu_admin_key'),
      url: location.search,
    };
  });
  await ctx.close();
  return out;
}

console.log('--- the admin panel already logged you in');
{
  const r = await load({ panelKey: GOOD });
  check(r.shown, 'unlocking the admin panel also unlocks the feedback queue');
  check(/hello from a blink/.test(r.text), 'and the messages are actually there');
}

console.log('\n--- and nobody else gets it');
{
  const r = await load({});
  check(!r.shown, 'a visitor with no key sees no queue');
}

console.log('\n--- a rotated secret cleans itself up');
{
  // The panel drops its localStorage copy on a 401. The feedback page borrows
  // that copy, so it has to do the same — otherwise a rotated secret leaves a
  // red "key was refused" banner on an ordinary page for ever.
  const r = await load({ panelKey: 'old-rotated-secret' });
  check(!r.shown, 'a stale borrowed key shows no banner, just the ordinary page');
  check(!r.panelKeyLeft, 'and the dead key is cleared from storage, as the panel does');
}

console.log('\n--- a key typed on purpose still answers');
{
  // Different from a borrowed key: this was deliberate, so "refused" is the
  // useful reply rather than silence.
  const bad = await load({ urlKey: 'typed-wrong' });
  check(bad.shown && /refused/i.test(bad.text), 'a wrong ?admin= key says it was refused');
  const good = await load({ urlKey: GOOD });
  check(good.shown && /hello from a blink/.test(good.text), 'and the right one opens the queue');
  check(!/admin=/.test(good.url), 'with the key stripped back out of the address bar');
}

await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
