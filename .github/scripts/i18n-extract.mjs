// Build the translatable-string list by RENDERING the site, not by reading it.
//
// Run: node .github/scripts/i18n-extract.mjs            (writes i18n/strings.json)
//      node .github/scripts/i18n-extract.mjs --check    (fails if it is stale)
//
// Roughly 70% of this site's user-facing text is assembled inside JavaScript
// template literals — drawVoteAward(), the badge grids, every chart panel — so
// grepping the source for quoted strings finds a fraction of it, and finds a
// lot of things that are not text. The only honest source of "what does a blink
// actually read" is a browser that has rendered the page.
//
// So every page is opened, every panel is nudged into rendering, and the text
// nodes are collected with THE SAME rules i18n/i18n.js uses when it walks the
// DOM. That is the point: the key a translator sees is byte-for-byte the key
// the runtime will look up. The two cannot drift, because they are the same
// code path applied at two different times.
//
// Network is stubbed, so this needs no API keys and no live site: the API
// shapes below are only rich enough to make each panel render its own copy.
//
// Output, i18n/strings.json:
//   { generated, count, strings: [ { s, ctx, where } ] }
//     s     — the key. Whitespace collapsed, numbers replaced with {n}.
//     ctx   — the sentence it sits in, when it is a fragment of one. Markup
//             splits sentences across <b> and <a>, and a translator handed
//             " Nothing is submitted until you finish" with no context will
//             produce something that reads wrong.
//     where — which page(s) it appears on, so the high-value ones can be done
//             first.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = new URL('../../', import.meta.url).pathname;
const CHECK = process.argv.includes('--check');

// Every page of the single-page app, plus the standalone files. The order is
// rough priority: a blink who cannot read the voting rules loses a vote, while
// a chart axis label is cosmetic.
const SPA_PAGES = [
  'vote', 'feedback', 'badges', 'leaderboard', 'home', 'countdowns',
  'streams', 'ytviews', 'spotify-charts', 'youtube', 'apple', 'itunes', 'kcharts', 'charts',
];
const FILES = [
  'index.html', 'vote-counter-guide.html', 'vote-app-guide.html', 'vote-link.html',
  'extension-link.html', 'vmas.html', 'breaktudo.html', 'girlgroups.html',
  'projects.html', 'achievements.html', '10years.html',
];

// Enough of a response for each panel to render its own prose. Numbers are
// irrelevant — they get normalised to {n} — so these only need the right shape.
const API = {
  'vma-votes': { board: { ranked: [], unranked: [] }, messages: [], total: 0, today: 0,
                 blinksTotal: 0, blinksToday: 0, liveVoters: 0 },
  feedback:    { messages: [] },
  leaderboard: { entries: [], board: [] },
  default:     {},
};

function stubBody(pathname) {
  const key = pathname.replace('/api/', '').split('?')[0];
  return JSON.stringify(API[key] || API.default);
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1280, height: 1400 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.hostname.includes('fonts.g')) return route.continue();
  const file = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
  if (/\.(html?)$/.test(file) && existsSync(root + file)) {
    return route.fulfill({ path: root + file, contentType: 'text/html' });
  }
  if (u.pathname.startsWith('/api/')) {
    return route.fulfill({ contentType: 'application/json', body: stubBody(u.pathname) });
  }
  if (u.pathname.startsWith('/i18n/') && existsSync(root + u.pathname.slice(1))) {
    return route.fulfill({ path: root + u.pathname.slice(1), contentType: 'application/json' });
  }
  // A stand-in for the Supabase client, so the panels that check for a session
  // render their signed-out copy instead of throwing. It is loaded from a CDN
  // path with no file extension, which is exactly what the SPA-route rule below
  // used to swallow — the page then got HTML where it expected JavaScript.
  if (/supabase/i.test(u.href) && u.hostname !== 'www.blinksunited.com') {
    return route.fulfill({ contentType: 'application/javascript', body:
      'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),'
      + 'getUser:async()=>({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),'
      + 'signInWithOAuth:async()=>({}),signOut:async()=>({})},'
      + 'from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null}),limit:async()=>({data:[]})}),'
      + 'order:()=>({limit:async()=>({data:[]})})}),insert:async()=>({}),upsert:async()=>({})}),'
      + 'rpc:async()=>({data:null})})};' });
  }
  // The SPA's own routes (/voting, /badges, …) are index.html. Same-host only:
  // anything else with no extension is a third-party script and must not be
  // handed a web page.
  if (u.hostname === 'www.blinksunited.com' && !/\.\w{2,4}$/.test(u.pathname)) {
    return route.fulfill({ path: root + 'index.html', contentType: 'text/html' });
  }
  return route.fulfill({ status: 204, body: '' });
});

