import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

const OG_CUTOFF = new Date('2026-09-01T00:00:00Z');

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // ── GET /api/beta?action=status&username=X ────────────────────
  if (req.method === 'GET' && action === 'status') {
    const username = req.query.username?.trim();
    if (!username) return res.status(400).json({ error: 'username required' });

    const sb = supabase();
    if (!sb) return res.status(200).json({ isBeta: false, isOG: false });

    const { data, error } = await sb.from('beta_testers')
      .select('created_at')
      .ilike('lfm_username', username)
      .maybeSingle();

    if (error) {
      console.error('[beta status] supabase error:', error.message);
      return res.status(200).json({ isBeta: false, isOG: false, _error: error.message });
    }
    if (!data) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ isBeta: false, isOG: false });
    }

    const isOG = new Date(data.created_at) < OG_CUTOFF;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ isBeta: true, isOG, signedUpAt: data.created_at });
  }

  // ── GET /api/beta?action=og-users ─────────────────────────────
  if (req.method === 'GET' && action === 'og-users') {
    const sb = supabase();
    if (!sb) return res.status(200).json({ og: [] });

    const { data, error } = await sb.from('beta_testers')
      .select('lfm_username, created_at')
      .lt('created_at', OG_CUTOFF.toISOString());

    if (error) return res.status(200).json({ og: [] });

    const og = (data || []).map(r => r.lfm_username.toLowerCase());
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ og });
  }

  // ── POST /api/beta (signup) ───────────────────────────────────
  if (req.method === 'POST' && !action) {
    const { lfm_username, twitter_handle } = req.body || {};
    if (!lfm_username?.trim()) return res.status(400).json({ error: 'lfm_username required' });

    const lfm = lfm_username.trim().slice(0, 100);
    const twitter = twitter_handle?.trim().slice(0, 100) || null;

    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Server not configured' });

    const { data: existing } = await sb.from('beta_testers')
      .select('id, created_at')
      .ilike('lfm_username', lfm)
      .maybeSingle();

    if (existing) {
      return res.status(200).json({ ok: true, alreadySigned: true, signedUpAt: existing.created_at });
    }

    const { data, error } = await sb.from('beta_testers')
      .insert({ lfm_username: lfm, twitter_handle: twitter })
      .select('created_at')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, signedUpAt: data.created_at });
  }

  // ── POST /api/beta?action=backfill ────────────────────────────
  if (req.method === 'POST' && action === 'backfill') {
    const sb = supabase();
    if (!sb) return res.status(503).json({ error: 'Supabase not configured' });

    const redis = Redis.fromEnv();
    const lbData = await redis.get('bu_leaderboard_v1');
    const users = lbData?.users || {};
    const usernames = Object.values(users).map(u => u.username || '').filter(Boolean);

    if (!usernames.length) return res.status(200).json({ ok: true, registered: 0 });

    let registered = 0;
    let skipped = 0;
    const failed = [];

    for (const username of usernames) {
      const { error } = await sb.from('beta_testers').insert({ lfm_username: username.slice(0, 100) });
      if (!error) registered++;
      else if (error.code === '23505') skipped++;
      else failed.push({ username, error: error.message });
    }

    return res.status(200).json({ ok: true, registered, skipped, failed });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
