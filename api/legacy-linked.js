// GET /api/legacy-linked?username=<name>&source=lastfm
//
// Returns { linked: true } if that scrobbler username is already linked to a
// full account (any provider — X / Google / Discord / email). Lets the
// legacy-migration modal skip people who already migrated (their old Last.fm
// name is linked to a new account), even on a browser that isn't signed in.
//
// Uses the service role to bypass RLS on linked_accounts (a signed-out client
// can't read another account's rows). Returns only a boolean, never who it's
// linked to. Fails OPEN (linked:false) so a config/db hiccup never hides a
// genuinely-needed migration prompt.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY.

import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const username = (req.query.username || '').trim();
  const source = (req.query.source || 'lastfm').trim();
  if (!username) return res.status(400).json({ linked: false, error: 'username required' });

  const sb = supabase();
  if (!sb) return res.status(200).json({ linked: false });

  try {
    const { data, error } = await sb
      .from('linked_accounts')
      .select('id')
      .eq('source', source)
      .ilike('source_username', username)   // case-insensitive exact match (Last.fm names have no SQL wildcards)
      .limit(1);
    if (error) return res.status(200).json({ linked: false, error: error.message });
    return res.status(200).json({ linked: !!(data && data.length) });
  } catch (e) {
    return res.status(200).json({ linked: false, error: e.message });
  }
}
