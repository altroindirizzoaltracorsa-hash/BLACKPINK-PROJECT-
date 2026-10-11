// Can we answer the people who write in — and only them?
//
// Run: node .github/scripts/test_feedback_reply.mjs
//
// The feedback form has always said "for a reply" and had no reply path at all.
// Adding one puts other people's words, contact details and claim codes behind
// an API, so the things worth pinning are mostly about who can see what:
//
//   * the sender's own view must return THEIR rows and nothing else, and must
//     not hand back the fields that identify them to us (contact, ticket,
//     app_user_id) — a leak there is invisible, because the page would look
//     exactly the same;
//   * a claim code is the whole credential for an anonymous thread, so a
//     malformed or unknown one has to be a flat 404 rather than anything that
//     narrows a guess;
//   * the queue and the write-a-reply action are admin-only, and "admin" means
//     the server checked the key, not that the page decided to render.
//
// And one piece of plain correctness: the channel the sender chose has to
// survive, because it is the only thing that says where an answer should go.
//
// Supabase is stubbed, so this needs no database and no network. The handler is
// loaded by stripping its one import — node_modules is not installed in this
// repo, and a test that needed it would simply never be run.
import { readFileSync } from 'node:fs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = new URL('../../', import.meta.url).pathname;
let fails = [];
const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

function loadHandler() {
  const src = readFileSync(root + 'api/feedback.js', 'utf8');
  const stripped = src
    .replace(/^import \{ createClient \} from '@supabase\/supabase-js';$/m, '// import stubbed by the test')
    .replace(/^export default async function handler/m, 'async function handler');
  if (stripped === src) throw new Error('the handler no longer looks the way this test rewrites it');
  return new Function('createClient', 'process', 'fetch', stripped + '\nreturn handler;');
}
const makeHandler = loadHandler();

