// The anonymous name a new account is given follows the fandom it says it is.
//
// Run: node .github/scripts/test_fandom_names.mjs
//
// A vote trade brings other fandoms to this sign-up form, and "blink41" is the
// wrong name for a BLOOM in the one place it is most visible — the collab board,
// which exists to show each fandom turning up. The naming itself is Postgres
// (supabase/fan_display_names.sql, tested for real against a server by
// supabase/tests/fan_display_names_test.sql); what is tested here is the half
// that decides WHAT TO ASK IT and what to do with the answer:
//
//   · the question is asked before signing in, and survives the OAuth round
//     trip through another origin — so it lives in localStorage, not a variable;
//   · a brand-new signup is named with that answer, and flagged auto so a later
//     answer may rename it;
//   · an answer given later goes through reissue_fan_name, which returns null
//     for a name somebody CHOSE — and null must mean "leave them alone", not
//     "rename them anyway";
//   · every auto namespace is reserved against a manual pick, because two
//     people on one "bloom12" collide on one leaderboard key and one row
//     silently overwrites the other;
//   · and if the migration has not been applied yet, a signup is still named.
//
// Supabase is stubbed, so every RPC and metadata write is recorded rather than
// sent. The stub answers like the real functions do, including the nulls.
import { readFileSync } from 'node:fs';
import { chromium } from './_playwright.mjs';

const root = new URL('../../', import.meta.url).pathname;
const INDEX = root + 'index.html';
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const b = await chromium.launch();

// One page per scenario: the auto-name path runs once per session by design
// (_assigningBlink), and localStorage carries the answer across a reload.
async function openPage(opts = {}) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));

  // The stub stands in for supabase-js before any page script runs. `window.__sbLog`
  // is what the assertions read: every rpc, every updateUser, in order.
  await p.addInitScript(({ user, rpc }) => {
    window.__sbLog = [];
    const session = user ? { user, access_token: 'tok' } : null;
    window.__session = session;
    window.supabase = {
      createClient() {
        return {
          auth: {
            getSession: async () => ({ data: { session: window.__session } }),
            getUser: async () => ({ data: { user: window.__session?.user || null } }),
            onAuthStateChange(cb) { window.__fireAuth = (s) => cb('SIGNED_IN', s); return { data: { subscription: { unsubscribe() {} } } }; },
            async updateUser({ data }) {
              window.__sbLog.push({ kind: 'updateUser', data });
              if (window.__session) {
                window.__session.user.user_metadata =
                  Object.assign({}, window.__session.user.user_metadata, data);
              }
              return { error: null };
            },
            signInWithOAuth: async () => ({}),
            signInWithOtp: async () => ({}),
            signOut: async () => ({}),
          },
          async rpc(fn, args) {
            window.__sbLog.push({ kind: 'rpc', fn, args });
            const r = rpc[fn];
            if (r === undefined) return { data: null, error: { message: `function ${fn} does not exist` } };
            return { data: typeof r === 'string' ? r : r, error: null };
          },
          from() {
            const q = {};
            for (const m of ['select', 'eq', 'is', 'order', 'limit', 'delete', 'update', 'insert', 'upsert'])
              q[m] = () => q;
            q.maybeSingle = async () => ({ data: null });
            q.then = (res) => Promise.resolve({ data: [], error: null }).then(res);
            return q;
          },
        };
      },
    };
  }, { user: opts.user || null, rpc: opts.rpc || {} });

  const posts = [];
  await p.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/badges' || u.pathname === '/')
      return route.fulfill({ path: INDEX, contentType: 'text/html' });
    if (u.hostname.includes('fonts.g')) return route.continue();
    if (u.pathname.startsWith('/api/')) {
      if (req.method() === 'POST') {
        let body = {};
        try { body = JSON.parse(req.postData() || '{}'); } catch {}
        posts.push({ path: u.pathname + '?' + u.searchParams.toString(), body });
      }
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 204, body: '' });
  });

  await p.goto('https://www.blinksunited.com/badges', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => {
    try { closeTutorial(); } catch {}
    document.getElementById('tutorial-overlay')?.remove();
    document.getElementById('ext-update-overlay')?.remove();
    document.getElementById('ltal-reminder-overlay')?.remove();
  });
  return { p, ctx, errs, posts };
}

