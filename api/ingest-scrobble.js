// POST /api/ingest-scrobble
//
// Direct scrobble ingest for the SessionBox Multi-Account Scrobbler extension.
// The extension posts each accepted scrobble here with a per-profile token; we
// resolve the token to a blinksunited profile (app_user_id) and log the play in
// `extension_scrobbles`, which the leaderboard aggregation can then count as an
// 'extension' source (see NOTE at the bottom for the wiring step).
//
// This is intentionally self-reported: it bypasses Last.fm's verification, so
// the token IS the only trust boundary. Keep tokens secret and per-profile.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// Schema: supabase/extension_scrobbles.sql

import { createClient } from '@supabase/supabase-js';

// Campaign tracks the leaderboard cares about (mirror of cron-scrobbles.js).
const TRACKS = [
  { id: 'jump',     artist: 'blackpink', track: 'jump' },
  { id: 'shutdown', artist: 'blackpink', track: 'shut down' },
  { id: 'ddududu',  artist: 'blackpink', track: 'ddu-du ddu-du' },
  { id: 'ltal',     artist: 'jennie',    track: 'less than a lover' },
  { id: 'go',       artist: 'blackpink', track: 'go' },
];

function norm(s) {
  return String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
}

function matchTrack(artist, title) {
  const a = norm(artist);
  const t = norm(title);
  for (const x of TRACKS) {
    if (t === x.track && a.includes(x.artist)) return x.id;
  }
  return null;
}

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function resolveToken(sb, token) {
  if (!token) return null;
  const { data, error } = await sb
    .from('scrobble_tokens')
    .select('app_user_id, label')
    .eq('token', token)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const sb = supabase();
  if (!sb) return res.status(500).json({ ok: false, error: 'server not configured' });

  const body = req.body || {};
  const token = (body.token || '').trim();

  const profile = await resolveToken(sb, token);
  if (!profile) return res.status(401).json({ ok: false, valid: false, error: 'invalid token' });

  // Options-page connectivity check.
  if (body.validate) {
    return res.status(200).json({ ok: true, valid: true, profile: profile.label || null });
  }

  const trackId = matchTrack(body.artist, body.title);
  if (!trackId) {
    // Not a campaign track — accept but don't store, so the extension doesn't error.
    return res.status(200).json({ ok: true, counted: false, reason: 'not a tracked song' });
  }

  const listenedAt = body.timestamp
    ? new Date(Number(body.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  const { error } = await sb.from('extension_scrobbles').insert({
    app_user_id: profile.app_user_id,
    track_id: trackId,
    artist: String(body.artist || '').slice(0, 200),
    title: String(body.title || '').slice(0, 200),
    spotify_account: String(body.account || '').slice(0, 200),
    listened_at: listenedAt,
  });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  return res.status(200).json({ ok: true, counted: true, trackId });
}

// NOTE — leaderboard wiring (do this deliberately, it touches production):
// To make these show on the leaderboard, refreshUser() in api/cron-scrobbles.js
// (and the client submission path in api/leaderboard.js) must add, for each
// profile, the count of extension_scrobbles rows in the current day/week window
// per track_id — treated as its own 'extension' source so it doesn't double
// count with a Last.fm link of the same account.
