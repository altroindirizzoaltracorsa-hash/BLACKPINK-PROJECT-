// VMA voting leaderboard — account-gated, self-reported vote counts.
//
//   GET  /api/vma-votes              → community totals { total, today, blinksTotal, blinksToday }
//   GET  /api/vma-votes?board=1      → { board: [{ name, total, today, week, month }, ...] }
//   GET  /api/vma-votes?me=1         → caller's status (Authorization: Bearer <token>)
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
      if (req.query.me) {
        const token = bearer(req);
        if (!token) return res.status(401).json({ error: 'not signed in' });
        const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'not signed in' });
        const linked = await isLinked(sb, user.id);
        return res.status(200).json({ linked, ...(await myTotals(sb, user.id)) });
      }
      const { data, error } = await sb.rpc('vma_vote_totals');
      if (error) throw error;
      return res.status(200).json(data || { total: 0, today: 0, blinksTotal: 0, blinksToday: 0 });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const token = String(body.accessToken || '').trim();
      let votes = parseInt(body.votes, 10);
      if (!token) return res.status(401).json({ error: 'Sign in to log your votes' });
      if (!Number.isFinite(votes) || votes <= 0) return res.status(400).json({ error: 'votes required' });
      votes = Math.min(votes, 10000); // sanity bound only (no daily cap)

      const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
      if (authErr || !user) return res.status(401).json({ error: 'Sign in to log your votes' });

      if (!(await isLinked(sb, user.id))) {
        return res.status(403).json({ error: 'Link a scrobbler first — the voting board is for streaming blinks.' });
      }

      // Prefer the BU display name; if the account never set one (e.g. an OAuth
      // sign-in), fall back to the linked scrobbler handle — the same public name
      // the streaming leaderboard shows — so the row isn't a nameless "a blink".
      let name = (user.user_metadata && user.user_metadata.display_name) || null;
      if (!name) {
        try {
          const { data: la } = await sb.from('linked_accounts')
            .select('source_username').eq('app_user_id', user.id).limit(1);
          name = (la && la[0] && la[0].source_username) || null;
        } catch {}
      }
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

      const [my, totals] = await Promise.all([myTotals(sb, user.id), sb.rpc('vma_vote_totals')]);
      return res.status(200).json({ ok: true, my, totals: totals.data || {} });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'error' });
  }
}
