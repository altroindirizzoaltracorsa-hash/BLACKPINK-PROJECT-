import { createClient } from '@supabase/supabase-js';

function supabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lfm_username, twitter_handle } = req.body || {};
  if (!lfm_username?.trim()) return res.status(400).json({ error: 'lfm_username required' });

  const lfm = lfm_username.trim().slice(0, 100);
  const twitter = twitter_handle?.trim().slice(0, 100) || null;

  const sb = supabase();

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
  res.status(201).json({ ok: true, signedUpAt: data.created_at });
}
