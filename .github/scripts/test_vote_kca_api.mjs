// What /api/vma-votes?award=kca actually reads and writes.
//
// Run: node .github/scripts/test_vote_kca_api.mjs
//
// Three awards share this one endpoint, each with its own table and its own two
// RPCs, and the failure that matters is not a crash — it is the KCA branch
// touching the BreakTudo or VMA tables, or the VMA branch answering a KCA
// request. Either one returns a perfectly plausible board under the wrong
// heading. So this drives the real handler and asserts WHICH table and WHICH
// rpc each request reaches, not just that it answered.
//
// The other thing pinned here is the arithmetic on the write. `cats` is a map
// for KCA (one submitted round carries up to one pick per category), and if the
// parts are allowed to exceed the total they explain, the board draws a
// breakdown bigger than the number it breaks down.
//
// Supabase is stubbed, so this needs no database and no network. The handler is
// loaded by stripping its one import and handing `createClient` in — node_modules
// is not installed in this repo, and a test that needed it would simply never be
// run.
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

// ── load the handler with Supabase handed in ────────────────────────────────
function loadHandler() {
  const src = readFileSync(root + 'api/vma-votes.js', 'utf8');
  const stripped = src
    .replace(/^import \{ createClient \} from '@supabase\/supabase-js';$/m, '// import stubbed by the test')
    .replace(/^export default async function handler/m, 'async function handler');
  if (stripped === src) throw new Error('the handler no longer looks the way this test rewrites it');
  return new Function('createClient', 'process', stripped + '\nreturn handler;');
}
const makeHandler = loadHandler();

