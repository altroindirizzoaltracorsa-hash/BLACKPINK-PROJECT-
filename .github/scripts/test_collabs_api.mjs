// api/collabs.js — the aggregation behind the collab board.
//
// Run: node .github/scripts/test_collabs_api.mjs
//
// Nothing here can be exercised against a real Supabase from a session, so the
// pure parts are pulled out and run directly. They are also the parts where a
// mistake is invisible: a board that sums one person's days wrongly still
// renders as a perfectly plausible board.
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// Same loader shape as test_mama_votes: the handler's one import is stubbed so
// the file can be evaluated without node_modules, and every import has to be
// accounted for rather than only the ones this test knew about.
function load() {
  const src = readFileSync(root + 'api/collabs.js', 'utf8');
  const stripped = src
    .replace(/^import \{ createClient \} from '@supabase\/supabase-js';$/m, '// stubbed by the test')
    .replace(/^export default async function handler/m, 'async function handler')
    .replace(/^export const __test = .*$/m, '');
  const leftover = stripped.match(/^import .*$/gm) || [];
  if (leftover.length) throw new Error('unstubbed import: ' + leftover.join(' / '));
  if (stripped === src) throw new Error('api/collabs.js no longer looks the way this test rewrites it');
  // The handler builds its client from env at call time, so the stub goes in
  // through createClient and the env only has to be non-empty.
  return new Function('createClient', 'process',
    stripped + '\nreturn { kstDay, mondayOf, periodFrom, sumOf, addInto, SLUG_RE, FANDOM_RE,'
             + ' NAME_PREFIX_RE, syncAccountFandom, handler };')(
    (url, key) => (globalThis.__sbStub || {}),
    { env: { SUPABASE_URL: 'https://stub', SUPABASE_SERVICE_KEY: 'stub' } });
}

const api = load();

console.log('--- the KST day, and the week it belongs to');
// 23:30 UTC on the 17th is already the 18th in Seoul. Getting this wrong puts
// a vote in yesterday's bucket for everyone west of Asia, which is most people.
check(api.kstDay(new Date('2026-10-17T23:30:00Z')) === '2026-10-18',
      '23:30 UTC is already tomorrow in Seoul', api.kstDay(new Date('2026-10-17T23:30:00Z')));
check(api.kstDay(new Date('2026-10-17T14:00:00Z')) === '2026-10-17',
      'and 14:00 UTC is not');
// Monday-start. Sunday is the END of its week, not the start of the next —
// the off-by-one that makes "this week" empty every Sunday.
check(api.mondayOf('2026-10-18') === '2026-10-12', 'Sunday belongs to the week that began Monday',
      api.mondayOf('2026-10-18'));
check(api.mondayOf('2026-10-12') === '2026-10-12', 'and Monday is its own week start');
check(api.mondayOf('2026-11-02') === '2026-11-02', 'across a month boundary too',
      api.mondayOf('2026-11-02'));

console.log('--- one period, built from rows');
const rows = [
  { app_user_id: 'a', day: '2026-10-17', votes: 4, cats: { X: 3, Y: 1 }, display_name: null },
  { app_user_id: 'a', day: '2026-10-18', votes: 2, cats: { X: 1, Y: 1 }, display_name: 'ana' },
  { app_user_id: 'b', day: '2026-10-18', votes: 9, cats: { X: 9 }, display_name: 'bee' },
];
const p = api.periodFrom(rows);
check(p.byCat.X === 13 && p.byCat.Y === 2, 'categories are pooled across everybody',
      JSON.stringify(p.byCat));
check(p.total === 15, 'and the total is their sum', String(p.total));
check(p.board.length === 2, 'one line per account, not per row', String(p.board.length));
check(p.board[0].name === 'bee' && p.board[0].votes === 9, 'ordered by votes',
      p.board.map((b) => `${b.name}:${b.votes}`).join(' '));
// a voted on two days; both must land on the one line.
const a = p.board.find((x) => x.name === 'ana');
check(!!a && a.votes === 6, 'a person\'s days are summed onto their line', a && String(a.votes));
check(!!a && a.byCat.X === 4 && a.byCat.Y === 2, 'and so is their category split',
      a && JSON.stringify(a.byCat));
// The first row for `a` had no display_name. A later row that has one must win,
// or the extension writing before a profile has a name blanks it out.
check(!!a, 'a name written later wins over an earlier blank', a ? a.name : 'dropped');

console.log('--- a row\'s votes always equal its own split');
// The table has a CHECK saying exactly this. The API sums the merged map rather
// than adding to the previous total, so a board ordered by `votes` can never
// disagree with the chips printed under it.
const merged = Object.assign({}, { X: 3 }, {});
merged.X += 2; merged.Z = 1;
check(api.sumOf(merged) === 6, 'sumOf matches the map it was built from', String(api.sumOf(merged)));
const into = { X: 1 };
api.addInto(into, { X: 2, Y: 0, Z: -5 });
check(into.X === 3 && into.Y === undefined && into.Z === undefined,
      'and merging drops zero and negative counts', JSON.stringify(into));

