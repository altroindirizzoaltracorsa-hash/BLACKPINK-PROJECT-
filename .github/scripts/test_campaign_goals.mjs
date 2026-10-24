// Every campaign's goal checklist, in a real browser.
//
// Run: node .github/scripts/test_campaign_goals.mjs
//
// A campaign needs three things to work, and PRESS PLAY had only one of them:
// it was registered in CAMPAIGN_GOALS, but with `categories: []` and with a
// `mount` naming an element that did not exist in the page. Neither gap
// throws — renderReleaseGoalsList returns early on both — so the campaign sat
// there looking configured, and the admin picker quietly said "no goals yet"
// for weeks.
//
// Also pinned: goal ids are the storage key for "this one was reached", so a
// duplicate id silently makes two goals tick together, and renaming one
// forgets a goal that was already won.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA=/^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server=createServer(async(req,res)=>{const p=decodeURIComponent(req.url.split('?')[0]);
  const file=p==='/'?'/index.html':SPA.test(p)?'/index.html':p;
  try{const b=await readFile(ROOT+file);const e=file.split('.').pop();
    res.writeHead(200,{'content-type':{html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',
      svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',webp:'image/webp',mp4:'video/mp4'}[e]||'application/octet-stream'});
    res.end(b);}catch{res.writeHead(404);res.end('{}');}});
await new Promise(r=>server.listen(0,r));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:430,height:950}});
await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
  localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.7','1');}catch(e){}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
let fails=0;
const ok=(m,d)=>console.log(`  ok   ${m}${d?` (${d})`:''}`);
const bad=(m,d)=>{fails++;console.log(`  FAIL ${m}${d?` (${d})`:''}`);};
await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(2000);

const R = await page.evaluate(() => CAMPAIGN_GOALS.map(c => ({
  slug: c.slug, name: c.name, adminOnly: !!c.adminOnly, mount: c.mount,
  mountExists: !!(c.mount && document.getElementById(c.mount)),
  cats: c.categories.length,
  ids: c.categories.flatMap(cat => cat.items.map(i => i.id)),
  labels: c.categories.flatMap(cat => cat.items.map(i => i.label)),
  emptyCats: c.categories.filter(cat => !cat.items.length).map(cat => cat.category),
})));

console.log('    ' + R.map(c => `${c.slug}:${c.ids.length}`).join('  '));

// Every id unique across the WHOLE table — they share one storage namespace.
const all = R.flatMap(c => c.ids);
const dupes = [...new Set(all.filter((id, i) => all.indexOf(id) !== i))];
dupes.length ? bad('goal ids are unique across every campaign', dupes.join(', '))
             : ok('goal ids are unique across every campaign', `${all.length} ids`);
const blank = R.flatMap(c => c.ids.filter(id => !id || !/^[a-z0-9_]+$/.test(id)));
blank.length ? bad('every goal id is a plain storage-safe key', blank.join(', '))
             : ok('every goal id is a plain storage-safe key');
const noLabel = R.flatMap(c => c.labels.filter(l => !l || !l.trim()));
noLabel.length ? bad('every goal has a label') : ok('every goal has a label');

// A campaign with goals must have somewhere to render them — the gap that
// made PRESS PLAY look configured while showing nothing.
for (const c of R) {
  if (c.adminOnly) continue;
  if (!c.cats) { console.log(`    ${c.slug}: no goals yet (not an error)`); continue; }
  c.mountExists
    ? ok(`${c.slug} has its mount element`, c.mount)
    : bad(`${c.slug} has its mount element — #${c.mount} is not in the page`);
  c.emptyCats.length
    ? bad(`${c.slug} has no empty categories`, c.emptyCats.join(', '))
    : ok(`${c.slug} has no empty categories`, `${c.cats} categories`);
}

// PRESS PLAY specifically, against the poster it was transcribed from.
const pp = R.find(c => c.slug === 'press-play');
// Counted off the poster section by section, not as one total: a total can be
// right while a row is in the wrong half, and my first attempt at this number
// was simply miscounted (25 for what is 9 + 19).
const POSTER = {
  '💿 EP · Spotify': 4, '💿 EP · Charts': 2, '💿 EP · iTunes': 2, '💿 EP · Apple Music': 1,
  '🔫 Tarantino · Spotify': 2, '🔫 Tarantino · YouTube': 3, '🔫 Tarantino · Shazam': 2,
  '🔫 Tarantino · iTunes': 6, '🔫 Tarantino · Apple Music': 3, '🔫 Tarantino · Charts': 3,
};
const ppCounts = await page.evaluate(() => Object.fromEntries(
  CAMPAIGN_GOALS.find(c => c.slug === 'press-play').categories.map(c => [c.category, c.items.length])));
const wrong = Object.entries(POSTER)
  .filter(([k, n]) => ppCounts[k] !== n)
  .map(([k, n]) => `${k}: ${ppCounts[k] ?? 'missing'} want ${n}`);
const extra = Object.keys(ppCounts).filter(k => !(k in POSTER));
wrong.length || extra.length
  ? bad('every PRESS PLAY section matches the poster', [...wrong, ...extra.map(e => `unexpected ${e}`)].join('; '))
  : ok('every PRESS PLAY section matches the poster', `${pp.ids.length} goals, 9 album + 19 title track`);
const bothHalves = pp && pp.ids.some(i => i.startsWith('pp_ep_')) && pp.ids.some(i => i.startsWith('pp_tt_'));
bothHalves ? ok('both halves present — album goals and title-track goals')
           : bad('both halves present — album goals and title-track goals');

// Only REACHED goals render. With none reached the block must stay hidden
// rather than showing an empty "Goals reached 0" heading.
const hidden = await page.evaluate(async () => {
  await renderReleaseGoalsList('press-play');
  const el = document.getElementById('lisa-goals-list');
  return { display: el.style.display, html: el.innerHTML.length };
});
hidden.display === 'none' && hidden.html === 0
  ? ok('with nothing reached yet, the block stays hidden')
  : bad('with nothing reached yet, the block stays hidden', JSON.stringify(hidden));

// And it renders once something IS reached — stubbing the API the renderer reads.
const shown = await page.evaluate(async () => {
  const real = window.fetch;
  window.fetch = async (u, ...r) => String(u).includes('ltal_goals=list')
    ? { json: async () => ({ reached: { pp_tt_sz_24h: true }, values: { pp_tt_sz_24h: '12,400' } }) }
    : real(u, ...r);
  try {
    await renderReleaseGoalsList('press-play');
    const el = document.getElementById('lisa-goals-list');
    return { display: el.style.display, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
             rows: el.querySelectorAll('.ltal-goal-item').length };
  } finally { window.fetch = real; }
});
shown.rows === 1 && shown.display !== 'none'
  ? ok('a reached goal renders, with its value', shown.text)
  : bad('a reached goal renders, with its value', JSON.stringify(shown));
shown.text.includes('12,400')
  ? ok('the recorded value is shown next to it')
  : bad('the recorded value is shown next to it', shown.text);

if (errs.length) { console.log('    page errors: ' + errs.slice(0,3).join(' | ')); fails += errs.length; }
await browser.close(); server.close();
console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