// A Supabase stub that records every table and rpc it is asked for. Each query
// chain is thenable, so `await sb.from(t).select(c).eq(a, b)` resolves the same
// way the real client does.
function stub(fixtures) {
  const calls = { tables: [], rpcs: [], upserts: [], updates: [] };
  const chain = (table) => {
    const ops = [];
    const self = {
      select(c) { ops.push(['select', c]); return self; },
      eq(a, b) { ops.push(['eq', a, b]); return self; },
      gte(a, b) { ops.push(['gte', a, b]); return self; },
      limit(n) { ops.push(['limit', n]); return self; },
      maybeSingle() { ops.push(['maybeSingle']); return self; },
      upsert(row, opts) { calls.upserts.push({ table, row, opts }); ops.push(['upsert']); return self; },
      update(row) { calls.updates.push({ table, row }); ops.push(['update']); return self; },
      then(res, rej) {
        let out;
        try { out = fixtures.resolve(table, ops); } catch (e) { return rej ? rej(e) : Promise.reject(e); }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return self;
  };
  const sb = {
    from(table) { calls.tables.push(table); return chain(table); },
    rpc(name, args) { calls.rpcs.push({ name, args }); return Promise.resolve({ data: (fixtures.rpc || {})[name] ?? null, error: null }); },
    auth: {
      getUser: async (token) => (fixtures.users || {})[token]
        ? { data: { user: (fixtures.users || {})[token] }, error: null }
        : { data: {}, error: new Error('bad token') },
      admin: { getUserById: async () => ({ data: { user: { user_metadata: { display_name: 'ext-blink' } } } }) },
    },
  };
  return { sb, calls };
}

function run(fixtures, req) {
  const { sb, calls } = stub(fixtures);
  const handler = makeHandler(() => sb, { env: { SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' } });
  let status = 0, body = null;
  const res = {
    setHeader() {}, status(s) { status = s; return res; },
    json(b) { body = b; return res; }, end() { return res; },
  };
  return handler(Object.assign({ method: 'GET', query: {}, headers: {} }, req), res)
    .then(() => ({ status, body, calls }));
}

// Rows the reads come back with. Only kca_user_votes is populated — if the
// handler reaches for a BreakTudo or VMA table, the fixture throws and the test
// says which table it was.
const KCA_ROWS = [
  { day: '2026-10-09', votes: 5, cats: { 'favorite-music-group-or-duo': 3, 'favorite-female-artist': 2 } },
  { day: '2026-10-08', votes: 2, cats: { 'favorite-music-collaboration': 2 } },
];
const base = {
  users: { 'good-token': { id: 'uid-1', user_metadata: { display_name: 'alpha' } } },
  rpc: {
    kca_vote_totals: { total: 7, today: 5, blinksTotal: 2, blinksToday: 1 },
    kca_vote_board: { ranked: [{ name: 'alpha', total: 7 }], unranked: [] },
  },
  resolve(table, ops) {
    if (table !== 'kca_user_votes' && table !== 'scrobble_tokens'
        && table !== 'linked_accounts' && table !== 'user_daily_counts')
      throw new Error(`the kca branch reached for ${table}`);
    if (table === 'scrobble_tokens') return { data: { app_user_id: 'uid-ext' } };
    if (table === 'linked_accounts') return { data: [{ app_user_id: 'uid-1' }] };
    if (table === 'user_daily_counts') return { data: [] };
    const single = ops.some(o => o[0] === 'maybeSingle');
    if (ops.some(o => o[0] === 'upsert') || ops.some(o => o[0] === 'update')) return { error: null };
    if (single) return { data: { votes: 5, cats: { 'favorite-music-group-or-duo': 3 }, ext_at: null } };
    return { data: KCA_ROWS };
  },
};

console.log('--- each award reaches its OWN table and its OWN rpc');
{
  const r = await run(base, { query: { award: 'kca', board: '1' } });
  check(r.status === 200, `board answers 200 (${r.status})`);
  check(r.calls.rpcs.length === 1 && r.calls.rpcs[0].name === 'kca_vote_board',
        `via kca_vote_board (${r.calls.rpcs.map(x => x.name).join(', ') || 'none'})`);
  check(JSON.stringify(r.body.board) === JSON.stringify(base.rpc.kca_vote_board),
        'and hands back what the rpc returned, ranked/unranked intact');
  check(!r.calls.rpcs.some(x => /breaktudo|vma_/.test(x.name)), 'no other award\'s rpc was called');

  const t = await run(base, { query: { award: 'kca' } });
  check(t.calls.rpcs[0] && t.calls.rpcs[0].name === 'kca_vote_totals',
        `the bare endpoint is this award's community total (${t.calls.rpcs[0] && t.calls.rpcs[0].name})`);
  check(t.body && t.body.total === 7, `with its numbers (${t.body && t.body.total})`);

  // The VMA path is the default and must be untouched by any of this.
  const v = await run({ ...base, rpc: { vma_vote_totals: { total: 99 } },
    resolve: () => ({ data: [] }) }, { query: {} });
  check(v.calls.rpcs[0] && v.calls.rpcs[0].name === 'vma_vote_totals',
        `no ?award= still means the VMAs (${v.calls.rpcs[0] && v.calls.rpcs[0].name})`);
}

console.log('\n--- ?me=1 reads my rows out of kca_user_votes');
{
  const r = await run(base, { query: { award: 'kca', me: '1' }, headers: { authorization: 'Bearer good-token' } });
  check(r.status === 200, `answers 200 (${r.status})`);
  check(r.calls.tables.includes('kca_user_votes'), `from kca_user_votes (${[...new Set(r.calls.tables)].join(', ')})`);
  check(r.body.total === 7, `all-time is every row (${r.body.total})`);
  check(r.body.cats['favorite-music-group-or-duo'] === 3 && r.body.cats['favorite-music-collaboration'] === 2,
        `with the per-category rollup (${JSON.stringify(r.body.cats)})`);
  check(r.body.linked === true, 'and whether a scrobbler is linked');
  check(r.body.daysFrom === '2026-10-08', `the day history starts at the voting period (${r.body.daysFrom})`);
  check(typeof r.body.extToday === 'boolean', 'extToday is reported, so the page can hide the manual form');

  const no = await run(base, { query: { award: 'kca', me: '1' } });
  check(no.status === 401, `no bearer is refused (${no.status})`);
}

console.log('\n--- the write: a round with several categories in it');
{
  const r = await run(base, { method: 'POST', body: {
    award: 'kca', accessToken: 'good-token', votes: 3,
    cats: { 'favorite-music-group-or-duo': 2, 'favorite-music-collaboration': 1 },
  } });
  check(r.status === 200, `accepted (${r.status})`);
  const up = r.calls.upserts[0];
  check(!!up && up.table === 'kca_user_votes', `written to kca_user_votes (${up && up.table})`);
  check(up && up.opts && up.opts.onConflict === 'app_user_id,day', 'keyed on (blink, day)');
  // The existing row had 5 votes and 3 in the group category, so the write is
  // additive on both the total and each category.
  check(up && up.row.votes === 8, `the total is added to the day's existing one (${up && up.row.votes})`);
  check(up && up.row.cats['favorite-music-group-or-duo'] === 5,
        `and each category is merged, not replaced (${up && JSON.stringify(up.row.cats)})`);
  check(up && up.row.cats['favorite-music-collaboration'] === 1, 'a new category is added');
  check(up && up.row.display_name === 'alpha', 'with the blink\'s display name');
  check(up && !('ext_at' in up.row), 'and no ext_at — this one was typed in by hand');
  // The day must be a KST calendar date, the same bucket the two RPCs use.
  const kst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  check(up && up.row.day === kst, `stamped with today in KST (${up && up.row.day} vs ${kst})`);
}

console.log('\n--- the counter\'s write is marked as the counter\'s');
{
  const r = await run(base, { method: 'POST', body: {
    award: 'kca', extToken: 'ext-tok', votes: 1, cats: { 'favorite-female-artist': 1 },
  } });
  check(r.status === 200, `a link token is accepted (${r.status})`);
  const up = r.calls.upserts[0];
  check(up && typeof up.row.ext_at === 'string', 'ext_at is set in the same upsert');
  check(r.calls.updates.length === 0, 'with no second write to set it');
  check(up && up.row.display_name === 'ext-blink', 'and the account\'s real display name is looked up');
}

console.log('\n--- the breakdown can never exceed the total it explains');
{
  const r = await run(base, { method: 'POST', body: {
    award: 'kca', accessToken: 'good-token', votes: 2,
    // Three categories claimed against a total of two — scaled down, not stored.
    cats: { 'favorite-music-group-or-duo': 3, 'favorite-female-artist': 3, 'favorite-music-collaboration': 3 },
  } });
  const up = r.calls.upserts[0];
  // The row already held 5 votes / 3 in the group category, so compare the
  // ADDED amounts against the added total.
  const addedTotal = up.row.votes - 5;
  const added = Object.entries(up.row.cats)
    .reduce((n, [k, v]) => n + v - (k === 'favorite-music-group-or-duo' ? 3 : 0), 0);
  check(addedTotal === 2, `the total is what was claimed (${addedTotal})`);
  check(added === 2, `and the parts were scaled to match it (${added}, from ${JSON.stringify(up.row.cats)})`);
}

console.log('\n--- what the write refuses, and what it lets through');
{
  const none = await run(base, { method: 'POST', body: { award: 'kca', votes: 2 } });
  check(none.status === 401, `no token at all is refused (${none.status})`);
  const bad = await run(base, { method: 'POST', body: { award: 'kca', accessToken: 'nope', votes: 2 } });
  check(bad.status === 401, `a bad token is refused (${bad.status})`);
  const zero = await run(base, { method: 'POST', body: { award: 'kca', accessToken: 'good-token', votes: 0 } });
  check(zero.status === 400, `zero votes is a bad request (${zero.status})`);
  check(zero.calls.upserts.length === 0, 'and nothing is written');

  // Fails OPEN on an unfamiliar slug: Nickelodeon runs extra Bonus and Live
  // categories during the show, and a whitelist here would silently drop their
  // attribution. Malformed keys are still dropped.
  const odd = await run(base, { method: 'POST', body: {
    award: 'kca', accessToken: 'good-token', votes: 3,
    cats: { 'favorite-bonus-round': 1, 'Favorite Shouty Slug': 1, 'favorite-live-vote': 1 },
  } });
  const up = odd.calls.upserts[0];
  check(up && up.row.cats['favorite-bonus-round'] === 1, 'an unknown but well-formed slug is kept');
  check(up && up.row.cats['favorite-live-vote'] === 1, 'and so is a second one');
  check(up && !('Favorite Shouty Slug' in up.row.cats), 'a malformed key is dropped');
  check(up && up.row.votes === 8, 'while the vote still counts towards the total');

  // A single `category` is the one-category shortcut the other awards use.
  const one = await run(base, { method: 'POST', body: {
    award: 'kca', accessToken: 'good-token', votes: 2, category: 'favorite-female-artist',
  } });
  const up1 = one.calls.upserts[0];
  check(up1 && up1.row.cats['favorite-female-artist'] === 2,
        `a single \`category\` attributes the whole lot (${up1 && JSON.stringify(up1.row.cats)})`);
}

console.log('\n--- the live pulse and the extension\'s own view');
{
  const live = await run(base, { query: { award: 'kca', live: '1' } });
  check(live.status === 200 && typeof live.body.liveVoters === 'number',
        `?live=1 answers with a count (${JSON.stringify(live.body)})`);
  check(live.calls.tables.includes('kca_user_votes'), 'off this award\'s table');

  const sync = await run(base, { query: { award: 'kca', sync: '1' }, headers: { 'x-ext-token': 'ext-tok' } });
  check(sync.status === 200, `?sync=1 answers for a linked counter (${sync.status})`);
  check(sync.body && typeof sync.body.total === 'number', `with today's total (${sync.body && sync.body.total})`);
  check(sync.body && sync.body.cats && typeof sync.body.cats === 'object',
        'and the per-category tally, so the panel can show it merged across devices');
  const nosync = await run(base, { query: { award: 'kca', sync: '1' } });
  check(nosync.status === 401, `and refuses an unlinked one (${nosync.status})`);
}

console.log(`\nFAILURES: ${fails.length}`);
fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
