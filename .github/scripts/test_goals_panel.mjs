/**
 * Runs in GitHub Actions (network can reach the Vercel deployment; Claude Code
 * sessions can't hit blinksunited.com directly). Smoke-tests the consolidated
 * admin panel + per-release Campaign Goals against the LIVE site:
 *
 *   1. Fetches the deployed index.html and asserts the new unified admin menu
 *      and per-release CAMPAIGN_GOALS (incl. the Fallen Angel goal ids) shipped.
 *   2. Hits /api/proxy-image?ltal_goals=list (public read) to confirm the
 *      goals backend responds and reports how many goals are marked reached.
 *   3. Does a non-destructive toggle round-trip with ADMIN_KEY on a Fallen
 *      Angel goal — flips it, verifies the flip, then flips it back to the
 *      original value. This exercises the exact call the goals panel makes.
 *
 * Prints ✅/❌ per check and exits non-zero if anything failed.
 */

const VERCEL_URL = process.env.VERCEL_URL || 'https://blinksunited.com';
const ADMIN_KEY  = process.env.ADMIN_KEY;

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log('✅ ' + msg); }
  else      { console.log('❌ ' + msg); failed++; }
}

async function main() {
  console.log(`Testing goals panel against: ${VERCEL_URL}\n`);

  // ── 1. Deployed HTML ───────────────────────────────────────────────
  // NB: vercel.json redirects "/" → /vmas.html, so fetch the app document
  // directly. /index.html serves the single-file SPA that hosts the admin panel.
  const html = await (await fetch(`${VERCEL_URL}/index.html?_cb=${Date.now()}`)).text();
  assert(html.includes('admin-menu-tile'),          'Unified admin menu tiles present in deployed HTML');
  assert(html.includes("adminShowPanel('goals')"),  'Campaign Goals menu entry present');
  assert(html.includes('const CAMPAIGN_GOALS'),     'Per-release CAMPAIGN_GOALS model present');
  assert(html.includes('fa_sp_fa_d1_p') && html.includes('fa_ch_uk') && html.includes('fa_it_majors'),
                                                     'Fallen Angel goal ids present');
  assert(!html.includes('id="admin-goal-select"'),  'Old single-goal <select> removed');
  assert(!html.includes('id="milestone-admin-overlay"') && !html.includes('id="playlist-overlay"'),
                                                     'Separate milestone/playlist overlays removed');

  // ── 2. Goals list API (public read) ────────────────────────────────
  const listRes = await fetch(`${VERCEL_URL}/api/proxy-image?ltal_goals=list`, { cache: 'no-store' });
  assert(listRes.ok, `ltal_goals=list responds HTTP ${listRes.status}`);
  const list = await listRes.json().catch(() => ({}));
  const reached = list.reached || {};
  const reachedCount = Object.keys(reached).filter(k => reached[k]).length;
  console.log(`   ${reachedCount} goal(s) currently marked reached across all releases`);

  // ── 3. Toggle round-trip with the admin key (restores original) ────
  if (!ADMIN_KEY) {
    console.log('⚠ ADMIN_KEY secret not set — skipping the live toggle round-trip.');
  } else {
    const TID = 'fa_yt_24h'; // Fallen Angel · YouTube 24h — admin-only, no public surface
    const before = !!reached[TID];

    const t1 = await (await fetch(`${VERCEL_URL}/api/proxy-image?ltal_goals=toggle&id=${TID}&key=${encodeURIComponent(ADMIN_KEY)}`, { method: 'POST' })).json().catch(() => ({}));
    const after1 = !!(t1.reached || {})[TID];
    assert(after1 === !before, `Toggle flipped ${TID}: ${before} → ${after1}`);

    const t2 = await (await fetch(`${VERCEL_URL}/api/proxy-image?ltal_goals=toggle&id=${TID}&key=${encodeURIComponent(ADMIN_KEY)}`, { method: 'POST' })).json().catch(() => ({}));
    const after2 = !!(t2.reached || {})[TID];
    assert(after2 === before, `Toggle restored ${TID} to its original value (${before})`);
  }

  console.log('');
  if (failed) { console.error(`${failed} check(s) failed.`); process.exit(1); }
  console.log('All goals-panel checks passed on the live site.');
}

main().catch(e => { console.error(e); process.exit(1); });
