// MAMA Fans' Choice — the X vote, counted the way Mnet counts it.
//
//   GET  /api/mama-votes            → { day, today, accounts, votes, days[] }
//   GET  /api/mama-votes?board=1    → { board: [{ handle, days, last_day }] }
//   GET  /api/mama-votes?me=1       → caller's status (Authorization: Bearer <token>)
//   POST /api/mama-votes { accessToken } → log today's vote for the caller's X account
//
// WHAT MAKES THIS DIFFERENT from the other three awards on this site. VMA,
// BreakTudo and KCA count how many votes you cast, self-reported, and more is
// better. Mnet does not: an X vote is ONE PER X ACCOUNT PER DAY, and a post, a
// repost and a quote of the same tag all collapse into that single vote. So the
// number here is DISTINCT X ACCOUNTS PER DAY, and casting it twice is not worth
// anything — which is why this endpoint cannot be used to inflate anything.
//
// WHY IT IS FREE. Counting unique accounts across all of X means reading every
// matching post and deduping the authors, and nobody gives that away. But we do
// not need all of X to count OUR accounts: blinks already sign in here with X
// (55 of them at the time of writing), so the X identity is already in the auth
// table. The uniqueness is then a primary key, not an honour system — which is
// the one part of this that is better than self-reporting.
//
// What it therefore measures: blinks who came through this site. Not the whole
// fandom, and the page says so. It is still the number worth having, because it
// is the one you can act on.
//
// The X identity is resolved HERE, from the caller's token, and never taken
// from the request body. A browser that could name its own X account could cast
// a vote per account it invented, and the key would protect nothing.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.  Schema: supabase/mama_x_votes.sql

import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// ── today's post to repost ──────────────────────────────────────────────────
//
//   GET  /api/mama-votes                               → includes { pinned }
//   POST /api/mama-votes?action=pin&key=ADMIN_SECRET   → { url } | { url: '' }
//
// Mnet counts a repost of a valid post as the reposter's own vote, so our daily
// post is the shortest route a blink has to voting. The site cannot find that
// post by itself: since February 2026 X has no read-capable free tier, and
// reading the account's latest post is a paid, per-request call. One pasted URL
// a day costs nothing and does the same job.
//
// IT EXPIRES ON PURPOSE. A pin that is not replaced tomorrow is a pin nobody
// remembered, and the failure mode of trusting it for ever is blinks being sent
// to a post from last week with nobody the wiser. After PIN_TTL the page stops
// using it and falls back to the live search of our own posts, which is
// self-maintaining and always finds the newest. Forgetting therefore degrades
// to the behaviour we already shipped rather than to something wrong.
//
// Redis, like the playlist: one small value, no schema, same admin-key shape.
const PIN_KEY = 'bp_mama_pinned_post';
const PIN_TTL_MS = 24 * 3600 * 1000;

// UPSTASH_REDIS_REST_URL / _TOKEN, the same pair every other endpoint here
// uses. Guarded rather than calling fromEnv() bare like api/playlist.js does:
// this endpoint's main job is the vote count, and Redis being unset must cost
// the page its pin, not its totals.
function redis() {
  try {
    if (!process.env.UPSTASH_REDIS_REST_URL) return null;
    return Redis.fromEnv();
  } catch (e) { return null; }
}

// Only a real post, and only OURS. A pin is a link every blink is told to
// repost, so pointing it at another account — by typo or by paste from the
// wrong tab — would have the whole site amplifying a post nobody checked. The
// handle is pinned to an env var so it can be corrected without a deploy.
const PIN_HANDLE = (process.env.MAMA_X_HANDLE || 'blinksunitedtwt').toLowerCase();

function parsePostUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\b/i);
  if (!m) return { error: 'That is not an x.com post link. It should look like https://x.com/' + PIN_HANDLE + '/status/1234567890' };
  if (m[1].toLowerCase() !== PIN_HANDLE) {
    return { error: 'That post is from @' + m[1] + ', not @' + PIN_HANDLE + '. Only our own posts can be pinned.' };
  }
  // Rebuilt from the parts rather than stored as pasted: share links arrive
  // carrying ?t= and ?s= tracking that would be handed on to every blink.
  return { id: m[2], url: 'https://x.com/' + PIN_HANDLE + '/status/' + m[2] };
}

