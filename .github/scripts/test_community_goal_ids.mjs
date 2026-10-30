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

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
