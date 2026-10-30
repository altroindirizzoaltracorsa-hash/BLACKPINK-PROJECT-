// The community goal's daily total is summed in THREE places, and they have
// to carry the same tracks.
//
// Run: node .github/scripts/test_community_goal_ids.mjs
//
// WHY THIS EXISTS. Adding ADDICTED meant adding `(s.daily_addicted || 0)` to
// each of:
//
//   index.html          computeDailyCommunityTotal  — what the bar renders
//   api/cron-scrobbles  the nightly recompute        — what gets stored
//   api/leaderboard.js  the live read                — what the bar is served
//
// Two of the three got it. The bar went on reading a total with ADDICTED
// missing, and nothing failed: every copy is valid JavaScript, every copy
// returns a plausible number, and the three only disagree by one song's worth
// of scrobbles. All three already carried a comment promising they agree,
// which is exactly the kind of promise that needs a check behind it.
//
// MEASURED AGAINST THE DECLARED LIST, NOT AGAINST EACH OTHER. CAMPAIGN_TOTAL_IDS
// is where the site says which tracks count toward the community goal, so that
// is the answer and these three are the copies. Comparing them only to one
// another would pass if all three were wrong in the same way — the failure
// this repo keeps finding.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const site = readFileSync(root + 'index.html', 'utf8');

// The declared answer.
const declBlock = (site.match(/const CAMPAIGN_TOTAL_IDS = \[([\s\S]*?)\];/) || [])[1];
check(!!declBlock, 'found CAMPAIGN_TOTAL_IDS');
const declared = [...new Set([...(declBlock || '').matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]))].sort();
check(declared.length >= 10, `it declares ${declared.length} tracks`, declared.join(' '));

// Each copy, by the ids it actually adds up.
const idsIn = (text) => [...new Set([...text.matchAll(/daily_([a-z0-9]+)\s*\|\|/g)].map((m) => m[1]))].sort();

const SUMS = [
  ['index.html · computeDailyCommunityTotal', site,
   /function computeDailyCommunityTotal[\s\S]*?\n}/],
  ['api/cron-scrobbles.js · the nightly recompute', readFileSync(root + 'api/cron-scrobbles.js', 'utf8'),
   /daily_jump[\s\S]{0,1200}?\}, 0\);/],
  ['api/leaderboard.js · the live read', readFileSync(root + 'api/leaderboard.js', 'utf8'),
   /daily_jump[\s\S]{0,1200}?\}, 0\);/],
];

for (const [name, src, re] of SUMS) {
  const block = (src.match(re) || [''])[0];
  if (!block) { check(false, `${name}: found the sum`); continue; }
  const got = idsIn(block);
  const missing = declared.filter((id) => !got.includes(id));
  const extra   = got.filter((id) => !declared.includes(id));
  check(missing.length === 0 && extra.length === 0, `${name} sums every declared track`,
        missing.length || extra.length
          ? [missing.length ? `missing ${missing.join(' ')}` : '', extra.length ? `extra ${extra.join(' ')}` : '']
              .filter(Boolean).join('; ')
          : `${got.length} tracks`);
}

console.log('\n--- and the heading over the bar names them all');
// THE FOURTH COPY, and the only one a reader sees. The three sums above can
// agree perfectly while the sentence over the bar lists eight other things,
// which is exactly what shipped: ADDICTED counted, heading silent.
//
// Checked in a browser against CAMPAIGN_TOTAL_IDS, not against the string.
// A track is "named" by its own title, or by the EP label of the release it
// belongs to — EP_RELEASES is the same membership list the leaderboard and My
// Badges read, so SaWaDiKa counts as named by "PRESS PLAY EP".
{
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { chromium } = await import('./_playwright.mjs');
  const TY = { html:'text/html', js:'text/javascript', css:'text/css', json:'application/json',
    png:'image/png', jpg:'image/jpeg', webp:'image/webp', svg:'image/svg+xml', mp4:'video/mp4' };
  const srv = createServer(async (q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/sw.js') { r.writeHead(404); r.end(''); return; }
    const f = u === '/' ? '/index.html' : u;
    try { const b = await readFile(root + f.slice(1));
      r.writeHead(200, { 'content-type': TY[f.split('.').pop()] || 'application/octet-stream' }); r.end(b); }
    catch { r.writeHead(404); r.end(''); }
  });
  await new Promise((r) => srv.listen(0, r));
  const br = await chromium.launch();
  const pg = await br.newPage();
  await pg.addInitScript(() => { try { localStorage.setItem('bu_tutorial_seen','1');
    localStorage.setItem('ltal_reminder_dismissed_v1','1'); localStorage.setItem('ext_update_dismissed_1.9.8','1'); } catch (e) {} });
  await pg.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.communityGoalLabel === 'function', null, { timeout: 30000 }).catch(() => {});

  const r = await pg.evaluate(() => ({
    label: (typeof communityGoalLabel === 'function') ? communityGoalLabel() : null,
    ids: (typeof CAMPAIGN_TOTAL_IDS !== 'undefined') ? CAMPAIGN_TOTAL_IDS.slice() : [],
    eps: (typeof EP_RELEASES !== 'undefined') ? EP_RELEASES.map((g) => ({ label: g.label, songs: g.songs })) : [],
    titles: (typeof TRACKS !== 'undefined') ? Object.fromEntries(TRACKS.map((t) => [t.id, t.title])) : {},
  }));

  // AND THE PAGE ACTUALLY PUTS IT THERE. The first version of this check
  // collected the rendered heading and never asserted it, so disabling the one
  // line that fills the element passed: a perfect builder nothing calls.
  // loadCommunityGoal is invoked directly and its rejection ignored — the fill
  // happens before the fetch precisely so the heading is right even when no
  // number arrives, and that ordering is what this proves.
  const shown = await pg.evaluate(async () => {
    try { await loadCommunityGoal(); } catch (e) {}
    return (document.getElementById('community-goal-label') || {}).textContent || '';
  });

  check(!!r.label, 'the heading is built, not typed', r.label);
  if (r.label) {
    const unnamed = r.ids.filter((id) => {
      const ep = r.eps.find((g) => g.songs.includes(id));
      return !r.label.includes(ep ? ep.label : (r.titles[id] || id));
    });
    check(unnamed.length === 0, `every counted track is named in it (${r.ids.length} counted)`,
          unnamed.length ? `missing ${unnamed.join(', ')}` : r.label.replace(/^\/\/\s*/, ''));
    // The markup's inert fallback must not carry a list of its own — a stale
    // one there would be worse than none, since it only shows when the script
    // that would have corrected it did not run.
    const raw = readFileSync(root + 'index.html', 'utf8');
    const span = (raw.match(/<span class="goal-tracker-label" id="community-goal-label">([^<]*)<\/span>/) || [])[1] || '';
    check(!span.includes('+'), 'and the static fallback lists no tracks of its own', span.trim());
    check(shown === r.label, 'and the page renders the built heading, not the fallback',
          shown === r.label ? 'rendered' : `showing ${shown.trim()}`);
  }
  await br.close(); srv.close();
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
