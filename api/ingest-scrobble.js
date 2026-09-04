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
// Fallen Angel EP tracks (fallenangel, heaven) get their OWN ids here so the
// extension attributes plays per-song (instead of the generic solo_jennie
// bucket). matchTrack runs before classifyArtist, so these win.
const TRACKS = [
  { id: 'jump',        artist: 'blackpink', track: 'jump' },
  { id: 'shutdown',    artist: 'blackpink', track: 'shut down' },
  { id: 'ddududu',     artist: 'blackpink', track: 'ddu-du ddu-du' },
  { id: 'ltal',        artist: 'jennie',    track: 'less than a lover' },
  { id: 'go',          artist: 'blackpink', track: 'go' },
  { id: 'sawadika',    artist: 'lisa',      track: 'sawadika' },
  { id: 'fallenangel', artist: 'jennie',    track: 'fallen angel' },
  { id: 'heaven',      artist: 'jennie',    track: 'heaven' },
];

function norm(s) {
  return String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
}

// Tighter key for title equality: drop ALL spaces and punctuation so stylized /
// re-spaced titles still match the campaign entry. "SaWaDiKa", "SAWADIKA" and
// "Sa Wa Di Ka" all collapse to "sawadika"; "DDU-DU DDU-DU" → "dududududu".
// Still a FULL-title match (not a prefix), so "GO" never catches "Good", etc.
function keyName(s) {
  return norm(s).replace(/[^a-z0-9]/g, '');
}

function matchTrack(artist, title) {
  const a = norm(artist);
  const tk = keyName(title);
  for (const x of TRACKS) {
    if (tk === keyName(x.track) && a.includes(x.artist)) return x.id;
  }
  return null;
}

// Non-campaign classification. The extension sends every play it sees; beyond
// the 5 campaign tracks we also want to record ALL other BLACKPINK-group songs
// and ALL four members' solo songs, so the profile's "Total BP Scrobbles" and
// "Solo Scrobbles" totals accumulate from the extension too (not just from a
// linked Last.fm). Everything else (non-BP artists) is still dropped.
//
// These land in category buckets rather than per-song ids:
//   'bp_group'    → any BLACKPINK-group song that isn't a campaign track
//   'solo_<name>' → any JISOO/JENNIE/ROSÉ/LISA solo song that isn't a campaign track
// The real song is still preserved in the artist/title columns. Bucketing keeps
// extension_counts small and needs no schema/RPC change; dedup stays correct
// because one Spotify account plays one song per second, so (account, second)
// already identifies a single play regardless of the bucket.
const MEMBER_MAP = {
  'jisoo': 'jisoo', 'kim jisoo': 'jisoo', 'kim ji-soo': 'jisoo', '지수': 'jisoo',
  'lisa': 'lisa', 'lalisa': 'lisa', 'lalisa manobal': 'lisa',
  'rosé': 'rose', 'rose': 'rose', 'roseanne park': 'rose', 'roseanne': 'rose',
  'jennie': 'jennie', 'kim jennie': 'jennie', '제니': 'jennie',
};

// Resolve an artist string to a category bucket, or null if not BP/member.
// BLACKPINK-group wins first; otherwise the primary/credited artist parts are
// checked against the member map (so "ROSÉ, Bruno Mars" → solo_rose).
function classifyArtist(artist) {
  const a = norm(artist);
  if (!a) return null;
  if (a.includes('blackpink')) return 'bp_group';
  const parts = a.split(/,|&|\/|feat\.?|featuring|with/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (MEMBER_MAP[p]) return 'solo_' + MEMBER_MAP[p];
  }
  if (MEMBER_MAP[a]) return 'solo_' + MEMBER_MAP[a];
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

  const sb = supabase();
  if (!sb) return res.status(500).json({ ok: false, error: 'server not configured' });

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const body = req.body || {};
  const token = (body.token || '').trim();

  const profile = await resolveToken(sb, token);
  if (!profile) return res.status(401).json({ ok: false, valid: false, error: 'invalid token' });

  // Options-page connectivity check.
  if (body.validate) {
    return res.status(200).json({ ok: true, valid: true, profile: profile.label || null });
  }

  // Campaign track first (keeps its stable id → cards/badges/leaderboard);
  // otherwise fall back to a BP-group / solo-member category bucket.
  let trackId = matchTrack(body.artist, body.title);
  if (!trackId) trackId = classifyArtist(body.artist);
  if (!trackId) {
    // Not BLACKPINK or a member — accept but don't store, so the extension doesn't error.
    return res.status(200).json({ ok: true, counted: false, reason: 'not a tracked artist' });
  }

  const listenedAt = body.timestamp
    ? new Date(Number(body.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  const row = {
    app_user_id: profile.app_user_id,
    track_id: trackId,
    artist: String(body.artist || '').slice(0, 200),
    title: String(body.title || '').slice(0, 200),
    spotify_account: String(body.account || '').slice(0, 200),
    listened_at: listenedAt,
  };

  // Idempotent write. The unique index on
  // (app_user_id, spotify_account, track_id, listened_at) makes one real play =
  // one row, so a re-sent scrobble (a second extension, a poll-overlap race, or
  // a reload/resume) hits the conflict and is skipped instead of duplicated.
  const up = await sb.from('extension_scrobbles').upsert(row, {
    onConflict: 'app_user_id,spotify_account,track_id,listened_at',
    ignoreDuplicates: true,
  });
  if (up.error) {
    // Safety fallback: if the unique index isn't in place yet (code deployed
    // before the migration), upsert's ON CONFLICT target is missing and errors
    // (Postgres 42P10). Never drop a real play over deploy ordering — insert
    // plainly. Any duplicates from that window are removable later; a lost
    // scrobble is not. Other errors are surfaced as-is.
    const missingConstraint =
      up.error.code === '42P10' || /on conflict/i.test(up.error.message || '');
    if (!missingConstraint) return res.status(500).json({ ok: false, error: up.error.message });
    const ins = await sb.from('extension_scrobbles').insert(row);
    if (ins.error) return res.status(500).json({ ok: false, error: ins.error.message });
  }

  return res.status(200).json({ ok: true, counted: true, trackId });
}

// NOTE — leaderboard wiring (do this deliberately, it touches production):
// To make these show on the leaderboard, refreshUser() in api/cron-scrobbles.js
// (and the client submission path in api/leaderboard.js) must add, for each
// profile, the count of extension_scrobbles rows in the current day/week window
// per track_id — treated as its own 'extension' source so it doesn't double
// count with a Last.fm link of the same account.