const sbLog = (p) => p.evaluate(() => window.__sbLog);

// Signed in, the sign-in card is hidden and the picker a person actually meets
// is the one in Settings → Account. Open it the way the site does, then make
// sure its ancestors are on screen so the click is a real click rather than a
// dispatched event.
async function openSettings(p) {
  await p.evaluate(() => {
    renderAccountPage(window.__session);
    document.getElementById('page-badges')?.classList.add('active');
    for (const id of ['settings-panel', 'settings-account-section', 'profile-panel']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'block';
    }
    document.getElementById('login-panel')?.style.setProperty('display', 'block');
  });
  await p.waitForTimeout(250);
}

console.log('--- the question is asked before signing in');
{
  const { p, ctx, errs } = await openPage();
  const chips = await p.$$eval('#fandom-picker-login .fandom-chip',
    (els) => els.map((e) => ({ key: e.getAttribute('data-fandom'), on: e.classList.contains('on'), label: e.textContent })));
  check(chips.length >= 3, 'the sign-in card offers every side', chips.map((c) => c.key).join(', '));
  check(chips.some((c) => c.key === 'bloom') && chips.some((c) => c.key === 'pauljjak'),
        'including the ones that are not us');
  check(chips.every((c) => !c.on), 'and none is preselected — nobody is assumed to be anything');
  // It is NOT a sign-in requirement: a blink who ignores it must still be able
  // to sign in, and ignoring it means blink.
  const stored = await p.evaluate(() => localStorage.getItem('buFandom'));
  check(stored === null, 'nothing is stored until they answer', String(stored));

  await p.click('#fandom-picker-login [data-fandom="bloom"]');
  await p.waitForTimeout(100);
  const after = await p.$$eval('#fandom-picker-login .fandom-chip',
    (els) => els.filter((e) => e.classList.contains('on')).map((e) => e.getAttribute('data-fandom')));
  check(after.length === 1 && after[0] === 'bloom', 'clicking a side marks it, and only it', after.join(', '));
  const kept = await p.evaluate(() => localStorage.getItem('buFandom'));
  check(kept === 'bloom', 'and it is kept where an OAuth redirect cannot lose it', String(kept));
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}

console.log('\n--- a brand-new signup is named for that answer');
{
  // The realistic sequence: answer the question, get sent to Google, come back
  // as a seconds-old account with no display name.
  const fresh = {
    id: 'u1', created_at: new Date().toISOString(), email: 'a@b.c', user_metadata: {},
  };
  const { p, ctx, errs, posts } = await openPage({ user: fresh, rpc: { assign_fan_name: 'bloom7' } });
  await p.evaluate(() => { localStorage.setItem('buFandom', 'bloom'); });
  // The auth event is what the site reacts to; fire it as the redirect would.
  await p.evaluate(() => window.__fireAuth(window.__session));
  await p.waitForTimeout(600);

  const log = await sbLog(p);
  const call = log.find((e) => e.kind === 'rpc' && e.fn === 'assign_fan_name');
  check(!!call, 'the name is asked for by fandom, not by "blink"');
  check(call && call.args && call.args.p_fandom === 'bloom',
        'and the answer they gave is what is asked with', call ? JSON.stringify(call.args) : '');
  const wrote = log.find((e) => e.kind === 'updateUser' && e.data && e.data.display_name);
  check(wrote && wrote.data.display_name === 'bloom7', 'the minted name is saved',
        wrote ? wrote.data.display_name : 'nothing saved');
  // Without this flag a later answer could only guess from the name's shape,
  // and "bloom12" is a plausible thing for a person to have chosen.
  check(wrote && wrote.data.display_name_auto === true,
        'flagged as auto, which is what makes a later rename safe');
  check(wrote && wrote.data.fandom === 'bloom',
        'and the fandom is recorded on the account, so the server knows it too');
  const push = posts.find((x) => x.path.includes('set-display-name'));
  check(!!push && push.body.displayName === 'bloom7',
        'the board is told at once rather than at the next cron', push ? push.body.displayName : 'no push');
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}