// A tiny stand-in for the table: rows in an array, and the query chain recorded
// so a case can assert WHICH columns were asked for.
function stub(rows, users) {
  const calls = { selects: [], updates: [], inserts: [] };
  const chain = () => {
    const f = {}; const ops = { eq: {}, is: [], neq: [] };
    const self = {
      select(cols) { f.cols = cols; calls.selects.push(cols); return self; },
      insert(row) { calls.inserts.push(row); rows.push(Object.assign({ id: rows.length + 1, created_at: new Date().toISOString() }, row)); f.insert = true; return self; },
      update(patch) { f.update = patch; return self; },
      eq(c, v) { ops.eq[c] = v; return self; },
      is(c, v) { ops.is.push([c, v]); return self; },
      neq(c, v) { ops.neq.push([c, v]); return self; },
      order() { return self; },
      limit() { return self; },
      maybeSingle() { f.single = true; return self; },
      then(res, rej) {
        let out = rows.filter(r => Object.entries(ops.eq).every(([c, v]) => String(r[c]) === String(v)));
        for (const [c, v] of ops.is) out = out.filter(r => (r[c] ?? null) === v);
        for (const [c, v] of ops.neq) out = out.filter(r => r[c] !== v);
        if (f.update) {
          out.forEach(r => Object.assign(r, f.update));
          calls.updates.push({ patch: f.update, matched: out.length });
        }
        // Only the columns that were selected come back, the way PostgREST does
        // it — which is what makes the "never leaks contact" check meaningful.
        const cols = (f.cols || '').split(',').map(c => c.trim()).filter(Boolean);
        const project = (r) => cols.length ? Object.fromEntries(cols.map(c => [c, r[c] ?? null])) : r;
        const data = f.insert ? null : (f.single ? (out[0] ? project(out[0]) : null) : out.map(project));
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return self;
  };
  const sb = {
    from() { return chain(); },
    auth: {
      getUser: async (t) => users[t] ? { data: { user: users[t] }, error: null } : { data: {}, error: new Error('bad') },
    },
  };
  return { sb, calls };
}

function run(rows, users, req, env = {}) {
  const { sb, calls } = stub(rows, users);
  const handler = makeHandler(
    () => sb,
    { env: Object.assign({ SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', ADMIN_SECRET: 'S3CRET' }, env) },
    async () => ({ ok: true }),   // the Discord webhook, never reached without the env var
  );
  let status = 0, body = null;
  const res = { setHeader() {}, status(s) { status = s; return res; }, json(b) { body = b; return res; }, end() { return res; } };
  return handler(Object.assign({ method: 'GET', query: {}, headers: {} }, req), res)
    .then(() => ({ status, body, calls, rows }));
}

const USERS = { 'tok-a': { id: 'user-a' }, 'tok-b': { id: 'user-b' } };
const seed = () => ([
  { id: 1, created_at: '2026-10-01T00:00:00Z', message: 'from user a', category: 'bug',
    contact: 'a@example.com', username: 'alfa', app_user_id: 'user-a', reply_via: 'site',
    ticket: null, reply: null, replied_at: null, reply_sent_at: null },
  { id: 2, created_at: '2026-10-02T00:00:00Z', message: 'from user b', category: 'feature',
    contact: null, username: null, app_user_id: 'user-b', reply_via: 'site',
    ticket: null, reply: 'already answered', replied_at: '2026-10-03T00:00:00Z', reply_sent_at: null },
  { id: 3, created_at: '2026-10-04T00:00:00Z', message: 'anonymous, wants it on the site', category: 'general',
    contact: null, username: null, app_user_id: null, reply_via: 'site',
    ticket: 'PQ3HRN6A', reply: null, replied_at: null, reply_sent_at: null },
  { id: 4, created_at: '2026-10-05T00:00:00Z', message: 'no reply wanted', category: 'praise',
    contact: null, username: null, app_user_id: null, reply_via: 'none',
    ticket: null, reply: null, replied_at: null, reply_sent_at: null },
]);

console.log('--- the channel the sender picked is what gets stored');
{
  const r = await run([], USERS, { method: 'POST', body: { message: 'hi', category: 'bug', replyVia: 'site' } });
  check(r.status === 201, `anonymous on-site feedback is accepted (${r.status})`);
  check(typeof r.body.ticket === 'string' && r.body.ticket.length === 8,
        `and comes back with a claim code (${r.body.ticket})`);
  check(!/[O0I1L]/.test(r.body.ticket), 'with no characters that get misread off a screen');
  check(r.calls.inserts[0].reply_via === 'site' && r.calls.inserts[0].ticket === r.body.ticket,
        'both stored on the row');

  const signed = await run([], USERS, { method: 'POST', body: { message: 'hi', replyVia: 'site', accessToken: 'tok-a' } });
  check(signed.calls.inserts[0].app_user_id === 'user-a', 'a signed-in sender is attached to their account');
  check(!signed.body.ticket && !signed.calls.inserts[0].ticket,
        'and gets no code, because their account IS the way back');

  const email = await run([], USERS, { method: 'POST', body: { message: 'hi', replyVia: 'email', contact: 'x@y.z' } });
  check(email.calls.inserts[0].reply_via === 'email' && !email.body.ticket,
        'an email reply stores the channel and issues no code');

  // A channel we don't know is not a channel. Recorded as "never asked" rather
  // than quietly becoming one of the real ones.
  const junk = await run([], USERS, { method: 'POST', body: { message: 'hi', replyVia: 'carrier-pigeon' } });
  check(!('reply_via' in junk.calls.inserts[0]), 'an unknown channel is not stored at all');
  check(junk.status === 201, 'but the feedback itself still goes through');

  const bad = await run([], USERS, { method: 'POST', body: { message: '   ' } });
  check(bad.status === 400, `an empty message is refused (${bad.status})`);

  // A bad token must not cost someone their feedback — it has never needed an
  // account and must not start failing without one.
  const badTok = await run([], USERS, { method: 'POST', body: { message: 'hi', accessToken: 'nope' } });
  check(badTok.status === 201 && !badTok.calls.inserts[0].app_user_id,
        'an expired token just means the row is anonymous, not an error');
}

console.log('\n--- the sender sees their own messages, and only those');
{
  const mine = await run(seed(), USERS, { query: { mine: '1' }, headers: { authorization: 'Bearer tok-a' } });
  check(mine.status === 200, `?mine=1 answers for a signed-in blink (${mine.status})`);
  check(mine.body.messages.length === 1 && mine.body.messages[0].message === 'from user a',
        `with their row only (${mine.body.messages.length})`);
  // The leak that would look completely normal on the page.
  const cols = Object.keys(mine.body.messages[0]);
  check(!cols.includes('contact') && !cols.includes('ticket') && !cols.includes('app_user_id'),
        `and none of the fields that identify them to us (${cols.join(', ')})`);
  check(cols.includes('reply') && cols.includes('replied_at'), 'but the reply is there');

  const other = await run(seed(), USERS, { query: { mine: '1' }, headers: { authorization: 'Bearer tok-b' } });
  check(other.body.messages.length === 1 && other.body.messages[0].message === 'from user b',
        'another account sees a different row');
  const anon = await run(seed(), USERS, { query: { mine: '1' } });
  check(anon.status === 401, `no bearer is refused (${anon.status})`);
  const badTok = await run(seed(), USERS, { query: { mine: '1' }, headers: { authorization: 'Bearer nope' } });
  check(badTok.status === 401, `and so is a bad one (${badTok.status})`);
}

console.log('\n--- a claim code opens one thread and nothing else');
{
  const ok = await run(seed(), USERS, { query: { ticket: 'PQ3HRN6A' } });
  check(ok.status === 200 && ok.body.messages[0].message === 'anonymous, wants it on the site',
        'the right code returns the right message');
  const cols = Object.keys(ok.body.messages[0]);
  check(!cols.includes('contact') && !cols.includes('ticket'), 'without echoing the code or any contact back');

  const lower = await run(seed(), USERS, { query: { ticket: 'pq3hrn6a' } });
  check(lower.status === 200, 'case does not matter — nobody retypes a code exactly');

  const unknown = await run(seed(), USERS, { query: { ticket: 'ZZZZZZZZ' } });
  check(unknown.status === 404, `an unknown code is a flat 404 (${unknown.status})`);
  // Anything that is not a code shape never reaches the table: a short or
  // punctuated value is how someone probes for a pattern.
  const junk = await run(seed(), USERS, { query: { ticket: 'ab' } });
  check(junk.status === 404 && junk.calls.selects.length === 0,
        'and a malformed one is refused without even a query');
  const inject = await run(seed(), USERS, { query: { ticket: "' or 1=1--" } });
  check(inject.status === 404 && inject.calls.selects.length === 0, 'as is anything shaped like an injection');
}

console.log('\n--- the queue is admin-only');
{
  const no = await run(seed(), USERS, { query: { admin: '1' } });
  check(no.status === 401, `no key is refused (${no.status})`);
  const wrong = await run(seed(), USERS, { query: { admin: '1', key: 'guess' } });
  check(wrong.status === 401, `a wrong key is refused (${wrong.status})`);
  // If ADMIN_SECRET is unset, an absent key must not accidentally match it.
  const unset = await run(seed(), USERS, { query: { admin: '1' } }, { ADMIN_SECRET: '' });
  check(unset.status === 401, 'and an unset ADMIN_SECRET locks it rather than opening it');

  const all = await run(seed(), USERS, { query: { admin: '1', key: 'S3CRET' } });
  check(all.status === 200 && all.body.messages.length === 4, `the key gets the queue (${all.body.messages.length})`);
  check(Object.keys(all.body.messages[0]).includes('contact'),
        'with the contact details, which is the point of it');

  // "Needs a reply" is the actual work: unanswered, minus the people who said
  // they did not want one.
  const open = await run(seed(), USERS, { query: { admin: '1', key: 'S3CRET', open: '1' } });
  const ids = open.body.messages.map(m => m.id).sort();
  check(JSON.stringify(ids) === '[1,3]', `only the ones waiting on you (${ids.join(', ')})`);
  check(!open.body.messages.some(m => m.reply_via === 'none'), 'nobody who asked for no reply is in it');
  check(!open.body.messages.some(m => m.reply), 'and nothing already answered');
}

console.log('\n--- writing a reply');
{
  const rows = seed();
  const no = await run(rows, USERS, { method: 'POST', body: { action: 'reply', id: 1, reply: 'hello' } });
  check(no.status === 401, `without the key, nothing (${no.status})`);
  check(rows[0].reply === null, 'and the row is untouched');

  const r = await run(rows, USERS, { method: 'POST', body: { action: 'reply', id: 1, reply: '  thanks for this!  ', key: 'S3CRET' } });
  check(r.status === 200, `with the key it saves (${r.status})`);
  check(rows[0].reply === 'thanks for this!', `trimmed (${JSON.stringify(rows[0].reply)})`);
  check(!!rows[0].replied_at, 'and stamped');
  // replied_at says the text exists; reply_sent_at says it reached them. For an
  // email or handle those are different moments, and conflating them would mark
  // a reply delivered that is still sitting in a box.
  check(rows[0].reply_sent_at === null, 'but not marked as sent, which is a separate thing');

  const sent = await run(rows, USERS, { method: 'POST', body: { action: 'mark-sent', id: 1, key: 'S3CRET' } });
  check(sent.status === 200 && !!rows[0].reply_sent_at, 'marking it sent is its own step');

  const empty = await run(rows, USERS, { method: 'POST', body: { action: 'reply', id: 1, reply: '   ', key: 'S3CRET' } });
  check(empty.status === 400, `an empty reply is refused (${empty.status})`);
  const missing = await run(rows, USERS, { method: 'POST', body: { action: 'reply', id: 999, reply: 'x', key: 'S3CRET' } });
  check(missing.status === 404, `and a row that isn't there is a 404 (${missing.status})`);

  // The sender then actually sees it.
  const mine = await run(rows, USERS, { query: { mine: '1' }, headers: { authorization: 'Bearer tok-a' } });
  check(mine.body.messages[0].reply === 'thanks for this!', 'and the sender can now read it');
}

// ── the page ────────────────────────────────────────────────────────────────
console.log('\n--- the form asks for a contact only when it needs one');
{
  const INDEX = root + 'index.html';
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage({ viewport: { width: 412, height: 1200 } });
  const errs = [];
  const posts = [];
  p.on('pageerror', (e) => errs.push(String(e)));

  let queue = seed();
  await p.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === '/feedback' || u.pathname === '/') return route.fulfill({ path: INDEX, contentType: 'text/html' });
    if (u.hostname.includes('fonts.g')) return route.continue();
    if (u.pathname === '/api/feedback') {
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        posts.push(body);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ticket: 'PQ3HRN6A' }) });
      }
      if (u.searchParams.get('admin')) {
        if (u.searchParams.get('key') !== 'S3CRET') return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages: queue }) });
      }
      if (u.searchParams.get('ticket')) {
        const hit = queue.filter(m => m.ticket === u.searchParams.get('ticket'));
        if (!hit.length) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages: hit }) });
      }
      return route.fulfill({ contentType: 'application/json', body: '{"messages":[]}' });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 204, body: '' });
  });

  await p.goto('https://www.blinksunited.com/feedback', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2200);
  await p.evaluate(() => {
    try { closeTutorial(); } catch {}
    document.getElementById('tutorial-overlay')?.remove();
    document.getElementById('ext-update-overlay')?.remove();
    showPage('feedback');
  });
  await p.waitForTimeout(300);

  const contactShown = () => p.evaluate(() => document.getElementById('feedback-contact-wrap').style.display !== 'none');
  const pick = async (v) => { await p.selectOption('#feedback-replyvia', v); await p.waitForTimeout(80); };

  check(await contactShown() === false, 'the on-site default asks for no contact at all');
  await pick('email');
  check(await contactShown() === true, 'choosing email asks for an email');
  check((await p.inputValue('#feedback-contact')) === '', 'with an empty box');
  const label = await p.textContent('#feedback-contact-label');
  check(/EMAIL/i.test(label), `labelled for it (${label})`);
  await pick('handle');
  check(/HANDLE/i.test(await p.textContent('#feedback-contact-label')), 'a handle asks for a handle');
  await pick('none');
  check(await contactShown() === false, 'and "no reply needed" asks for nothing');

  // Asking to be answered somewhere and not saying where is the one combination
  // that cannot work.
  await pick('email');
  await p.fill('#feedback-message', 'please fix the thing');
  await p.evaluate(() => submitFeedback());
  await p.waitForTimeout(200);
  const err = await p.textContent('#feedback-error');
  check(/add your email/i.test(err), `it is caught before sending (${err})`);
  check(posts.length === 0, 'and nothing was posted');

  await p.fill('#feedback-contact', 'me@example.com');
  await p.evaluate(() => submitFeedback());
  await p.waitForTimeout(300);
  check(posts.length === 1 && posts[0].replyVia === 'email' && posts[0].contact === 'me@example.com',
        `then it goes, carrying the channel (${JSON.stringify(posts[0] || {})})`);

  console.log('\n--- an anonymous sender is shown their code properly');
  await p.evaluate(() => {
    document.getElementById('feedback-submit-btn').disabled = false;
    document.getElementById('feedback-message').value = 'anon message';
    document.getElementById('feedback-replyvia').value = 'site';
    updateFeedbackReplyVia();
  });
  await p.evaluate(() => submitFeedback());
  await p.waitForTimeout(300);
  const code = await p.textContent('#feedback-success .fb-ticket code').catch(() => null);
  check(code === 'PQ3HRN6A', `the code is rendered as a code, not buried in a sentence (${code})`);
  const codeSize = await p.evaluate(() => {
    const el = document.querySelector('#feedback-success .fb-ticket code');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  check(codeSize >= 15, `and big enough to read off a screen (${codeSize}px)`);

  console.log('\n--- checking a code shows the thread and the reply');
  queue = [{ id: 3, created_at: '2026-10-04T00:00:00Z', message: 'anonymous, wants it on the site',
             category: 'general', reply_via: 'site', ticket: 'PQ3HRN6A',
             reply: 'fixed it, thank you!', replied_at: '2026-10-06T00:00:00Z' }];
  await p.fill('#feedback-ticket-input', 'pq3hrn6a');
  await p.evaluate(() => lookupFeedbackTicket());
  await p.waitForTimeout(400);
  const mineCard = await p.evaluate(() => {
    const c = document.getElementById('feedback-mine-card');
    return { shown: c.style.display !== 'none', text: c.textContent.replace(/\s+/g, ' ').trim() };
  });
  check(mineCard.shown, '"Your messages" appears');
  check(/anonymous, wants it on the site/.test(mineCard.text), 'with their own message');
  check(/fixed it, thank you!/.test(mineCard.text), 'and our reply');
  check(/answered/i.test(mineCard.text), 'marked as answered');

  const badCode = await p.evaluate(async () => {
    document.getElementById('feedback-ticket-input').value = 'ZZZZZZZZ';
    await lookupFeedbackTicket();
    const e = document.getElementById('feedback-lookup-error');
    return { shown: e.style.display === 'block', text: e.textContent };
  });
  check(badCode.shown && /no message found/i.test(badCode.text), `a wrong code says so (${badCode.text})`);

  console.log('\n--- the queue needs the key, and the key does not linger');
  const beforeKey = await p.evaluate(() => document.getElementById('feedback-admin-card').style.display);
  check(beforeKey === 'none', 'no queue for an ordinary visitor');

  // Deliberately NOT calling showPage here: a deep link to /feedback routes
  // through routeInitial on its own, and that is the path a real admin takes.
  // Calling it by hand would pass even if the page were never wired up.
  await p.goto('https://www.blinksunited.com/feedback?admin=S3CRET', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2600);
  await p.evaluate(() => document.getElementById('tutorial-overlay')?.remove());
  await p.waitForTimeout(400);
  check(await p.evaluate(() => document.getElementById('page-feedback').classList.contains('active')),
        'a deep link lands on the feedback page by itself');
  const admin = await p.evaluate(() => {
    const c = document.getElementById('feedback-admin-card');
    return { shown: c.style.display !== 'none', text: c.textContent.replace(/\s+/g, ' ').trim(), url: location.href };
  });
  check(admin.shown, 'the right key renders the queue');
  check(/anonymous, wants it on the site/.test(admin.text), 'with the messages in it');
  check(!/admin=/.test(admin.url), `and the key is scrubbed out of the address bar (${admin.url})`);
  check(await p.evaluate(() => !!document.querySelector('#feedback-admin-list textarea')),
        'each one has a reply box');

  check(errs.length === 0, `no page errors (${errs.join(' | ') || 'none'})`);
  const of_ = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(of_ <= 1, `no horizontal overflow at 412px (${of_}px)`);

  await p.screenshot({ path: '/tmp/feedback.png', fullPage: true }).catch(() => {});
  await b.close();
}

console.log(`\nFAILURES: ${fails.length}`);
fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
