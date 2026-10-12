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

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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
// THESE DATES ARE FROM SECONDARY SOURCES — a Soompi write-up and a Weibo post,
// not Mnet's own notice, which I could not reach. They are in one place and
// named so they can be corrected in one edit. Being wrong here refuses a real
// vote or accepts one with nothing to vote on, so they are worth confirming.
const MAMA_ROUNDS = [
  { n: 1, from: Date.parse('2026-10-12T09:00:00Z'), to: Date.parse('2026-10-22T14:59:59Z') },
  { n: 2, from: Date.parse('2026-10-28T09:00:00Z'), to: Date.parse('2026-11-18T14:59:59Z') },
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
      return res.status(200).json(Object.assign(
        { day: kstDay(), today: 0, accounts: 0, votes: 0, days: [] },
        data || {},
        { window: windowState() },
      ));
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
