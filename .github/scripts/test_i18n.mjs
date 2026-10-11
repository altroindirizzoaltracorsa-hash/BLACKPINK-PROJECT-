// Does translating the live DOM actually survive the live DOM?
//
// Run: node .github/scripts/test_i18n.mjs
//
// The risky part of this design is not the dictionary, it is that it rebuilds
// elements in a page that is constantly rebuilding itself. So the things pinned
// here are the ones that would be invisible until a blink hit them:
//
//   * BUTTONS MUST KEEP WORKING. Translation replaces the children of every
//     sentence-bearing element. If it re-created them from HTML, every .onclick
//     assigned in JavaScript would be silently dropped and the page would look
//     perfect and do nothing.
//   * PANELS RENDERED LATER MUST TRANSLATE. 70% of this site's text does not
//     exist until a render function runs, and those functions know nothing
//     about language.
//   * SWITCHING BACK MUST BE EXACT. Not approximately the original English —
//     the original nodes.
//   * A MISSING ENTRY MUST FALL BACK, silently and per-string, or a language
//     that is 40% translated is worse than no language at all.
//   * NUMBERS AND TAGS MUST SURVIVE REORDERING, because word order is the
//     entire reason this translates sentences instead of text nodes.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = new URL('../../', import.meta.url).pathname;
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

// A deliberately awkward stand-in for Spanish: it reorders tags, moves numbers,
// and leaves most things untranslated so the fallback is exercised on every
// page. It has to be a REAL language code — the runtime only accepts the ten it
// ships, which is itself worth not breaking.
const XX = {
  'Found a bug? Have a suggestion? Tell us.': 'ENCONTRASTE UN ERROR',
  'CATEGORY': 'CATEGORÍA',
  'MESSAGE': 'MENSAJE',
  'HOW SHOULD WE REPLY?': '¿CÓMO RESPONDEMOS?',
  'Here on the site': 'Aquí en el sitio',
  // Tag order reversed relative to the English, which is the whole point.
  '<0>one</0> then <1>two</1>': '<1>DOS</1> luego <0>UNO</0>',
  // Numbers reordered too.
  'from {n} to {n}': 'de {n} hasta {n}',
  'no placeholders here': 'SIN MARCADORES',
};

const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
writeFileSync(join(dir, 'es.json'), JSON.stringify(XX));

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1280, height: 1200 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.hostname.includes('fonts.g')) return route.continue();
  if (u.pathname === '/i18n/es.json') {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(XX) });
  }
  if (u.pathname === '/i18n/i18n.js') {
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(root + 'i18n/i18n.js', 'utf8') });
  }
  if (u.pathname === '/i18n/de.json') return route.fulfill({ status: 404, body: '' });
  if (u.pathname.startsWith('/api/')) {
    return route.fulfill({ contentType: 'application/json', body: '{"board":{"ranked":[],"unranked":[]},"messages":[],"total":0}' });
  }
  if (/supabase/i.test(u.href) && u.hostname !== 'www.blinksunited.com') {
    return route.fulfill({ contentType: 'application/javascript', body:
      'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),'
      + 'onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null})})})}),rpc:async()=>({data:null})})};' });
  }
  if (u.hostname === 'www.blinksunited.com' && !/\.\w{2,4}$/.test(u.pathname)) {
    return route.fulfill({ path: root + 'index.html', contentType: 'text/html' });
  }
  return route.fulfill({ status: 204, body: '' });
});

