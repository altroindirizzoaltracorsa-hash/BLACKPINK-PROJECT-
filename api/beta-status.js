import { createClient } from '@supabase/supabase-js';

const OG_CUTOFF = new Date('2026-09-01T00:00:00Z');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username required' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ isBeta: false, isOG: false });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await sb.from('beta_testers')
    .select('created_at')
    .ilike('lfm_username', username)
    .maybeSingle();

  if (error) {
    console.error('[beta-status] supabase error:', error.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ isBeta: false, isOG: false, _error: error.message });
  }

  if (!data) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ isBeta: false, isOG: false });
  }

  const isOG = new Date(data.created_at) < OG_CUTOFF;
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ isBeta: true, isOG, signedUpAt: data.created_at });
}