console.log('\n--- a signup still gets a name if the migration is not applied');
{
  // fan_display_names.sql is applied by hand in the Supabase SQL editor, so the
  // code ships before the function exists. Nameless signups would be the worst
  // possible way to find that out.
  const fresh = { id: 'u2', created_at: new Date().toISOString(), email: 'a@b.c', user_metadata: {} };
  const { p, ctx, errs } = await openPage({ user: fresh, rpc: { assign_blink_name: 'blink99' } });
  await p.evaluate(() => { localStorage.setItem('buFandom', 'bloom'); });
  await p.evaluate(() => window.__fireAuth(window.__session));
  await p.waitForTimeout(600);
  const log = await sbLog(p);
  check(log.some((e) => e.fn === 'assign_fan_name'), 'it tries the fandom-aware function first');
  check(log.some((e) => e.fn === 'assign_blink_name'), 'and falls back to the one that exists');
  const wrote = log.find((e) => e.kind === 'updateUser' && e.data && e.data.display_name);
  check(wrote && wrote.data.display_name === 'blink99',
        'so they are named, just as a blink until the SQL is applied',
        wrote ? wrote.data.display_name : 'NOT NAMED AT ALL');
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}

console.log('\n--- answering later renames an auto name');
{
  // The usual case, because the fandom question is also in the counter and the
  // counter is installed after signing up.
  const old = {
    id: 'u3', created_at: '2026-01-04T00:00:00Z', email: 'a@b.c',
    user_metadata: { display_name: 'blink40', display_name_auto: true },
  };
  const { p, ctx, errs, posts } = await openPage({ user: old, rpc: { reissue_fan_name: 'bloom8' } });
  await openSettings(p);
  await p.click('#fandom-picker-settings [data-fandom="bloom"]');
  await p.waitForTimeout(500);
  const log = await sbLog(p);
  const call = log.find((e) => e.fn === 'reissue_fan_name');
  check(!!call && call.args.p_fandom === 'bloom', 'the rename is asked for with the new answer');
  check(!log.some((e) => e.fn === 'assign_fan_name'),
        'and not through the signup path, which would refuse an old account anyway');
  const wrote = log.find((e) => e.kind === 'updateUser' && e.data && e.data.display_name);
  check(wrote && wrote.data.display_name === 'bloom8', 'the new name is saved',
        wrote ? wrote.data.display_name : 'nothing saved');
  check(log.some((e) => e.kind === 'updateUser' && e.data && e.data.fandom === 'bloom'),
        'and so is the answer itself');
  check(posts.some((x) => x.path.includes('set-display-name') && x.body.displayName === 'bloom8'),
        'the board follows the rename');
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}

console.log('\n--- a name somebody chose is never taken from them');
{
  // reissue_fan_name returns null for a chosen name. null must mean "leave them
  // alone" — the one unforgivable version of this feature is renaming somebody
  // who picked their own name.
  const chosen = {
    id: 'u4', created_at: '2026-01-04T00:00:00Z', email: 'a@b.c',
    user_metadata: { display_name: 'ROSÉ4ever' },
  };
  const { p, ctx, errs, posts } = await openPage({ user: chosen, rpc: { reissue_fan_name: null } });
  await openSettings(p);
  await p.click('#fandom-picker-settings [data-fandom="bloom"]');
  await p.waitForTimeout(500);
  const log = await sbLog(p);
  check(log.some((e) => e.fn === 'reissue_fan_name'), 'the database is still asked');
  const renamed = log.filter((e) => e.kind === 'updateUser' && e.data && e.data.display_name);
  check(renamed.length === 0, 'and its "no" is obeyed — the name is untouched',
        renamed.map((r) => r.data.display_name).join(', '));
  check(!posts.some((x) => x.path.includes('set-display-name')),
        'nothing is pushed to the board either');
  check(log.some((e) => e.kind === 'updateUser' && e.data && e.data.fandom === 'bloom'),
        'but they are still counted as a BLOOM — the answer is recorded regardless');
  const still = await p.evaluate(() => window.__session.user.user_metadata.display_name);
  check(still === 'ROSÉ4ever', 'they are who they said they were', still);
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}

