import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const OG_CUTOFF = new Date('2026-09-01T00:00:00Z');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = supabase();
  if (!sb) return res.status(200).json({ og: [] });

  const { data, error } = await sb
    .from('beta_testers')
    .select('lfm_username, created_at')
    .lt('created_at', OG_CUTOFF.toISOString());

  if (error) return res.status(200).json({ og: [] });

  const og = (data || []).map(r => r.lfm_username.toLowerCase());
  res.setHeader('Cache-Control', 'public, max-age=300'); // cache 5 min
  return res.status(200).json({ og });
}