// The collector IS the runtime's. i18n/i18n.js exposes __collect(), which
// walks the page with the same sentence-host rule, the same skip list and the
// same key normalisation it will use at lookup time. Reimplementing that here
// would mean two definitions of "what is a key" that agree only until one of
// them is edited.
const COLLECT = `window.BU_I18N ? window.BU_I18N.__collect() : []`;

const found = new Map();   // key → { s, ctx, where:Set }
function record(items, where) {
  for (const { s, ctx, page } of items) {
    const cur = found.get(s) || { s, ctx: '', where: new Set() };
    if (!cur.ctx && ctx) cur.ctx = ctx;
    // For index.html the page the node lives in is the truth; the standalone
    // files are their own location.
    cur.where.add(where.startsWith('index.html') ? (page || 'chrome') : where);
    found.set(s, cur);
  }
}

for (const file of FILES) {
  if (!existsSync(root + file)) continue;
  await page.goto('https://www.blinksunited.com/' + (file === 'index.html' ? '' : file), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  // Overlays sit on top of the page and hide nothing, but their own text is
  // wanted too — so they are collected before being dismissed.
  record(await page.evaluate(COLLECT), file);
  await page.evaluate(() => {
    try { closeTutorial(); } catch (e) {}
    document.getElementById('tutorial-overlay')?.remove();
    document.getElementById('ext-update-overlay')?.remove();
  });

  if (file !== 'index.html') continue;

  // Each page of the SPA in turn. showPage() is what a visitor's click calls,
  // so this renders exactly what they would see.
  for (const p of SPA_PAGES) {
    try {
      await page.evaluate((name) => showPage(name), p);
      await page.waitForTimeout(900);
      record(await page.evaluate(COLLECT), 'index.html#' + p);
    } catch (e) {
      console.log(`  (could not render ${p}: ${e.message.split('\n')[0]})`);
    }
  }

  // Panels that only exist after an interaction. Each is wrapped on its own so
  // one missing function cannot cost us the rest.
  const EXTRA = [
    ['vote · the other awards', `showPage('vote'); ['breaktudo','kca','vma'].forEach(a => { try { vmaSetAward(a); } catch(e){} });`],
    ['vote · period tabs',      `['today','week','month','total'].forEach(p => { try { vmaSetPeriod(p); } catch(e){} });`],
    ['feedback · reply routes', `showPage('feedback'); ['site','email','handle','none'].forEach(v => { const s=document.getElementById('feedback-replyvia'); if(s){s.value=v; updateFeedbackReplyVia();} });`],
    ['the guide',               `try { startGuide(); } catch(e){}`],
  ];
  for (const [label, js] of EXTRA) {
    try {
      await page.evaluate(js);
      await page.waitForTimeout(700);
      record(await page.evaluate(COLLECT), 'index.html (' + label + ')');
    } catch (e) {
      console.log(`  (could not reach ${label}: ${e.message.split('\n')[0]})`);
    }
  }
}

await b.close();

const strings = [...found.values()]
  .map((x) => ({ s: x.s, ctx: x.ctx || undefined, where: [...x.where].sort() }))
  .sort((a, b2) => a.s.localeCompare(b2.s));

const outPath = root + 'i18n/strings.json';
const payload = { generated: new Date().toISOString().slice(0, 10), count: strings.length, strings };

if (CHECK) {
  // --check is for CI and for me: it answers "has the English changed since the
  // dictionaries were written?" without rewriting anything.
  if (!existsSync(outPath)) { console.log('i18n/strings.json does not exist yet — run without --check'); process.exit(1); }
  const old = JSON.parse(readFileSync(outPath, 'utf8'));
  const had = new Set(old.strings.map((x) => x.s));
  const now = new Set(strings.map((x) => x.s));
  const added = [...now].filter((s) => !had.has(s));
  const gone = [...had].filter((s) => !now.has(s));
  console.log(`strings.json: ${old.count} recorded, ${strings.length} on the page now`);
  if (added.length) { console.log(`\n${added.length} NEW string(s) — untranslated in every language:`); added.slice(0, 40).forEach((s) => console.log('  + ' + s)); }
  if (gone.length) { console.log(`\n${gone.length} string(s) no longer on the page — their translations are orphaned:`); gone.slice(0, 40).forEach((s) => console.log('  - ' + s)); }
  if (errs.length) console.log(`\npage errors: ${errs.join(' | ')}`);
  process.exit(added.length || gone.length ? 1 : 0);
}

writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`i18n/strings.json — ${strings.length} strings`);
const byPage = {};
for (const x of strings) for (const w of x.where) byPage[w] = (byPage[w] || 0) + 1;
for (const [k, v] of Object.entries(byPage).sort((a, b2) => b2[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
if (errs.length) console.log(`\npage errors while rendering: ${errs.join(' | ')}`);
