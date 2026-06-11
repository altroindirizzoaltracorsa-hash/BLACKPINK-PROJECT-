import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = supabase();
  if (!sb) return res.status(503).json({ error: 'Server not configured' });

  if (req.method === 'GET') {
    const username = req.query.username?.trim();
    if (!username) return res.status(400).json({ error: 'username required' });

    const { data, error } = await sb
      .from('user_stamps')
      .select('day_key, stamps')
      .ilike('lfm_username', username);

    if (error) return res.status(500).json({ error: error.message });

    const stamps = {};
    for (const row of data || []) stamps[row.day_key] = row.stamps;

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ stamps });
  }

  if (req.method === 'POST') {
    const { username, day_key, stamps, all_stamps } = req.body || {};
    if (!username?.trim()) return res.status(400).json({ error: 'username required' });

    const user = username.trim().slice(0, 100);
    const now = new Date().toISOString();

    // Bulk upsert (first-time migration from localStorage)
    if (all_stamps && typeof all_stamps === 'object') {
      const rows = Object.entries(all_stamps)
        .filter(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && v && typeof v === 'object')
        .map(([k, v]) => ({ lfm_username: user, day_key: k, stamps: v, updated_at: now }));
      if (!rows.length) return res.status(200).json({ ok: true });

      const { error } = await sb
        .from('user_stamps')
        .upsert(rows, { onConflict: 'lfm_username,day_key' });

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, count: rows.length });
    }

    // Single-day upsert
    if (!day_key || !stamps) return res.status(400).json({ error: 'day_key and stamps required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day_key)) return res.status(400).json({ error: 'invalid day_key' });

    const { error } = await sb
      .from('user_stamps')
      .upsert(
        { lfm_username: user, day_key, stamps, updated_at: now },
        { onConflict: 'lfm_username,day_key' }
      );

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