console.log('--- who turned up, by the side they declared');
// The only competition this board can honestly run. It counts PEOPLE: the
// per-act totals stay pooled, because everyone in a collab votes the whole
// ballot and no vote belongs to a fandom.
{
  // Two people on one side, one on the other, one who never said — and one of
  // them voting on two days, because a person is counted once however many
  // days they logged. Counting rows instead would make the keenest voter look
  // like a crowd.
  const rows = [
    { app_user_id: 'a', day: '2026-10-18', votes: 4, cats: { X: 4 }, display_name: 'ana', fandom: 'blink' },
    { app_user_id: 'a', day: '2026-10-19', votes: 4, cats: { X: 4 }, display_name: 'ana', fandom: 'blink' },
    { app_user_id: 'b', day: '2026-10-19', votes: 2, cats: { X: 2 }, display_name: 'bea', fandom: 'blink' },
    { app_user_id: 'c', day: '2026-10-19', votes: 9, cats: { X: 9 }, display_name: 'cy',  fandom: 'bloom' },
    { app_user_id: 'd', day: '2026-10-19', votes: 1, cats: { X: 1 }, display_name: 'dee', fandom: null },
  ];
  const fandomOf = new Map();
  for (const r of rows) if (r.fandom) fandomOf.set(r.app_user_id, r.fandom);
  const all = api.periodFrom(rows, fandomOf);
  check(all.fandoms.blink.people === 2, `two people on one side, not four rows (${all.fandoms.blink.people})`);
  check(all.fandoms.blink.votes === 10, `and their votes add up across days (${all.fandoms.blink.votes})`);
  check(all.fandoms.bloom.people === 1 && all.fandoms.bloom.votes === 9, 'the other side is counted too');
  // Never folded into either side, and never dropped: the votes are in the
  // totals like anyone else's, and the page says how many people that is.
  check(all.fandoms.unsaid && all.fandoms.unsaid.people === 1,
        'somebody who never said is their own row, not assigned');
  // The thing this must never do.
  check(all.total === 20 && api.sumOf(all.byCat) === 20,
        `the per-act total is untouched by any of it (${all.total})`);

  // A person who declares TODAY is that side in the all-time view too. The map
  // is built across every row and handed in, so a period that happens to hold
  // only their earlier days still knows who they are — otherwise one person
  // answers twice, once as themselves and once as "didn't say".
  const earlier = api.periodFrom(rows.filter((r) => r.day === '2026-10-18'), fandomOf);
  check(earlier.fandoms.blink && earlier.fandoms.blink.people === 1,
        'and a side declared later still labels the earlier days');
}

console.log('--- what may be used as a fandom key');
// Stored, counted and printed on a page, and the caller is an extension
// anybody can edit.
for (const [v, want, why] of [
  ['blink', true, 'a plain key'],
  ['bloom-2', true, 'with a digit and a dash'],
  ['', false, 'empty'],
  ['BLINK', false, 'upper case — the API lowercases before testing'],
  ['<b>x</b>', false, 'markup'],
  ['-leading', false, 'starting with a dash'],
  ['a'.repeat(40), false, 'absurdly long'],
]) {
  check(api.FANDOM_RE.test(v) === want, `${why} is ${want ? 'accepted' : 'refused'}`);
}

console.log('--- what may be used as a category');
for (const [v, want, why] of [
  ['Favorite Music Group or Duo', true, 'a real ballot category'],
  ["Favorite Kids’ Choice", true, 'with a curly apostrophe'],
  ['', false, 'empty'],
  ['<script>x</script>', false, 'markup'],
  ['a'.repeat(100), false, 'absurdly long'],
]) {
  check(api.SLUG_RE.test(v) === want, `${why} is ${want ? 'accepted' : 'refused'}`);
}

