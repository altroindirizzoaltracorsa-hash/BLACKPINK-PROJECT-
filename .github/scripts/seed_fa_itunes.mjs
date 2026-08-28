/**
 * Seeds the Fallen Angel EP iTunes results into the Campaign Goals backend
 * (Redis via /api/proxy-image). Runs in GitHub Actions because Claude Code
 * sessions can't reach blinksunited.com directly.
 *
 * Data (as reported): EP #1 in 15 countries; Fallen Angel charting in 30
 * markets, Heaven in 34. Writes each row's achieved value via ltal_goals=set_value
 * and marks the relevant goals reached via ltal_goals=toggle (only if not already
 * reached, so re-runs are idempotent). Admin-only panel — nothing public changes.
 */

const VERCEL_URL = process.env.VERCEL_URL || 'https://blinksunited.com';
const ADMIN_KEY  = process.env.ADMIN_KEY;
if (!ADMIN_KEY) { console.error('ADMIN_KEY secret not set'); process.exit(1); }

const EP_NO1 = [
  '🇧🇷','🇰🇭','🇨🇿','🇭🇰','🇮🇩','🇰🇿','🇲🇾','🇵🇭',
  '🇸🇦','🇸🇬','🇪🇸','🇹🇼','🇹🇭','🇹🇷','🇻🇳',
].join(' ');

// value rows to set
const VALUES = {
  fa_it_ep_no1:         `${EP_NO1} (15)`,
  fa_it_secondary:      '15 #1 countries ✓',
  fa_it_primary:        '15 ≥ 10 ✓',
  fa_it_fa_markets:     '30 markets',
  fa_it_heaven_markets: '34 markets',
};
// goals to ensure marked reached
const REACH = ['fa_it_primary', 'fa_it_secondary', 'fa_it_ep_no1', 'fa_it_fa_markets', 'fa_it_heaven_markets'];

const q = (id, extra) => `${VERCEL_URL}/api/proxy-image?ltal_goals=${id}&key=${encodeURIComponent(ADMIN_KEY)}${extra}`;

async function main() {
  console.log(`Seeding Fallen Angel iTunes results → ${VERCEL_URL}\n`);

  // Read current reached state so we only flip goals that are still off.
  const list = await (await fetch(`${VERCEL_URL}/api/proxy-image?ltal_goals=list`, { cache: 'no-store' })).json();
  const reached = list.reached || {};

  for (const [id, value] of Object.entries(VALUES)) {
    const r = await (await fetch(q('set_value', `&id=${id}&value=${encodeURIComponent(value)}`), { method: 'POST' })).json();
    console.log(r.ok ? `✅ value ${id} = "${value}"` : `❌ value ${id}: ${JSON.stringify(r)}`);
  }

  for (const id of REACH) {
    if (reached[id]) { console.log(`• ${id} already reached`); continue; }
    const r = await (await fetch(q('toggle', `&id=${id}`), { method: 'POST' })).json();
    const now = !!(r.reached || {})[id];
    console.log(now ? `✅ reached ${id}` : `❌ toggle ${id}: ${JSON.stringify(r)}`);
  }

  // Verify
  const after = await (await fetch(`${VERCEL_URL}/api/proxy-image?ltal_goals=list`, { cache: 'no-store' })).json();
  console.log('\nValues now:', JSON.stringify(after.values || {}, null, 0));
}

main().catch(e => { console.error(e); process.exit(1); });