console.log('\n--- the account outranks this browser');
{
  // Answered on their phone, or in the counter. Opening Settings here must show
  // the question answered, not blank — and must not re-ask or re-mint.
  const user = {
    id: 'u5', created_at: '2026-01-04T00:00:00Z', email: 'a@b.c',
    user_metadata: { display_name: 'pauljjak3', display_name_auto: true, fandom: 'pauljjak' },
  };
  const { p, ctx, errs } = await openPage({ user, rpc: { reissue_fan_name: 'pauljjak3' } });
  await openSettings(p);
  const on = await p.$$eval('#fandom-picker-settings .fandom-chip',
    (els) => els.filter((e) => e.classList.contains('on')).map((e) => e.getAttribute('data-fandom')));
  check(on.length === 1 && on[0] === 'pauljjak', 'Settings shows the side the account holds', on.join(', '));
  const stored = await p.evaluate(() => localStorage.getItem('buFandom'));
  check(stored === 'pauljjak', 'and this browser is brought in line with it', String(stored));
  const log = await sbLog(p);
  const renamed = log.filter((e) => e.kind === 'updateUser' && e.data && e.data.display_name);
  check(renamed.length === 0, 'a name that already matches is not re-minted',
        renamed.map((r) => r.data.display_name).join(', '));
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}

console.log('\n--- every auto namespace is reserved against a manual pick');
{
  const user = {
    id: 'u6', created_at: '2026-01-04T00:00:00Z', email: 'a@b.c',
    user_metadata: { display_name: 'blink40', display_name_auto: true },
  };
  const { p, ctx, errs } = await openPage({ user, rpc: {} });
  // Every side's namespace, read off the page's own list rather than typed here,
  // so a fandom joining a trade is covered by this check automatically.
  const keys = await p.evaluate(() => FANDOMS.map((f) => f.key));
  check(keys.length >= 3, 'the site knows every side', keys.join(', '));
  for (const k of keys) {
    const refused = await p.evaluate(async (name) => {
      document.getElementById('linked-displayname-input-settings').value = name;
      await saveDisplayName();
      return {
        said: document.getElementById('settings-displayname-status').textContent,
        saved: window.__sbLog.some((e) => e.kind === 'updateUser' && e.data && e.data.display_name === name),
      };
    }, k + '12');
    check(/reserved/i.test(refused.said) && !refused.saved, `${k}12 cannot be taken by hand`,
          refused.said || 'no message');
  }
  // And an ordinary name still goes through, or the check above is just a
  // broken save button.
  const ok = await p.evaluate(async () => {
    document.getElementById('linked-displayname-input-settings').value = 'bloomer';
    await saveDisplayName();
    return window.__sbLog.some((e) => e.kind === 'updateUser' && e.data && e.data.display_name === 'bloomer');
  });
  check(ok, 'while a name that merely starts like one is allowed (bloomer)');
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}

console.log('\n--- /vote-link: the sign-up a partner fandom actually does');
// The counter sends people HERE, not to /badges. Before this page did any
// naming, somebody signing up through it got no anonymous name at all — so
// /api/extension-link labelled their token with their OAuth real name or email,
// which is the exact thing blinkN exists to avoid, and their row on the collab
// board had no name on it. The label is stored once and reused for ever, which
// is why the order of the two calls below is the whole point.
async function openLinkPage(opts = {}) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript(({ user, rpc, fandom }) => {
    window.__sbLog = [];
    if (fandom) { try { localStorage.setItem('buFandom', fandom); } catch {} }
    window.__session = user ? { user, access_token: 'tok' } : null;
    // Wrapped so the ORDER of the naming and the token mint is visible in one
    // log: a name written after the mint is a name the token never sees.
    const realFetch = window.fetch.bind(window);
    window.fetch = (u, init) => {
      window.__sbLog.push({ kind: 'fetch', url: String(u) });
      return realFetch(u, init);
    };
    window.supabase = {
      createClient() {
        return {
          auth: {
            getSession: async () => ({ data: { session: window.__session } }),
            onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
            async updateUser({ data }) {
              window.__sbLog.push({ kind: 'updateUser', data });
              if (window.__session) {
                window.__session.user.user_metadata =
                  Object.assign({}, window.__session.user.user_metadata, data);
              }
              return { error: null };
            },
            signInWithOAuth: async () => ({}),
            signInWithOtp: async () => ({}),
          },
          async rpc(fn, args) {
            window.__sbLog.push({ kind: 'rpc', fn, args });
            const r = rpc[fn];
            if (r === undefined) return { data: null, error: { message: `function ${fn} does not exist` } };
            return { data: r, error: null };
          },
        };
      },
    };
  }, { user: opts.user || null, rpc: opts.rpc || {}, fandom: opts.fandom || null });

  await p.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/vote-link')
      return route.fulfill({ path: root + 'vote-link.html', contentType: 'text/html' });
    if (u.pathname === '/api/extension-link')
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, token: 'x', profile: 'bloom7' }) });
    return route.fulfill({ status: 204, body: '' });
  });
  await p.goto('https://www.blinksunited.com/vote-link', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);
  return { p, ctx, errs };
}