// What the page should show. Past its life it is not returned at all, so the
// client has nothing stale to decide about.
function freshPin(pin) {
  if (!pin || !pin.url || !pin.at) return null;
  const age = Date.now() - Number(pin.at);
  if (!(age >= 0) || age > PIN_TTL_MS) return null;
  return { url: pin.url, id: pin.id, at: pin.at, ageMs: age };
}

// Mnet's day. The same boundary BreakTudo and KCA use in api/vma-votes.js —
// en-CA formats as YYYY-MM-DD and Intl handles the offset.
const kstDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

// ── when voting is actually open ────────────────────────────────────────────
// Two rounds with a gap between them, so "is it open" is not one deadline.
// 18:00 KST = 09:00Z, and 23:59 KST = 14:59Z the day before in UTC terms.
//
// From MAMA's OWN account (@MnetMAMA), which posted the schedule twice:
//   1st VOTE  2026.10.12 19:00 – 2026.10.22 23:59 KST
//   2nd VOTE  2026.10.28 18:00 – 2026.11.08 23:59 KST
//
// This replaces dates taken from a Soompi write-up and a Weibo post, and the
// corrections were not cosmetic. Soompi had round 2 ending 18 Nov — TEN DAYS
// after it actually does — so every "vote" logged in that window would have
// been counted against a closed ballot. The start was an hour early too.
//
// Round 1 opens at 19:00 KST, not the 18:00 that was going round.
const MAMA_ROUNDS = [
  { n: 1, from: Date.parse('2026-10-12T10:00:00Z'), to: Date.parse('2026-10-22T14:59:59Z') },
  { n: 2, from: Date.parse('2026-10-28T09:00:00Z'), to: Date.parse('2026-11-08T14:59:59Z') },
];
function roundAt(t = Date.now()) {
  for (const r of MAMA_ROUNDS) if (t >= r.from && t <= r.to) return r;
  return null;
}
// For the page: what to say when it is shut. Before round 1, between rounds,
// after round 2 — three different sentences, and "closed" is only one of them.
function windowState(t = Date.now()) {
  const open = roundAt(t);
  if (open) return { open: true, round: open.n, until: open.to };
  const next = MAMA_ROUNDS.find((r) => t < r.from);
  if (next) return { open: false, round: next.n, opensAt: next.from };
  return { open: false, ended: true };
}

// ── the caller's X account ──────────────────────────────────────────────────
// Supabase stores the provider as 'x' on this project (verified against the
// live auth.identities table — it is NOT 'twitter', which is what the same
// provider used to be called, so both are accepted rather than guessed at).
//
// The id is preferred from identity_data.provider_id, which is what the live
// rows actually carry; identity.id has meant different things across Supabase
// versions and is the last resort rather than the first.
async function xIdentity(sb, userId) {
  const { data, error } = await sb.auth.admin.getUserById(userId);
  if (error || !data || !data.user) return null;
  const ids = data.user.identities || [];
  const x = ids.find((i) => i.provider === 'x' || i.provider === 'twitter');
  if (!x) return null;
  const d = x.identity_data || {};
  const id = String(d.provider_id || d.sub || x.id || '').trim();
  if (!id) return null;
  const handle = (d.user_name || d.preferred_username || '').trim() || null;
  return { id, handle };
}

