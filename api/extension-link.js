// POST /api/extension-link
//
// Mints (or returns) a scrobble token for the logged-in blinksunited profile,
// so the browser extension can link by login instead of a hand-copied token.
// The /extension-link.html page calls this with the user's Supabase access
// token; we validate it, then upsert one token per app_user_id.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// Schema: supabase/extension_scrobbles.sql (scrobble_tokens table)

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const sb = supabase();
  if (!sb) return res.status(500).json({ ok: false, error: 'server not configured' });

  const accessToken = (req.body && req.body.accessToken)
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!accessToken) return res.status(401).json({ ok: false, error: 'not signed in' });

  const { data: { user } = {}, error: authErr } = await sb.auth.getUser(accessToken);
  if (authErr || !user) return res.status(401).json({ ok: false, error: 'session expired — sign in again' });

  // Reuse an existing token for this profile if there is one.
  const { data: existing } = await sb
    .from('scrobble_tokens')
    .select('token, label')
    .eq('app_user_id', user.id)
    .maybeSingle();

  const profileLabel = user.user_metadata?.display_name || user.email || 'blink';

  if (existing) {
    return res.status(200).json({ ok: true, token: existing.token, profile: existing.label || profileLabel });
  }

  const token = randomBytes(24).toString('hex');
  const { error: insErr } = await sb.from('scrobble_tokens').insert({
    token,
    app_user_id: user.id,
    label: profileLabel,
  });
  if (insErr) return res.status(500).json({ ok: false, error: insErr.message });

  return res.status(200).json({ ok: true, token, profile: profileLabel });
}