await page.goto('https://www.blinksunited.com/feedback', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
await page.evaluate(() => {
  document.getElementById('tutorial-overlay')?.remove();
  document.getElementById('ext-update-overlay')?.remove();
  showPage('feedback');
});
await page.waitForTimeout(400);

console.log('--- the mechanism loads and offers the languages');
check(await page.evaluate(() => !!window.BU_I18N), 'BU_I18N is present on the page');
const langs = await page.evaluate(() => Object.keys(window.BU_I18N.langs));
check(langs.length === 11, `eleven options — English plus ten (${langs.length})`);
check(langs[0] === 'en', 'English first');
check(await page.evaluate(() => window.BU_I18N.langs.ko === '한국어'),
      'each language names itself, so the picker is readable to the person who needs it');

console.log('\n--- translating a real page');
const before = await page.evaluate(() => document.querySelector('.beta-sub').textContent.trim());
await page.evaluate(() => window.BU_I18N.setLang('es'));
await page.waitForTimeout(400);
const after = await page.evaluate(() => document.querySelector('.beta-sub').textContent.trim());
check(before === 'Found a bug? Have a suggestion? Tell us.', `English to start (${before})`);
check(after === 'ENCONTRASTE UN ERROR', `translated in place (${after})`);
check(await page.evaluate(() => document.documentElement.lang === 'es'),
      'and <html lang> says so, which is what screen readers and the browser read');

console.log('\n--- a string with no entry stays English, by itself');
const untouched = await page.evaluate(() =>
  [...document.querySelectorAll('#page-feedback .beta-label')].map(e => e.textContent.trim()));
check(untouched.includes('CATEGORÍA'), 'the ones in the dictionary are translated');
check(untouched.some(t => /^CONTACT|^YOUR/.test(t)),
      `the ones missing from it are left in English (${untouched.join(' · ')})`);

console.log('\n--- buttons still work afterwards');
// The feedback page assigns behaviour to this select in JS, and the reply-route
// label below it only changes if that still fires.
const stillWorks = await page.evaluate(async () => {
  const sel = document.getElementById('feedback-replyvia');
  sel.value = 'email';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 120));
  return document.getElementById('feedback-contact-wrap').style.display !== 'none';
});
check(stillWorks, 'a control whose handler was attached before translation still fires');

console.log('\n--- content rendered AFTER the switch is translated too');
// This is the 70% of the site that does not exist until a render runs.
const later = await page.evaluate(async () => {
  const host = document.getElementById('vma-vote-panel') || document.body;
  const probe = document.createElement('div');
  probe.innerHTML = '<p>Found a bug? Have a suggestion? Tell us.</p>';
  host.appendChild(probe);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = probe.textContent.trim();
  probe.remove();
  return out;
});
check(later === 'ENCONTRASTE UN ERROR', `new DOM is picked up by the observer (${later})`);

console.log('\n--- tags and numbers survive being reordered');
const reorder = await page.evaluate(async () => {
  const d = document.createElement('div');
  d.innerHTML = '<p id="t1"><b onclick="window.__hit=1">one</b> then <i>two</i></p>'
              + '<p id="t2">from 5 to 90</p><p id="t3">no placeholders here</p>';
  document.body.appendChild(d);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const t1 = document.getElementById('t1');
  const out = {
    text: t1.textContent.trim(),
    // The <b> must still BE the original element, with its handler.
    boldText: t1.querySelector('b') ? t1.querySelector('b').textContent : null,
    boldHasHandler: !!(t1.querySelector('b') && t1.querySelector('b').getAttribute('onclick')),
    nums: document.getElementById('t2').textContent.trim(),
    plain: document.getElementById('t3').textContent.trim(),
  };
  d.remove();
  return out;
});
check(reorder.text === 'DOS luego UNO', `tags moved to where the translation puts them (${reorder.text})`);
check(reorder.boldText === 'UNO', `and the right content went in the right tag (<b>${reorder.boldText}</b>)`);
check(reorder.boldHasHandler, 'the element itself is reused, so its handler came along');
check(reorder.nums === 'de 5 hasta 90', `numbers refilled in order (${reorder.nums})`);
check(reorder.plain === 'SIN MARCADORES', `a sentence with no markup still works (${reorder.plain})`);