{
  const { p, ctx, errs } = await openLinkPage();
  const chips = await p.$$eval('#fandoms button',
    (els) => els.map((e) => e.getAttribute('data-f')));
  check(chips.length >= 3, 'the link page asks which fandom they are', chips.join(', '));
  await p.click('#fandoms [data-f="bloom"]');
  const kept = await p.evaluate(() => localStorage.getItem('buFandom'));
  check(kept === 'bloom', 'and the answer survives the OAuth redirect this page does', String(kept));
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}
{
  const fresh = { id: 'v1', created_at: new Date().toISOString(), email: 'a@b.c', user_metadata: {} };
  const { p, ctx, errs } = await openLinkPage({ user: fresh, fandom: 'bloom', rpc: { assign_fan_name: 'bloom7', reissue_fan_name: 'bloom7' } });
  const log = await sbLog(p);
  const call = log.find((e) => e.fn === 'assign_fan_name');
  check(!!call && call.args.p_fandom === 'bloom', 'a signup here is named for their fandom too',
        call ? JSON.stringify(call.args) : 'never asked');
  const named = log.findIndex((e) => e.kind === 'updateUser' && e.data && e.data.display_name === 'bloom7');
  const minted = log.findIndex((e) => e.kind === 'fetch' && e.url.includes('/api/extension-link'));
  check(named >= 0, 'the name is written');
  check(minted >= 0, 'and the token is still minted — naming cannot break linking');
  check(named >= 0 && minted >= 0 && named < minted,
        'in that order, so the token carries the anonymous name and not their email',
        `named at ${named}, minted at ${minted}`);
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}
{
  // An established fan linking the counter must not be renamed or newly named.
  const old = {
    id: 'v2', created_at: '2026-01-04T00:00:00Z', email: 'a@b.c',
    user_metadata: { display_name: 'ROSÉ4ever' },
  };
  const { p, ctx, errs } = await openLinkPage({ user: old, fandom: 'bloom', rpc: { reissue_fan_name: null } });
  const log = await sbLog(p);
  check(!log.some((e) => e.fn === 'assign_fan_name'), 'an existing account is not run through the signup path');
  check(!log.some((e) => e.kind === 'updateUser' && e.data && e.data.display_name),
        'and a name they chose is left exactly as it is');
  // Asserted on the RESULT, not just on "no write with a name in it": a write
  // of display_name: null passes that and blanks their name, which is how a
  // refused rename would actually go wrong.
  const still = await p.evaluate(() => window.__session.user.user_metadata.display_name);
  check(still === 'ROSÉ4ever', 'they are still called what they call themselves', String(still));
  check(log.some((e) => e.kind === 'fetch' && e.url.includes('/api/extension-link')),
        'their counter still links');
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}
{
  // The case the signup window exists for: an established fan who never chose a
  // display name. They keep showing their handle — becoming "bloom12" years
  // later, because they linked a counter, is not a thing that should happen.
  const old = { id: 'v3', created_at: '2026-01-04T00:00:00Z', email: 'a@b.c', user_metadata: {} };
  const { p, ctx, errs } = await openLinkPage({ user: old, fandom: 'bloom', rpc: { assign_fan_name: 'bloom7' } });
  const log = await sbLog(p);
  check(!log.some((e) => e.kind === 'updateUser' && e.data && e.data.display_name),
        'an established fan with no display name is not auto-named',
        JSON.stringify(log.filter((e) => e.kind === 'updateUser')));
  const dn = await p.evaluate(() => window.__session.user.user_metadata.display_name);
  check(dn === undefined, 'they still have none, which is what keeps showing their handle', String(dn));
  check(log.some((e) => e.kind === 'fetch' && e.url.includes('/api/extension-link')),
        'and their counter links regardless');
  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  await ctx.close();
}

await b.close();
console.log(`\nFAILURES: ${fails.length}`);
fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
