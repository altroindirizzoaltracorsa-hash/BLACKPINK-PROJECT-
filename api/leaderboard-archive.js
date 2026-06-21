import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = supabase();
  if (!sb) return res.status(503).json({ error: 'Server not configured' });

  const period = req.query.period;
  if (period !== 'daily' && period !== 'weekly') {
    return res.status(400).json({ error: 'period must be daily or weekly' });
  }

  res.setHeader('Cache-Control', 'no-store');

  const key = req.query.key?.trim();
  if (key) {
    const { data, error } = await sb
      .from('leaderboard_archive')
      .select('period_key, label, users, archived_at')
      .eq('period', period)
      .eq('period_key', key)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'No archive for that date' });

    return res.status(200).json({
      key: data.period_key,
      label: data.label,
      users: data.users,
      archivedAt: data.archived_at,
    });
  }

  // No key — list available snapshots for the history picker, most recent first
  const { data, error } = await sb
    .from('leaderboard_archive')
    .select('period_key, label, archived_at')
    .eq('period', period)
    .order('period_key', { ascending: false })
    .limit(90);

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({
    items: (data || []).map(r => ({ key: r.period_key, label: r.label, archivedAt: r.archived_at })),
  });
}