console.log('\n--- the fandom answer reaches the account, and the name follows it');
// The answer usually arrives through the EXTENSION, and somebody who votes that
// way may never open blinksunited.com again — so until this existed their row
// on the collab board read "blink41" for ever, on the one board whose whole
// point is showing each fandom turning up.
//
// The rule being tested is the dangerous one: rename an auto name, never a name
// somebody chose. The flag is what tells them apart, because "bloom12" is a
// perfectly plausible thing for a person to have picked by hand.
function stubSb(meta, opts = {}) {
  const log = { updated: null, minted: 0, rowNames: [] };
  const sb = {
    auth: { admin: {
      getUserById: async () => (opts.noUser ? { data: null } : { data: { user: { user_metadata: meta } } }),
      updateUserById: async (_uid, patch) => {
        log.updated = patch.user_metadata;
        return { error: opts.updateFails ? { message: 'nope' } : null };
      },
    } },
    rpc: async (fn, args) => {
      if (fn !== 'mint_fan_name') throw new Error('unexpected rpc ' + fn);
      if (opts.noFunction) return { data: null, error: { message: 'function does not exist' } };
      log.minted++;
      // Answers like mint_fan_name does, INCLUDING its fallback: a prefix it
      // will not accept comes back as a blink name rather than an error. That
      // fallback is there so a signup is never failed over a label — and it is
      // exactly why the caller has to refuse such a prefix itself.
      const prefix = /^[a-z][a-z0-9]{1,20}$/.test(args.p_prefix) ? args.p_prefix : 'blink';
      return { data: prefix + '9', error: null };
    },
    from: (table) => {
      if (table === 'linked_accounts') {
        // Whether a Last.fm handle is already showing for them.
        const res = { data: opts.linked ? [{ id: 'x' }] : [], error: null };
        const q = { select: () => q, eq: () => q, limit: async () => res };
        return q;
      }
      return { update: (patch) => { log.rowNames.push(patch.display_name); return { eq: async () => ({}) }; } };
    },
  };
  return { sb, log };
}

{
  // An auto name, and they now say they are a BLOOM.
  const { sb, log } = stubSb({ display_name: 'blink41', display_name_auto: true });
  const out = await api.syncAccountFandom(sb, 'u1', 'bloom', 'blink41');
  check(out === 'bloom9', 'an auto name is renamed for the fandom', out);
  check(log.updated && log.updated.display_name === 'bloom9', 'and the account carries the new name');
  check(log.updated && log.updated.fandom === 'bloom', 'with the answer itself recorded beside it');
  check(log.updated && log.updated.display_name_auto === true, 'still flagged auto, so a later answer still works');
  // Their earlier rows keep the old name otherwise, and the board takes the
  // last non-null one it happens to read — which with no ordering is any of them.
  check(log.rowNames.includes('bloom9'), 'and the rows already written are brought with it');
}
{
  // The one that must never happen.
  const { sb, log } = stubSb({ display_name: 'ROSÉ4ever' });
  const out = await api.syncAccountFandom(sb, 'u2', 'bloom', 'ROSÉ4ever');
  check(out === 'ROSÉ4ever', 'a name they chose is left alone', out);
  check(log.minted === 0, 'nothing is minted for them');
  check(log.updated && log.updated.display_name === 'ROSÉ4ever', 'and their name is not overwritten');
  check(log.updated && log.updated.fandom === 'bloom', 'but they are still counted as a BLOOM');
  check(log.rowNames.length === 0, 'and no row is rewritten');
}
{
  // Named before the auto flag existed. That namespace was never choosable, so
  // it is auto by construction — the same fallback the SQL makes.
  const { sb } = stubSb({ display_name: 'blink12' });
  const out = await api.syncAccountFandom(sb, 'u3', 'bloom', 'blink12');
  check(out === 'bloom9', 'a legacy blinkN counts as auto even without the flag', out);
}
{
  // Every vote carries the answer, so this runs on every round of every day.
  const { sb, log } = stubSb({ display_name: 'bloom5', display_name_auto: true, fandom: 'bloom' });
  const out = await api.syncAccountFandom(sb, 'u4', 'bloom', 'bloom5');
  check(out === 'bloom5' && log.minted === 0, 'an answer that already matches mints nothing', out);
  check(log.updated === null, 'and writes nothing at all — not once per vote');
}
{
  // fan_display_names.sql is applied by hand in the Supabase SQL editor, so the
  // code ships first. A missing function must cost a label, never a vote.
  const { sb, log } = stubSb({ display_name: 'blink41', display_name_auto: true }, { noFunction: true });
  const out = await api.syncAccountFandom(sb, 'u5', 'bloom', 'blink41');
  check(out === 'blink41', 'without the migration the name simply stays', out);
  check(log.updated && log.updated.fandom === 'bloom', 'and the answer is still recorded');
}
{
  // A hyphenated key is a perfectly good fandom to count people under, but
  // mint_fan_name would fall back to "blink" for it — which would name a
  // hyphenated fandom's member a blink. Better to leave the name alone.
  check(api.FANDOM_RE.test('x-men') && !api.NAME_PREFIX_RE.test('x-men'),
        'a hyphenated fandom key is countable but not nameable');
  const { sb, log } = stubSb({ display_name: 'blink41', display_name_auto: true });
  const out = await api.syncAccountFandom(sb, 'u6', 'x-men', 'blink41');
  check(out === 'blink41' && log.minted === 0, 'so it never names anybody a blink by accident', out);
  check(log.updated && log.updated.fandom === 'x-men', 'while still counting them');
}
{
  // The vote is the thing that must land. Everything here is a label.
  const { sb } = stubSb({ display_name: 'blink41', display_name_auto: true }, { updateFails: true });
  const out = await api.syncAccountFandom(sb, 'u7', 'bloom', 'blink41');
  check(out === 'blink41', 'a failed write leaves the row with the name it had', out);
  const { sb: sb2 } = stubSb(null, { noUser: true });
  const out2 = await api.syncAccountFandom(sb2, 'u8', 'bloom', 'whoever');
  check(out2 === 'whoever', 'and an account that cannot be read changes nothing', out2);
}

