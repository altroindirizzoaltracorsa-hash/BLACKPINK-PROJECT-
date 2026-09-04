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

// ── Ingest debug ring buffer ──────────────────────────────────────────────
// Diagnoses under/over-counting: records the last 200 *campaign-relevant* ingest
// attempts — every campaign-track play (whether stored fresh or skipped as a
// duplicate) plus any play we couldn't match to a campaign track. This is what
// tells us, when a fan says "I played it 5× but it counted once", whether the
// extension sent 5 POSTs (and 4 hit the dedup) or only ever sent 1. Best-effort
// and capped, so it can't slow or break ingest. Read via ?reclass=peek.
const DEBUG_KEY = 'bu_ingest_debug';
const CAMPAIGN_IDS = new Set(TRACKS.map(t => t.id));
async function debugLog(entry) {
  const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return;
  try {
    await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['LPUSH', DEBUG_KEY, JSON.stringify(entry)], ['LTRIM', DEBUG_KEY, '0', '199']]),
    });
  } catch { /* never break ingest over a debug write */ }
}
async function debugRead(n = 80) {
  const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return [];
  try {
    const r = await fetch(`${url}/lrange/${DEBUG_KEY}/0/${n - 1}`, { headers: { Authorization: `Bearer ${tok}` } });
    const d = await r.json();
    return (d.result || []).map(s => { try { return JSON.parse(s); } catch { return s; } });
  } catch { return []; }
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

  // ── Admin: reclassify mis-bucketed plays (POST ?reclass=1&key=ADMIN[&dry=1]) ──
  // A campaign track added AFTER plays already accumulated leaves those earlier
  // plays in the generic solo_<member> / bp_group bucket (they still counted
  // toward the member's Solo total, but not toward that track's board / community
  // goal). This re-runs matchTrack over the generic buckets and moves any row
  // that NOW matches a campaign track to its real track_id — recovering e.g.
  // SaWaDiKa plays sitting in solo_lisa. Idempotent: rows already on a campaign
  // id aren't scanned, so re-running is a no-op. dry=1 previews without writing.
  if (req.query.reclass) {
    const adminSecret = process.env.ADMIN_SECRET;
    const key = req.headers['x-admin-secret'] || req.query.key;
    if (!adminSecret || key !== adminSecret) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    // peek — diagnostic: what is the extension actually recording? Returns the
    // most recent rows, the per-track_id row counts, and a sample of the LISA /
    // "sawadika"-looking titles seen, so we can tell whether SaWaDiKa plays are
    // arriving at all (and under what artist/title) vs never reaching ingest.
    if (req.query.reclass === 'peek') {
      const { data: recent } = await sb
        .from('extension_scrobbles')
        .select('artist, title, track_id, listened_at')
        .order('listened_at', { ascending: false })
        .limit(40);
      // Any row whose title looks like SaWaDiKa, whatever bucket it's in.
      const { data: swLike } = await sb
        .from('extension_scrobbles')
        .select('artist, title, track_id, listened_at')
        .ilike('title', '%sawa%')
        .order('listened_at', { ascending: false })
        .limit(40);
      // Distinct LISA-bucket titles (what LISA songs ARE being captured).
      const { data: lisaRows } = await sb
        .from('extension_scrobbles')
        .select('title')
        .eq('track_id', 'solo_lisa')
        .limit(1000);
      const lisaTitles = {};
      for (const r of (lisaRows || [])) lisaTitles[r.title] = (lisaTitles[r.title] || 0) + 1;
      const lisaTop = Object.entries(lisaTitles).sort((a, b) => b[1] - a[1]).slice(0, 30);
      return res.status(200).json({
        ok: true, peek: true,
        recent: recent || [],
        sawadika_like: swLike || [],
        solo_lisa_distinct_titles: lisaTop,
        ingest_log: await debugRead(80),   // live: what the extension is POSTing (insert vs dup vs no-match)
      });
    }

    const dry = req.query.dry === '1' || req.query.dry === 'true';
    const BUCKETS = ['bp_group', 'solo_jisoo', 'solo_jennie', 'solo_rose', 'solo_lisa'];

    // Paginate the generic buckets, remapping each row through matchTrack.
    const moves = {};                 // newId -> [row id, …]
    let scanned = 0, from = 0;
    const PAGE = 1000;
    try {
      for (;;) {
        const { data, error } = await sb
          .from('extension_scrobbles')
          .select('id, artist, title, track_id')
          .in('track_id', BUCKETS)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) return res.status(500).json({ ok: false, error: error.message });
        if (!data || !data.length) break;
        scanned += data.length;
        for (const r of data) {
          const newId = matchTrack(r.artist, r.title);
          if (newId) (moves[newId] ||= []).push(r.id);
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

    const summary = Object.fromEntries(Object.entries(moves).map(([k, v]) => [k, v.length]));
    const totalMoved = Object.values(moves).reduce((s, v) => s + v.length, 0);
    if (dry) return res.status(200).json({ ok: true, dry: true, scanned, wouldMove: summary, total: totalMoved });

    // Apply, chunked so the id list per request stays small. A moved row could in
    // theory collide with the unique index (same play already on the target id) —
    // impossible in practice (one play is stored once), but tolerate per-chunk
    // errors so one bad row can't abort the whole recovery.
    let moved = 0; const errors = [];
    for (const [newId, ids] of Object.entries(moves)) {
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const { error } = await sb.from('extension_scrobbles').update({ track_id: newId }).in('id', chunk);
        if (error) errors.push(`${newId}[${i}]: ${error.message}`); else moved += chunk.length;
      }
    }
    return res.status(200).json({ ok: true, scanned, moved, byTrack: summary, errors: errors.slice(0, 10) });
  }

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
    // Not BLACKPINK or a member — accept but don't store, so the extension doesn't
    // error. Logged so a campaign play arriving under an unrecognized artist string
    // (which would otherwise vanish here) is still visible in the peek.
    await debugLog({ t: Date.now(), a: body.artist, ti: body.title, ts: body.timestamp ?? null, r: 'no-match' });
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
  // .select() so we can tell an INSERT (row returned) from a deduped no-op
  // (ON CONFLICT DO NOTHING returns nothing) — the signal the debug log needs.
  const up = await sb.from('extension_scrobbles').upsert(row, {
    onConflict: 'app_user_id,spotify_account,track_id,listened_at',
    ignoreDuplicates: true,
  }).select('id');
  let inserted = !up.error && Array.isArray(up.data) && up.data.length > 0;
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
    inserted = true;
  }

  // Log campaign-track plays only (skip the high-volume generic solo_/bp_group
  // buckets) so the ring buffer stays focused on what we're diagnosing.
  if (CAMPAIGN_IDS.has(trackId)) {
    await debugLog({ t: Date.now(), id: trackId, a: row.artist, ti: row.title, acct: row.spotify_account, la: listenedAt, r: inserted ? 'insert' : 'dup' });
  }

  return res.status(200).json({ ok: true, counted: true, trackId, deduped: !inserted });
}

// NOTE — leaderboard wiring (do this deliberately, it touches production):
// To make these show on the leaderboard, refreshUser() in api/cron-scrobbles.js
// (and the client submission path in api/leaderboard.js) must add, for each
// profile, the count of extension_scrobbles rows in the current day/week window
// per track_id — treated as its own 'extension' source so it doesn't double
// count with a Last.fm link of the same account.