console.log('\n--- switching back restores the original exactly');
// With inline markup, specifically. A sentence of plain text round-trips on
// the top-level child list alone; one with a tag in it does not, because the
// tag is the same object the translation refilled. The nav was coming back in
// the previous language while the plain-text strings looked fine.
const tagRound = await page.evaluate(async () => {
  const d = document.createElement('div');
  d.innerHTML = '<p id="r1"><b>one</b> then <i>two</i></p>';
  document.body.appendChild(d);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const translated = document.getElementById('r1').textContent.trim();
  await window.BU_I18N.setLang('en');
  const back = document.getElementById('r1').textContent.trim();
  const innerBack = document.getElementById('r1').querySelector('b').textContent;
  await window.BU_I18N.setLang('es');
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const again = document.getElementById('r1').textContent.trim();
  d.remove();
  return { translated, back, innerBack, again };
});
check(tagRound.translated === 'DOS luego UNO', `translated (${tagRound.translated})`);
check(tagRound.back === 'one then two', `restored, tags and all (${tagRound.back})`);
check(tagRound.innerBack === 'one', `including INSIDE each tag (<b>${tagRound.innerBack}</b>)`);
check(tagRound.again === 'DOS luego UNO', `and it can be translated again afterwards (${tagRound.again})`);

await page.evaluate(() => window.BU_I18N.setLang('en'));
await page.waitForTimeout(400);
const restored = await page.evaluate(() => document.querySelector('.beta-sub').textContent.trim());
check(restored === before, `back to the English it started with (${restored})`);
check(await page.evaluate(() => document.documentElement.lang === 'en'), 'and <html lang> with it');
const stillWorksAfter = await page.evaluate(async () => {
  const sel = document.getElementById('feedback-replyvia');
  sel.value = 'none'; sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 120));
  return document.getElementById('feedback-contact-wrap').style.display === 'none';
});
check(stillWorksAfter, 'and the page still works after a round trip');

console.log('\n--- a missing dictionary falls back instead of half-translating');
await page.evaluate(() => window.BU_I18N.setLang('de'));
await page.waitForTimeout(400);
check(await page.evaluate(() => window.BU_I18N.lang === 'en'),
      'a language whose dictionary is missing lands on English, not a half-dead page');
check(await page.evaluate(() => document.querySelector('.beta-sub').textContent.trim()) === before,
      'with the text intact');

console.log('\n--- the picker, and what it must never translate');
await page.evaluate(() => {
  const host = document.createElement('div');
  host.id = 'lang-picker';
  document.body.appendChild(host);
  window.BU_I18N.setLang('es');
});
await page.waitForTimeout(400);
const picker = await page.evaluate(() => {
  const els = [...document.querySelectorAll('#lang-picker option')];
  return {
    options: els.map(x => x.textContent),
    labels: els.map(x => x.getAttribute('aria-label')),
    marked: document.getElementById('lang-picker').hasAttribute('data-no-i18n'),
  };
});
check(picker.options.length === 11, `the picker lists every language (${picker.options.length})`);
// The native name must survive the flag being prepended. A flag is a country,
// not a language, so it is only ever a marker beside the name — if a name ever
// got replaced by one, this is what would catch it.
check(picker.options.some(t => t.endsWith('한국어')) && picker.options.some(t => t.endsWith('Português (BR)')),
      'in their own scripts');
const flagged = picker.options.filter(t => /^[\u{1F1E6}-\u{1F1FF}]{2} /u.test(t));
check(flagged.length === 11, `every one carries a flag before the name (${flagged.length}/11)`);
// A screen reader should say "한국어", not "flag of South Korea, 한국어".
check(picker.labels.includes('한국어') && picker.labels.every(l => l && !/[\u{1F1E6}-\u{1F1FF}]/u.test(l)),
      'and the accessible name is the language alone, without the flag');
check(picker.marked, 'and is marked data-no-i18n, so it never translates itself');

console.log('\n--- nothing else broke');
check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
const of_ = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(of_ <= 1, `no horizontal overflow (${of_}px)`);

await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
