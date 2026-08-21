// VMA voting leaderboard — account-gated, self-reported vote counts.
//
//   GET  /api/vma-votes              → community totals { total, today, blinksTotal, blinksToday }
//   GET  /api/vma-votes?board=1      → { board: [{ name, total, today, week, month }, ...] }
//   GET  /api/vma-votes?me=1         → caller's status (Authorization: Bearer <token>)
//   GET  /api/vma-votes?live=1       → { liveVoters } — distinct accounts that logged a
//                                       vote in the last 90s (the "blinks voting now" pulse)
//   POST /api/vma-votes { accessToken, votes }  → add `votes` to today (uncapped)
//
// To submit you must be signed in AND have a linked scrobbler (>=1 row in
// linked_accounts) — i.e. an actual streaming blink. Enforced below.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.  Schema: supabase/vma_user_votes.sql

import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// MTV's VMA voting day resets at MIDNIGHT ET, so we bucket votes by the US
// Eastern calendar date (not UTC). Intl handles EDT/EST automatically.
// en-CA formats as YYYY-MM-DD.
const etDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

async function isLinked(sb, uid) {
  const { data } = await sb.from('linked_accounts').select('app_user_id').eq('app_user_id', uid).limit(1);
  return !!(data && data.length);
}

// Sum a user's rows into today / week (Mon-start) / month / all-time, in US
// Eastern (midnight-ET day boundary — matches the /vmas countdown).
async function myTotals(sb, uid) {
  const { data } = await sb.from('vma_user_votes').select('day, votes').eq('app_user_id', uid);
  const rows = data || [];
  const t = etDay();                              // 'YYYY-MM-DD' — today in ET
  const [y, m, dd] = t.split('-').map(Number);
  // Treat the ET wall-clock date as a UTC date purely for weekday arithmetic.
  const base = new Date(Date.UTC(y, m - 1, dd));
  const dow = (base.getUTCDay() + 6) % 7;         // 0 = Monday
  const monday = new Date(Date.UTC(y, m - 1, dd - dow)).toISOString().slice(0, 10);
  const first = `${t.slice(0, 7)}-01`;
  let today = 0, week = 0, month = 0, total = 0;
  for (const r of rows) {
    const v = r.votes || 0;
    total += v;
    if (r.day === t) today += v;
    if (r.day >= monday) week += v;
    if (r.day >= first) month += v;
  }
  return { today, week, month, total };
}

// The caller's campaign streams: today's (ET-day aligned) for display + Monster
// Blink, and whether they've EVER streamed (the silent gate for ranking/badges —
// you can register votes without streaming, but you only rank if you've streamed).
async function myStreams(sb, uid) {
  const { data } = await sb.from('user_daily_counts')
    .select('day_key, jump, shutdown, ddududu, go').eq('app_user_id', uid);
  const rows = data || [];
  const t = etDay();
  let streams = 0;
  for (const r of rows) {
    if (r.day_key === t) streams += (r.jump || 0) + (r.shutdown || 0) + (r.ddududu || 0) + (r.go || 0);
  }
  // Ranked/badged only while actually streaming TODAY — not merely having linked
  // a scrobbler or streamed on some past day.
  return { streams, ranked: streams >= 1 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = supabase();
  if (!sb) return res.status(503).json({ error: 'Voting not configured' });

  try {
    if (req.method === 'GET') {
      if (req.query.board) {
        const { data, error } = await sb.rpc('vma_vote_board');
        if (error) throw error;
        return res.status(200).json({ board: data || [] });
      }
      if (req.query.live) {
        // "Blinks voting now": distinct accounts whose tally was touched in the last
        // 90s (via the site OR the extension). Community-scoped, not a global MTV count.
        const cutoff = new Date(Date.now() - 90 * 1000).toISOString();
        const { data, error } = await sb.from('vma_user_votes')
          .select('app_user_id').gte('updated_at', cutoff);
        if (error) throw error;
        const liveVoters = data ? new Set(data.map((r) => r.app_user_id)).size : 0;
        return res.status(200).json({ liveVoters });
      }
      if (req.query.me) {
        const token = bearer(req);
        if (!token) return res.status(401).json({ error: 'not signed in' });
        const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'not signed in' });
        const linked = await isLinked(sb, user.id);
        const [totals, streams] = await Promise.all([myTotals(sb, user.id), myStreams(sb, user.id)]);
        return res.status(200).json({ linked, ...totals, ...streams });
      }
      const { data, error } = await sb.rpc('vma_vote_totals');
      if (error) throw error;
      return res.status(200).json(data || { total: 0, today: 0, blinksTotal: 0, blinksToday: 0 });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      let votes = parseInt(body.votes, 10);
      if (!Number.isFinite(votes) || votes <= 0) return res.status(400).json({ error: 'votes required' });
      votes = Math.min(votes, 10000); // sanity bound only (no daily cap)

      // Two ways to authenticate a vote submission:
      //   • accessToken — a Supabase session (the website "Add votes" button).
      //   • extToken    — a scrobble_token (the BU vote-counter browser extension,
      //     linked once via /extension-link.html). Resolve it to the same account.
      let uid = null, name = null;
      const extToken = String(body.extToken || '').trim();
      const token = String(body.accessToken || '').trim();
      if (extToken) {
        const { data: tok } = await sb
          .from('scrobble_tokens').select('app_user_id, label').eq('token', extToken).maybeSingle();
        if (!tok) return res.status(401).json({ error: 'Link your blinksunited account in the extension first.' });
        uid = tok.app_user_id;
        name = null; // let the board resolve the name (display_name → handle → blinkN)
      } else {
        if (!token) return res.status(401).json({ error: 'Sign in to log your votes' });
        const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Sign in to log your votes' });
        if (!(await isLinked(sb, user.id))) {
          return res.status(403).json({ error: 'Link a scrobbler first — the voting board is for streaming blinks.' });
        }
        uid = user.id;
        // Store the BU display name if set, else null — the board resolves nameless
        // accounts to their handle / blinkN (see vma_vote_board).
        name = (user.user_metadata && user.user_metadata.display_name) || null;
      }
      const user = { id: uid };
      const day = etDay();

      // Additive: add to today's tally (self-reported, uncapped).
      const { data: existing } = await sb
        .from('vma_user_votes').select('votes').eq('app_user_id', user.id).eq('day', day).maybeSingle();
      const next = (existing?.votes || 0) + votes;

      const { error: upErr } = await sb.from('vma_user_votes').upsert(
        { app_user_id: user.id, day, votes: next, display_name: name, updated_at: new Date().toISOString() },
        { onConflict: 'app_user_id,day' },
      );
      if (upErr) return res.status(500).json({ error: upErr.message });

      // The vote is saved. Compute fresh totals for the response, but never fail
      // the request if that read hiccups — the write already succeeded, so a 500
      // here would wrongly tell the client to "try again" (and double-count).
      let my = null, totals = {};
      try {
        const [m, t] = await Promise.all([myTotals(sb, user.id), sb.rpc('vma_vote_totals')]);
        my = m; totals = t.data || {};
      } catch { /* ignore — client will refetch */ }
      return res.status(200).json({ ok: true, my, totals });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'error' });
  }
}