async function userFrom(sb, token) {
  if (!token) return null;
  const { data: { user } = {}, error } = await sb.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

export default async function handler(req, res) {
  const sb = supabase();
  if (!sb) return res.status(500).json({ error: 'Supabase is not configured' });

  try {
    if (req.method === 'GET') {
      if (req.query.board) {
        const { data, error } = await sb.rpc('mama_vote_board', { p_limit: 100 });
        if (error) throw error;
        return res.status(200).json({ board: data || [] });
      }

      if (req.query.me) {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const user = await userFrom(sb, token);
        if (!user) return res.status(401).json({ error: 'not signed in' });
        const x = await xIdentity(sb, user.id);
        if (!x) {
          // Not an error: most accounts here signed in with Google, and the
          // page's job is to offer the link rather than to report a fault.
          return res.status(200).json({ linkedX: false, votedToday: false, myDays: 0, window: windowState() });
        }
        const day = kstDay();
        const [{ data: todayRow }, { count }] = await Promise.all([
          sb.from('mama_x_votes').select('day').eq('x_user_id', x.id).eq('day', day).maybeSingle(),
          sb.from('mama_x_votes').select('day', { count: 'exact', head: true }).eq('x_user_id', x.id),
        ]);
        return res.status(200).json({
          linkedX: true, handle: x.handle,
          votedToday: !!todayRow, myDays: count || 0, window: windowState(),
        });
      }

      const { data, error } = await sb.rpc('mama_vote_totals', { p_day: kstDay() });
      if (error) throw error;
      // The pin rides along with the totals the page already asks for — a
      // second round trip for one short string would be the page waiting on
      // Redis before it could draw a button.
      let pinned = null;
      try {
        const r = redis();
        if (r) pinned = freshPin(await r.get(PIN_KEY));
      } catch (e) { /* Redis down is not a reason to fail the page */ }
      return res.status(200).json(Object.assign(
        { day: kstDay(), today: 0, accounts: 0, votes: 0, days: [] },
        data || {},
        { window: windowState(), pinned },
      ));
    }

    if (req.method === 'POST' && req.query.action === 'pin') {
      const adminSecret = process.env.ADMIN_SECRET;
      if (!adminSecret || req.query.key !== adminSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const r = redis();
      if (!r) return res.status(500).json({ error: 'Redis is not configured' });

      const raw = String((req.body || {}).url || '').trim();
      if (!raw) {                                   // an empty url clears it
        await r.del(PIN_KEY);
        return res.status(200).json({ pinned: null, cleared: true });
      }
      const parsed = parsePostUrl(raw);
      if (parsed.error) return res.status(400).json({ error: parsed.error });

      const pin = { url: parsed.url, id: parsed.id, at: Date.now() };
      // Expired in the store as well as in the read, so a forgotten pin does
      // not sit around for ever waiting to be served by a future code path
      // that forgets to check its age.
      await r.set(PIN_KEY, pin, { px: PIN_TTL_MS });
      return res.status(200).json({ pinned: freshPin(pin) });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const token = String(body.accessToken || '').trim();
      const user = await userFrom(sb, token);
      if (!user) return res.status(401).json({ error: 'Sign in to log your MAMA vote' });

      const x = await xIdentity(sb, user.id);
      if (!x) {
        return res.status(409).json({
          error: 'no-x-account',
          message: 'Link your X account first — the vote is counted per X account, so we need to know which one.',
        });
      }

      // Refused outside a round, and refused HERE rather than only in the page:
      // a logged "vote" on a day with no ballot is a number that means nothing,
      // and the page is not the only thing that can call this.
      const w = windowState();
      if (!w.open) {
        return res.status(409).json({
          error: 'closed', window: w,
          message: w.ended ? 'MAMA voting has ended.' : 'Voting is not open right now.',
        });
      }

      const day = kstDay();
      const { error: insErr } = await sb.from('mama_x_votes').insert({
        x_user_id: x.id, day, app_user_id: user.id, x_handle: x.handle, round: w.round,
      });
      // 23505 = the primary key did its job. Already voted today is a normal
      // outcome, not a failure: the second tap should read as "yes, you have".
      if (insErr && insErr.code !== '23505') throw insErr;
      const already = !!insErr;

      const { data: totals } = await sb.rpc('mama_vote_totals', { p_day: day });
      return res.status(200).json({
        ok: true, already, day, handle: x.handle, round: w.round,
        ...(totals || {}),
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

// For tests.
export const __test = { kstDay, roundAt, windowState, MAMA_ROUNDS };