{
  // Somebody with NO display name, here for the collab and nothing else. They
  // have to end up NUMBERED, or every nameless person on the board reads the
  // same and none of them can find their own row.
  const { sb, log } = stubSb({}, { linked: false });
  const out = await api.syncAccountFandom(sb, 'u20', 'bloom', null);
  check(out === 'bloom9', 'somebody with no name at all is given a numbered one', String(out));
  check(log.updated && log.updated.display_name === 'bloom9', 'and the account carries it');
  check(log.updated && log.updated.display_name_auto === true,
        'flagged auto, so it gives way the moment they choose their own');
}
{
  // The same, but their Last.fm handle is already showing on the streaming
  // leaderboard. Naming them would replace it with a number they never asked
  // for — which this site did once and had to undo.
  const { sb, log } = stubSb({}, { linked: true });
  const out = await api.syncAccountFandom(sb, 'u21', 'bloom', null);
  check(out === null && log.minted === 0,
        'but not somebody whose handle is already on show', String(out));
  check(log.updated && log.updated.fandom === 'bloom', 'they are still counted as a BLOOM');
}
{
  // A fandom key that cannot start a name would mint "blink9" — so nobody is
  // named rather than a BLOOM being called a blink.
  const { sb, log } = stubSb({}, { linked: false });
  const out = await api.syncAccountFandom(sb, 'u22', 'x-men', null);
  check(out === null && log.minted === 0, 'and nobody is numbered under a key that cannot name them');
}

console.log('\n--- logging a vote never requires a scrobbler');
// The rule this collab is built on: a partner fandom is NOT asked to set up a
// streaming account to have their votes counted. They sign in, link the
// counter, and that is the whole of it — the page says so in those words, and
// nothing in the vote path may quietly start disagreeing with it.
//
// The one linked_accounts lookup in this file decides a NAME, never whether a
// vote is taken. This drives the real handler to prove that, with an account
// that has no scrobbler and never will.
{
  const stored = [];
  const voter = { id: 'bloom-no-scrobbler', user_metadata: {} };
  globalThis.__sbStub = {
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: voter } }),
        updateUserById: async (_i, patch) => { voter.user_metadata = patch.user_metadata; return { error: null }; },
      },
      getUser: async () => ({ data: { user: voter } }),
    },
    rpc: async (fn, args) => ({ data: args.p_prefix + '1', error: null }),
    from: (table) => {
      if (table === 'scrobble_tokens') {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { app_user_id: voter.id } }) };
        return q;
      }
      if (table === 'linked_accounts') {
        // No scrobbler. Not one, not ever.
        const q = { select: () => q, eq: () => q, limit: async () => ({ data: [], error: null }) };
        return q;
      }
      const q = {
        select: () => q, eq: () => q, is: () => q,
        maybeSingle: async () => ({ data: null }),
        upsert: async (row) => { stored.push(row); return { error: null }; },
        update: () => ({ eq: () => ({ is: async () => ({}) }), is: async () => ({}) }),
      };
      return q;
    },
  };

  let status = 0, body = null;
  const res = { setHeader() {}, status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await api.handler({
    method: 'POST', query: {}, headers: {},
    body: { id: 'bvp-kca-2026', extToken: 'tok', fandom: 'bloom',
            cats: { 'favorite-music-group-or-duo': 1, 'favorite-global-music-star': 1 } },
  }, res);

  check(status === 200, `the vote is accepted with no scrobbler linked (HTTP ${status})`,
        body && body.error ? body.error : '');
  check(!!body && body.votes === 2, 'and both picks are counted', body ? String(body.votes) : '-');
  check(stored.length === 1 && stored[0].app_user_id === voter.id,
        'a row is written for them like anybody else');
  // And they are given a numbered name, which is the point of being on a board.
  check(voter.user_metadata.display_name === 'bloom1',
        'and they are numbered, not left as one of many "a bloom"s',
        String(voter.user_metadata.display_name));
  check(stored[0].display_name === 'bloom1', 'with that name on the row itself');
  delete globalThis.__sbStub;
}

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
