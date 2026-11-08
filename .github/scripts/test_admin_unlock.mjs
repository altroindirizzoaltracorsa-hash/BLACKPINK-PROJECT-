// The admin unlock answers, and answers quickly.
//
// Run: node .github/scripts/test_admin_unlock.mjs
//
// WHAT BROKE. The unlock on the home page used /api/control-ranking as its
// password check and passed it EVERY user on the leaderboard to do it:
//
//     fetch(`/api/control-ranking?key=${key}&users=${users.join(',')}`)
//
// That endpoint answers the auth question in its first six lines and then,
// for each user, runs two countScrobbles calls that each paginate up to five
// pages — up to ten Last.fm requests per user. At 204 users that is up to
// 2,040 requests against a key whose entire budget is ~5 per second. It never
// finished inside the function timeout, so the fetch never settled, and since
// every other branch of submitAdminKey writes a message the status line sat on
// "Checking…" forever. girlgroups.html meanwhile kept telling people to go and
// unlock on a page where unlocking could not complete.
//
// It worked when the board was small. The cost grew with the board and nothing
// announced the crossing — which is why this is pinned by shape rather than by
// a number: there is no user count at which sending the whole board is right.
//
// Three properties, each of which was false and each of which hung the page:
//   1. the check sends the KEY, not the board
//   2. it cannot wait forever
//   3. it does not refuse to start until unrelated data has loaded
// Plus the server half: ?check=1 must short-circuit before the expensive work,
// and before the CONTROL_ARTIST/TRACK validation, since a correct key is
// correct whether or not the control song is configured.
//
// Static analysis. No browser, no network.

import { readFileSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8');

let fails = 0;
const ok  = (m, d) => console.log(`  ok   ${m}${d ? ` (${d})` : ''}`);
const bad = (m, d) => { fails++; console.log(`  FAIL ${m}${d ? ` (${d})` : ''}`); };

const ix = read('index.html');
const api = read('api/control-ranking.js');

// The function body, bounded at the next top-level declaration so a later
// function's fetch cannot be mistaken for this one's.
const fn = (ix.match(/async function submitAdminKey\(\)[\s\S]*?\n}\n/) || [''])[0];

console.log('--- the client half');
fn ? ok('found submitAdminKey()', `${fn.split('\n').length} lines`)
   : bad('found submitAdminKey()', 'nothing below means anything');

if (fn) {
  const call = (fn.match(/fetch\(`([^`]*)`/) || [])[1] || '';
  call ? ok('  it calls an endpoint', call.replace(/\$\{[^}]*\}/g, '…'))
       : bad('  it calls an endpoint');

  /[?&]check=1/.test(call)
    ? ok('  with check=1, so the server can answer without doing the work')
    : bad('  with check=1, so the server can answer without doing the work', call || '(no call)');

  // The exact regression: a user list in the query string.
  !/users=/.test(call)
    ? ok('  and sends no user list')
    : bad('  and sends no user list',
          'the whole board goes into the URL and the endpoint walks it through Last.fm — this is the hang');

  // Comments stripped first: the comment explaining this fix necessarily
  // quotes the old `lbData` line, and matching your own explanation of a bug
  // as the bug is its own kind of false positive.
  const code = fn.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  !/lbData/.test(code)
    ? ok('  and does not depend on the leaderboard having loaded')
    : bad('  and does not depend on the leaderboard having loaded',
          'it refuses to start until unrelated data arrives — a second way to be stuck');

  /withTimeout\s*\(/.test(fn)
    ? ok('  and cannot wait forever')
    : bad('  and cannot wait forever',
          'nothing bounds the fetch, so a request that never settles leaves the status on "Checking…"');

  // Every exit writes something. A branch that returns silently is the same
  // bug wearing a different hat: the status keeps whatever it last said.
  const returns = (fn.match(/\breturn\b/g) || []).length;
  const writes  = (fn.match(/errEl\.textContent\s*=/g) || []).length;
  writes > returns
    ? ok('  and every exit leaves a message', `${writes} messages, ${returns} returns`)
    : bad('  and every exit leaves a message',
          `${writes} messages for ${returns} returns — at least one path exits on a stale status`);
}

console.log('\n--- the server half');
const auth = api.indexOf("req.query.key !== adminSecret");
const check = api.indexOf("req.query.check === '1'");
const cfg = api.indexOf('process.env.CONTROL_ARTIST');
// The CALL SITE, not the definition. countScrobbles is declared near the top
// of the file, well above the handler, so comparing against the declaration
// said the short-circuit came "after the work" when it comes after nothing of
// the sort. Search from the handler onward.
const handler = api.indexOf('export default async function handler');
const work = api.indexOf('countScrobbles(username', handler);

check > -1 ? ok('?check=1 is handled') : bad('?check=1 is handled', 'the client asks for it and the server does not answer it');
check > auth
  ? ok('  after the auth check, so it cannot be used to skip it')
  : bad('  after the auth check, so it cannot be used to skip it', 'an unauthenticated caller would get ok:true');
check > -1 && check < cfg
  ? ok('  and before the CONTROL_ARTIST/TRACK check')
  : bad('  and before the CONTROL_ARTIST/TRACK check',
        'an unconfigured control song would 500 a correct key, which reads as a wrong password');
check > -1 && check < work
  ? ok('  and before any Last.fm work')
  : bad('  and before any Last.fm work', 'the short-circuit is below the expensive part, so it short-circuits nothing');

console.log(fails ? `\n${fails} FAILED` : '\nThe unlock answers.');
process.exit(fails ? 1 : 0);
