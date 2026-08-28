const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const MUSICAT_BASE     = 'https://api.musicat.fm/v1';
const BLACKPINK_ARTIST = 'b88d8d75-b62c-489b-80a5-4e455157edb1';
const MEMBER_ARTIST_IDS = {
  rose:   '1c2b9c70-2eea-4617-b1b0-d839582ef98f',
  lisa:   'b2962140-c2b8-4bdf-b108-86dedc4ba983',
  jennie: '88b78015-73ec-4427-8e83-f7b57c070706',
  jisoo:  '0a098f13-dab1-496f-b84b-de036e57791c',
};
const TRACK_IDS = {
  jump:        '502a16cf-fa8a-4fd3-a184-dbd49c10ce5f',
  shutdown:    '3420a915-4654-4251-9c5b-43039ca74b66',
  ddududu:     '736f62c7-066c-4dd1-853c-c5cf5934b642',
  go:          'c7a5de0d-211d-473b-a85d-024accb1e092',
  ltal:        '8b627a61-8507-4f65-9d21-987679d35cc3',
  fallenangel: '989c9b5e-748f-4551-bc2d-71605097fc38',
  heaven:      '1acde8de-f00c-433e-acd5-7a1269eb5399',
};
// Musicat per-track ids fetched for every profile (all-time + today).
const MC_TRACKS = ['jump', 'shutdown', 'ddududu', 'go', 'ltal', 'fallenangel', 'heaven'];
const MC_HEADERS = { 'Authorization': 'Bearer empty', 'Content-Type': 'application/json' };

const SP_TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

// Substrings marking a track as an alternate VERSION (JP / live / remix / etc.).
// Only used to choose which entry survives a merge collapse — the non-version
// "original" is kept so the deduped list keeps clean names.
const _VERSION_HINTS = [
  'japanese version', 'jp ver', '- live', 'live (', '(remix', '- remix',
  'remix version', 'acoustic', 'tokyo dome', 'arena tour', 'osaka', 'seoul',
  '- 0.5x', '- 2x', '- bare', '- unveiled', 'instrumental', 'a cappella',
  'slowed', 'sped up', 'extended', 'sam feldt', 'special final',
];
const _isVersionName = n => { n = (n || '').toLowerCase(); return _VERSION_HINTS.some(h => n.includes(h)); };

// Spotify periodically "combines" alternate versions into their original: every
// merged track ID then returns the SAME combined play count. Counting all of them
// triples the same streams. This keeps EVERY version visible in the list (for
// transparency) but tags the duplicates with `merged_into` so the UI shows a
// "currently merged into …" disclaimer instead of the repeated number, and the
// stream figure counts only once. The non-version "original" is the survivor and
// keeps the real count. Self-heals if Spotify re-splits them (counts diverge → no
// group → tags cleared).
function annotateMergedTracks(tracks, mergeMin = 1_000_000) {
  const groups = new Map();
  for (const t of tracks) {
    delete t.merged_into;
    if (t.streams == null || t.streams < mergeMin) continue;
    if (!groups.has(t.streams)) groups.set(t.streams, []);
    groups.get(t.streams).push(t);
  }
  for (const grp of groups.values()) {
    if (grp.length < 2) continue;
    grp.sort((a, b) => (_isVersionName(a.name) - _isVersionName(b.name)) || (a.name.length - b.name.length) || a.name.localeCompare(b.name));
    const survivor = grp[0];
    for (let i = 1; i < grp.length; i++) {
      grp[i].merged_into = survivor.name;         // duplicate — shown with disclaimer, not counted
      grp[i].combined_streams = grp[i].streams;   // keep the raw number for reference/tooltip
    }
  }
  return tracks;
}

// Group tracks that share an identical (large) value in `field` — an equal-count
// group is a Spotify-merged set. Returns [{ value, names:[...], survivor }].
function _mergeGroups(tracks, field, mergeMin = 1_000_000) {
  const by = new Map();
  for (const t of tracks) {
    const v = t[field];
    if (v == null || v < mergeMin) continue;
    if (!by.has(v)) by.set(v, []);
    by.get(v).push(t.name);
  }
  const out = [];
  for (const [value, names] of by) {
    if (names.length < 2) continue;
    const sorted = names.slice().sort((a, b) => (_isVersionName(a) - _isVersionName(b)) || (a.length - b.length) || a.localeCompare(b));
    out.push({ value, names: sorted.slice().sort(), survivor: sorted[0] });
  }
  return out;
}

// Compare today's merged groups (by latest streams) against yesterday's (by the
// previous day's streams) to surface merge/split transitions for the on-page note.
function detectMergeChanges(tracks) {
  const cur = _mergeGroups(tracks, 'streams');
  const prev = _mergeGroups(tracks, 'prev_streams');
  const keyOf = g => g.names.join(' | ');
  const prevKeys = new Set(prev.map(keyOf));
  const curKeys = new Set(cur.map(keyOf));
  return {
    merged_count: tracks.filter(t => t.merged_into).length,
    groups: cur.map(g => ({ survivor: g.survivor, versions: g.names })),
    newly_merged: cur.filter(g => !prevKeys.has(keyOf(g))).map(g => ({ survivor: g.survivor, versions: g.names })),
    newly_split: prev.filter(g => !curKeys.has(keyOf(g))).map(g => ({ versions: g.names })),
  };
}

// ── 2026 Streams Gained board ──────────────────────────────────────────────
// We only began tracking in July 2026, so there is no real Jan-1 total. Instead
// we anchor each artist to the BPxSpotify community post — their "gained in 2026
// so far" as of YEAR_SEED_DATE — and then advance it purely by our own daily
// deltas: gained = seed + (latest total − the total on YEAR_SEED_DATE). That sums
// every day after the seed date onto the seed automatically, so a new daily row
// (e.g. Aug 26) lifts the 2026 figure by exactly that day's delta. Self-correcting
// vs. the absolute total, and it can't silently drift out of the anchor date.
const YEAR_BASELINE_KEY = 'bu_year_baseline_2026'; // legacy Redis anchor — fallback only
// BPxSpotify "Streams gained in 2026 (so far)", as of YEAR_SEED_DATE.
const YEAR_SEED_DATE = '2026-08-23';
const YEAR_SEED_GAINED = {
  '250b0Wlc5Vk0CoUsaCY84M': 1_932_681_024, // JENNIE
  '41MozSoPIsD1dJM0CLPjZF': 1_353_380_104, // BLACKPINK
  '3eVa5w3URK5duf6eyVDbu9':   859_280_327, // ROSÉ
  '5L1lO4eRHmJ7a0Q6csE5cT':   651_610_230, // LISA
  '6UZ0ba50XreR4TM8u322gs':   202_825_379, // JISOO
};

async function fetchArtistTotals() {
  const r = await sbFetch(
    '/tracked_artists?active=eq.true&select=spotify_artist_id,name,avatar_url,' +
    'artist_daily_stats(date,total_streams,daily_delta)&artist_daily_stats.order=date.desc&artist_daily_stats.limit=1',
    { headers: { Accept: 'application/json' } },
  );
  if (!r.ok) return [];
  const rows = await r.json();
  return rows.map(a => ({
    id: a.spotify_artist_id, name: a.name, avatar_url: a.avatar_url,
    total: a.artist_daily_stats?.[0]?.total_streams ?? null,
    delta: a.artist_daily_stats?.[0]?.daily_delta ?? null,
    date:  a.artist_daily_stats?.[0]?.date ?? null,
  }));
}

// Each artist's total_streams on YEAR_SEED_DATE (the anchor day), keyed by Spotify id.
async function fetchAnchorTotals() {
  const r = await sbFetch(
    `/artist_daily_stats?date=eq.${YEAR_SEED_DATE}&select=artist_id,total_streams`,
    { headers: { Accept: 'application/json' } },
  );
  if (!r.ok) return {};
  const rows = await r.json();
  const map = {};
  for (const row of rows) map[row.artist_id] = row.total_streams;
  return map;
}

// gained = seed + (latest total − anchor-day total). Falls back to the legacy
// Redis baseline only if the anchor-day row is missing.
function computeYearGained(spotifyId, latestTotal, anchors, baselines) {
  const seed = YEAR_SEED_GAINED[spotifyId];
  const anchor = anchors ? anchors[spotifyId] : null;
  if (seed != null && latestTotal != null && anchor != null) {
    return Math.max(0, seed + (latestTotal - anchor));
  }
  const base = baselines ? baselines[spotifyId] : null;
  if (base != null && latestTotal != null) return Math.max(0, latestTotal - base);
  return null;
}

async function statsPost(body) {
  const r = await fetch(`${MUSICAT_BASE}/history/stats`, {
    method: 'POST', headers: MC_HEADERS,
    body: JSON.stringify({ ...body, metrics: ['total_streams'], withDeltas: false }),
  });
  if (!r.ok) return 0;
  const d = await r.json();
  return Number(d?.total_streams ?? d?.totalStreams ?? d?.count ?? 0);
}

async function sbFetch(path, { headers: extraHeaders, ...restOptions } = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey':        SUPABASE_SERVICE_KEY,
      'Content-Type':  'application/json',
      ...extraHeaders,
    },
    ...restOptions,
  });
}

async function getSpotifyToken() {
  const r = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } },
  );
  if (!r.ok) throw new Error(`Spotify token: ${r.status}`);
  const d = await r.json();
  if (!d.accessToken) throw new Error('accessToken missing');
  return d.accessToken;
}

async function fetchSpotifyPlayCount(token, trackId) {
  try {
    const variables  = JSON.stringify({ uri: `spotify:track:${trackId}` });
    const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42' } });
    const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`partner ${r.status}`);
    const d = await r.json();
    const count = d?.data?.trackUnion?.playcount;
    if (!count) throw new Error('no playcount in response');
    return Number(count);
  } catch {
    const r = await fetch(`https://open.spotify.com/track/${trackId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!r.ok) throw new Error(`scrape ${r.status}`);
    const html = await r.text();
    const m = html.match(/"playCount":"(\d+)"/i);
    if (!m) throw new Error('playCount not found in HTML');
    return Number(m[1]);
  }
}

async function fetchSpotifyArtworkUrl(trackId) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // Try 1: oEmbed API — official, public, no auth required
  try {
    const r = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent('https://open.spotify.com/track/' + trackId)}`,
      { headers: { 'User-Agent': UA } },
    );
    if (r.ok) {
      const d = await r.json();
      if (d.thumbnail_url) return d.thumbnail_url;
    }
  } catch {}

  // Try 2: Partner API persisted query
  try {
    const token = await getSpotifyToken();
    const variables  = JSON.stringify({ uri: `spotify:track:${trackId}` });
    const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42' } });
    const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA } });
    if (r.ok) {
      const d = await r.json();
      const sources = d?.data?.trackUnion?.albumOfTrack?.coverArt?.sources ?? [];
      const best = sources.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
      if (best) return best;
    }
  } catch {}

  // Try 3: Scrape og:image from track page
  try {
    const r = await fetch(`https://open.spotify.com/track/${trackId}`, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
      if (m) return m[1];
    }
  } catch {}

  return null;
}

// ── Official Spotify "Top Artists" charts (charts.spotify.com) ─────────────
// This calls charts-spotify-com-service.spotify.com, which Spotify's anti-bot
// layer blocks from GitHub Actions IP ranges but not Vercel's -- hence this
// lives here rather than in a .github/scripts fetch job. Needs a real
// account's long-lived `sp_dc` session cookie (SPOTIFY_SP_DC env var) to mint
// a non-anonymous access token; a plain anonymous token (like getSpotifyToken()
// above returns) is not accepted by this particular service.
const CHARTS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CHARTS_TRACKED_ARTISTS = {
  '41MozSoPIsD1dJM0CLPjZF': 'BLACKPINK',
  '6UZ0ba50XreR4TM8u322gs': 'JISOO',
  '250b0Wlc5Vk0CoUsaCY84M': 'JENNIE',
  '3eVa5w3URK5duf6eyVDbu9': 'ROSÉ',
  '5L1lO4eRHmJ7a0Q6csE5cT': 'LISA',
};

async function getChartsAuthToken() {
  const spDc = process.env.SPOTIFY_SP_DC;
  if (!spDc) throw new Error('SPOTIFY_SP_DC not set');
  const r = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
    headers: { 'User-Agent': CHARTS_UA, Cookie: `sp_dc=${spDc}` },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`token mint failed: HTTP ${r.status} -- ${body.slice(0, 200)}`);
  }
  const d = await r.json();
  if (d.isAnonymous !== false) throw new Error('sp_dc cookie did not authenticate a real account (isAnonymous truthy)');
  if (!d.accessToken) throw new Error('no accessToken in token response');
  return d.accessToken;
}

async function fetchOfficialArtistChart(token, chartType, country) {
  const alias = `artist-${country.toLowerCase()}-${chartType}`;
  const r = await fetch(`https://charts-spotify-com-service.spotify.com/auth/v0/charts/${alias}/latest`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'App-Platform': 'Browser', 'User-Agent': CHARTS_UA },
  });
  if (!r.ok) return { ok: false, status: r.status, alias };
  const data = await r.json();
  return { ok: true, alias, data };
}

async function storeGlobalSnapshot(date, jumpTotal, shutdownTotal, ddududuTotal) {
  const prevRes = await sbFetch(
    `/global_stream_snapshots?date=lt.${date}&order=date.desc&limit=1&select=jump_total,shutdown_total,ddududu_total`,
    { headers: { Accept: 'application/json' } },
  );
  const prev = prevRes.ok ? (await prevRes.json())[0] ?? null : null;

  const jumpDaily     = prev ? jumpTotal     - prev.jump_total     : null;
  const shutdownDaily = prev ? shutdownTotal - prev.shutdown_total : null;
  const ddududuDaily  = prev ? ddududuTotal  - prev.ddududu_total  : null;

  const insertRes = await sbFetch('/global_stream_snapshots', {
    method:  'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ date, jump_total: jumpTotal, shutdown_total: shutdownTotal, ddududu_total: ddududuTotal, jump_daily: jumpDaily, shutdown_daily: shutdownDaily, ddududu_daily: ddududuDaily }),
  });
  if (!insertRes.ok) {
    const errBody = await insertRes.text();
    throw new Error(`Supabase insert ${insertRes.status}: ${errBody}`);
  }

  const nextRes = await sbFetch(
    `/global_stream_snapshots?date=gt.${date}&order=date.asc&limit=1&select=date,jump_total,shutdown_total,ddududu_total`,
    { headers: { Accept: 'application/json' } },
  );
  const next = nextRes.ok ? (await nextRes.json())[0] ?? null : null;
  if (next) {
    await sbFetch(`/global_stream_snapshots?date=eq.${next.date}`, {
      method: 'PATCH',
      body: JSON.stringify({
        jump_daily:     next.jump_total     - jumpTotal,
        shutdown_daily: next.shutdown_total - shutdownTotal,
        ddududu_daily:  next.ddududu_total  - ddududuTotal,
      }),
    });
  }
}

async function upstashGet(key) {
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const d = await r.json();
  if (d.result === null || d.result === undefined) return null;
  try { return JSON.parse(d.result); } catch { return d.result; }
}

async function upstashSet(key, value) {
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, JSON.stringify(value)]]),
  });
}

// SET with an expiry, for the Musicat stale-while-error cache below.
async function upstashSetEx(key, value, ttlSeconds) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]]),
    });
  } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ?global_milestones=list (public) ──────────────────────��───────────
  if (req.query.global_milestones === 'list') {
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(200).json({ milestones: [] });
    try {
      const milestones = await upstashGet('bu_global_milestones_list');
      return res.status(200).json({ milestones: Array.isArray(milestones) ? milestones : [] });
    } catch { return res.status(200).json({ milestones: [] }); }
  }

  // ── GET ?global_milestones=save (admin) ───────────────────────────────────
  if (req.query.global_milestones === 'save') {
    const adminSecret = process.env.ADMIN_SECRET;
    const key = req.headers['x-admin-secret'] || req.query.key;
    if (!adminSecret || key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis not configured' });
    const { track, milestone, total, date, art } = req.query;
    if (!track || !milestone || !total) return res.status(400).json({ error: 'Required: track, milestone, total' });
    const msNum    = Number(milestone);
    const totalNum = Number(String(total).replace(/[^0-9]/g, ''));
    if (!msNum || !totalNum) return res.status(400).json({ error: 'Invalid milestone or total' });
    const trackId = track.toUpperCase();
    const id      = `${trackId}_${msNum}`;
    // If art param looks like a bare Spotify track ID (22 alphanumeric chars), convert to proxy URL
    let artUrl = art || null;
    if (artUrl && /^[A-Za-z0-9]{22}$/.test(artUrl)) {
      artUrl = `/api/proxy-image?spotify_art=${artUrl}`;
    }
    const entry = { id, trackId, milestone: msNum, total: totalNum, milestoneDate: date || null, artUrl, savedAt: Date.now() };
    let existing = [];
    try { existing = (await upstashGet('bu_global_milestones_list')) || []; if (!Array.isArray(existing)) existing = []; } catch {}
    const idx = existing.findIndex(m => m.id === id);
    if (idx >= 0) existing[idx] = entry; else existing.push(entry);
    await upstashSet('bu_global_milestones_list', existing);
    return res.status(200).json({ ok: true, id, count: existing.length });
  }

  // ── GET ?artist_charts=list (public) ────────────────────────────────────────
  if (req.query.artist_charts === 'list') {
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(200).json({ entries: [] });
    try {
      const entries = await upstashGet('bu_artist_charts');
      return res.status(200).json({ entries: Array.isArray(entries) ? entries : [] });
    } catch { return res.status(200).json({ entries: [] }); }
  }

  // ── POST ?artist_charts=save (admin) ─────────────────────────────────────────
  if (req.query.artist_charts === 'save') {
    const adminSecret = process.env.ADMIN_SECRET;
    const key = req.headers['x-admin-secret'] || req.query.key;
    if (!adminSecret || key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis not configured' });
    const { artist, position, change, chartName, region, date, art } = req.query;
    if (!artist || !position) return res.status(400).json({ error: 'artist and position required' });
    const pos = parseInt(position, 10);
    if (!pos || pos < 1) return res.status(400).json({ error: 'Invalid position' });
    const artistUp   = artist.trim().toUpperCase();
    const chartStr   = (chartName || 'Top Artists').trim();
    const regionStr  = (region || 'Global').trim();
    const id = `${artistUp}_${regionStr.toUpperCase().replace(/\s+/g, '_')}_${chartStr.toUpperCase().replace(/\s+/g, '_')}`;
    let artUrl = art || null;
    if (artUrl && /^[A-Za-z0-9]{22}$/.test(artUrl)) artUrl = `/api/proxy-image?spotify_art=${artUrl}`;
    const entry = {
      id, artist: artistUp, position: pos,
      change: change !== undefined && change !== '' ? parseInt(change, 10) : null,
      chartName: chartStr, region: regionStr,
      artUrl: artUrl || null,
      date: date || null, savedAt: Date.now(),
    };
    let existing = [];
    try { existing = (await upstashGet('bu_artist_charts')) || []; if (!Array.isArray(existing)) existing = []; } catch {}
    const idx = existing.findIndex(e => e.id === id);
    if (idx >= 0) existing[idx] = entry; else existing.push(entry);
    await upstashSet('bu_artist_charts', existing);
    return res.status(200).json({ ok: true, id, count: existing.length });
  }

  // ── POST ?artist_charts=delete (admin) ───────────────────────────────────────
  if (req.query.artist_charts === 'delete') {
    const adminSecret = process.env.ADMIN_SECRET;
    const key = req.headers['x-admin-secret'] || req.query.key;
    if (!adminSecret || key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis not configured' });
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    let existing = [];
    try { existing = (await upstashGet('bu_artist_charts')) || []; if (!Array.isArray(existing)) existing = []; } catch {}
    const filtered = existing.filter(e => e.id !== id);
    await upstashSet('bu_artist_charts', filtered);
    return res.status(200).json({ ok: true, count: filtered.length });
  }

  // ── GET ?ltal_goals=list (public) — campaign-goal checkmarks + meta ─────────
  if (req.query.ltal_goals === 'list') {
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(200).json({ reached: {}, yt_mv_views: null, countries: null });
    try {
      const stored = await upstashGet('bu_ltal_goals');
      const obj = (stored && typeof stored === 'object') ? stored : {};
      return res.status(200).json({
        reached:           obj._reached && typeof obj._reached === 'object' ? obj._reached : obj,
        values:            obj._values && typeof obj._values === 'object' ? obj._values : {},
        yt_mv_views:       obj._yt_mv_views       || null,
        yt_24h_views:      obj._yt_24h_views       || null,
        countries:         Array.isArray(obj._countries) ? obj._countries : null,
        ltal_24h_official: obj._ltal_24h_official  || null,
      });
    } catch { return res.status(200).json({ reached: {}, yt_mv_views: null, countries: null }); }
  }

  // ── LTAL goals admin actions (all require admin key) ─────────────────────────
  if (req.query.ltal_goals) {
    const adminSecret = process.env.ADMIN_SECRET;
    const key = req.headers['x-admin-secret'] || req.query.key;
    if (!adminSecret || key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(500).json({ error: 'Redis not configured' });

    let stored = {};
    try { stored = (await upstashGet('bu_ltal_goals')) || {}; if (typeof stored !== 'object') stored = {}; } catch {}
    // Migrate flat {goalId: bool} → new shape { _reached:{}, _yt_mv_views:'', _countries:[] }
    if (!stored._reached) {
      const legacyReached = {};
      for (const [k, v] of Object.entries(stored)) {
        if (!k.startsWith('_')) legacyReached[k] = v;
      }
      stored = { _reached: legacyReached, _yt_mv_views: stored._yt_mv_views || null, _countries: stored._countries || null };
    }

    // toggle — mark/unmark a goal as reached
    if (req.query.ltal_goals === 'toggle') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      stored._reached[id] = !stored._reached[id];
      await upstashSet('bu_ltal_goals', stored);
      return res.status(200).json({ ok: true, id, reached: stored._reached });
    }

    // set_yt_views — update the current YouTube MV view count string
    if (req.query.ltal_goals === 'set_yt_views') {
      const views = (req.query.views || '').trim();
      if (!views) return res.status(400).json({ error: 'views required' });
      stored._yt_mv_views = views;
      await upstashSet('bu_ltal_goals', stored);
      return res.status(200).json({ ok: true, yt_mv_views: views });
    }

    // set_yt_24h_views — store the frozen view count at the 24H mark
    if (req.query.ltal_goals === 'set_yt_24h_views') {
      const views = (req.query.views || '').trim();
      if (!views) return res.status(400).json({ error: 'views required' });
      stored._yt_24h_views = views;
      await upstashSet('bu_ltal_goals', stored);
      return res.status(200).json({ ok: true, yt_24h_views: views });
    }

    // set_24h_official — store the total fandom 24H Spotify stream count
    if (req.query.ltal_goals === 'set_24h_official') {
      const count = parseInt((req.query.count || '').replace(/[^0-9]/g, ''), 10);
      if (!count || count < 1) return res.status(400).json({ error: 'valid count required' });
      stored._ltal_24h_official = count;
      await upstashSet('bu_ltal_goals', stored);
      return res.status(200).json({ ok: true, ltal_24h_official: count });
    }

    // add_country — append a country to the iTunes #1 list
    if (req.query.ltal_goals === 'add_country') {
      const flag = (req.query.flag || '').trim();
      const name = (req.query.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!Array.isArray(stored._countries)) stored._countries = [];
      if (!stored._countries.some(c => c.name.toLowerCase() === name.toLowerCase())) {
        stored._countries.push({ flag, name });
      }
      await upstashSet('bu_ltal_goals', stored);
      return res.status(200).json({ ok: true, countries: stored._countries });
    }

    // remove_country — remove a country from the iTunes #1 list
    if (req.query.ltal_goals === 'remove_country') {
      const name = (req.query.name || '').trim();
      if (!Array.isArray(stored._countries)) stored._countries = [];
      stored._countries = stored._countries.filter(c => c.name.toLowerCase() !== name.toLowerCase());
      await upstashSet('bu_ltal_goals', stored);
      return res.status(200).json({ ok: true, countries: stored._countries });
    }

    // set_countries — replace the full iTunes #1 countries list at once
    if (req.query.ltal_goals === 'set_countries') {
      let countries;
      try { countries = JSON.parse(req.query.countries || '[]'); } catch { countries = []; }
      if (!Array.isArray(countries)) return res.status(400).json({ error: 'countries must be a JSON array' });
      stored._countries = countries.filter(c => c && typeof c.name === 'string');
      await upstashSet('bu_ltal_goals', stored);
      return res.status(200).json({ ok: true, countries: stored._countries });
    }

    // set_value — record the achieved value/detail for a goal (e.g. "6.7M", "US, UK, JP")
    if (req.query.ltal_goals === 'set_value') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!stored._values || typeof stored._values !== 'object') stored._values = {};
      const value = (req.query.value || '').trim();
      if (value) stored._values[id] = value; else delete stored._values[id];
      await upstashSet('bu_ltal_goals', stored);
      return res.status(200).json({ ok: true, id, value, values: stored._values });
    }

    return res.status(400).json({ error: 'unknown ltal_goals action' });
  }

  // ── GET ?jennie_save=count|increment — "Less Than a Lover" save counter ────
  // ── GET ?fa_save=count|increment    — "Fallen Angel" (EP) save counter ─────
  // ── GET ?lisa_save=count|increment  — LISA "hellosawadika" join counter ────
  // ── GET ?jisoo_save=count|increment — JISOO "CLICK" pre-save counter ───────
  // Same simple Upstash INCR counter, one distinct key per campaign.
  if (req.query.jennie_save === 'count' || req.query.jennie_save === 'increment' ||
      req.query.fa_save === 'count'     || req.query.fa_save === 'increment' ||
      req.query.lisa_save === 'count'   || req.query.lisa_save === 'increment' ||
      req.query.jisoo_save === 'count'  || req.query.jisoo_save === 'increment') {
    if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(200).json({ count: 0 });
    const campaign = req.query.jisoo_save != null ? 'jisoo'
                   : req.query.lisa_save != null ? 'lisa'
                   : req.query.fa_save   != null ? 'fa'
                   : 'ltal';
    const action = req.query.jisoo_save ?? req.query.lisa_save ?? req.query.fa_save ?? req.query.jennie_save;
    const KEY = campaign === 'jisoo' ? 'bu_jisoo_click_saves'
              : campaign === 'lisa' ? 'bu_lisa_sawadika_joins'
              : campaign === 'fa'   ? 'bu_jennie_fallenangel_saves'
              : 'bu_jennie_ltal_saves';
    try {
      if (action === 'increment') {
        const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/incr/${KEY}`, {
          headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
        });
        const d = await r.json();
        return res.status(200).json({ count: Number(d.result) || 0 });
      }
      const count = await upstashGet(KEY);
      return res.status(200).json({ count: Number(count) || 0 });
    } catch { return res.status(200).json({ count: 0 }); }
  }

  // ── POST: global stream backfill (admin only) ──────────────────────────────
  if (req.method === 'POST') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.headers['x-admin-secret'] !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { date, jump_total, shutdown_total, ddududu_total } = req.body ?? {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || jump_total == null || shutdown_total == null || ddududu_total == null) {
      return res.status(400).json({ error: 'Required: date (YYYY-MM-DD), jump_total, shutdown_total, ddududu_total' });
    }
    try {
      await storeGlobalSnapshot(date, Number(jump_total), Number(shutdown_total), Number(ddududu_total));
      return res.status(200).json({ ok: true, date });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET ?year_gained=list (public) — 2026 streams-gained board ─────────────
  if (req.query.year_gained === 'list') {
    try {
      const [baselines, anchors, totals] = await Promise.all([
        upstashGet(YEAR_BASELINE_KEY).then(b => b || {}).catch(() => ({})),
        fetchAnchorTotals(),
        fetchArtistTotals(),
      ]);
      const items = totals
        .map(t => ({ id: t.id, name: t.name, avatar_url: t.avatar_url, total: t.total,
                     delta: t.delta, date: t.date,
                     gained: computeYearGained(t.id, t.total, anchors, baselines) }))
        .filter(t => t.gained != null)
        .sort((a, b) => b.gained - a.gained);
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ year: 2026, items });
    } catch (e) {
      return res.status(200).json({ year: 2026, items: [] });
    }
  }

  // ── GET ?year_gained=seed (admin) — seed Jan-1 baselines from current totals ─
  // baseline = current total − BPx "gained so far", so today's board matches the
  // community post, then advances on its own. Re-runnable (re-anchors to latest).
  if (req.query.year_gained === 'seed') {
    const adminSecret = process.env.ADMIN_SECRET;
    const key = req.headers['x-admin-secret'] || req.query.key;
    if (!adminSecret || key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
    const totals = await fetchArtistTotals();
    const baselines = {}, preview = [];
    for (const t of totals) {
      const gained = YEAR_SEED_GAINED[t.id];
      if (gained == null || t.total == null) continue;
      baselines[t.id] = t.total - gained;
      preview.push({ name: t.name, total: t.total, gained, baseline: baselines[t.id] });
    }
    if (!Object.keys(baselines).length) return res.status(400).json({ error: 'No artist totals found to seed' });
    await upstashSet(YEAR_BASELINE_KEY, baselines);
    return res.status(200).json({ ok: true, preview });
  }

  // ── GET ?artist_streams=list — every tracked artist's latest snapshot ──────
  if (req.query.artist_streams === 'list') {
    const [r, baselines, anchors] = await Promise.all([
      sbFetch(
        '/tracked_artists?active=eq.true&select=spotify_artist_id,name,avatar_url,' +
        'artist_daily_stats(date,total_streams,daily_delta,followers,followers_delta,monthly_listeners,monthly_listeners_delta,world_rank,world_rank_delta,track_count)' +
        '&artist_daily_stats.order=date.desc&artist_daily_stats.limit=1',
        { headers: { Accept: 'application/json' } },
      ),
      upstashGet(YEAR_BASELINE_KEY).then(b => b || {}).catch(() => ({})),
      fetchAnchorTotals(),
    ]);
    if (!r.ok) return res.status(200).json({ artists: [] });
    const rows = await r.json();
    const ARTIST_ORDER = ['BLACKPINK', 'JISOO', 'JENNIE', 'ROSÉ', 'LISA'];
    const artists = rows
      .map(a => {
        const stat = a.artist_daily_stats[0] || {};
        const year_gained = computeYearGained(a.spotify_artist_id, stat.total_streams, anchors, baselines);
        return { id: a.spotify_artist_id, name: a.name, avatarUrl: a.avatar_url, ...stat, year_gained };
      })
      .sort((a, b) => ARTIST_ORDER.indexOf(a.name) - ARTIST_ORDER.indexOf(b.name));
    return res.status(200).json({ artists });
  }

  // ── GET ?artist_streams=detail&artist=<id> — one artist's full page data ───
  if (req.query.artist_streams === 'detail') {
    const artistId = req.query.artist;
    if (!artistId) return res.status(400).json({ error: 'artist required' });

    const [artistRes, historyRes, tracksRes, baselines, anchors] = await Promise.all([
      sbFetch(`/tracked_artists?spotify_artist_id=eq.${artistId}&select=name,avatar_url`, { headers: { Accept: 'application/json' } }),
      sbFetch(`/artist_daily_stats?artist_id=eq.${artistId}&order=date.desc&limit=8&select=date,total_streams,daily_delta,followers,followers_delta,monthly_listeners,monthly_listeners_delta,world_rank,world_rank_delta,track_count`, { headers: { Accept: 'application/json' } }),
      sbFetch(
        `/artist_tracks?artist_id=eq.${artistId}&select=id,name,album,album_release_date,track_number,album_art_url,track_daily_stats(date,streams,daily_delta)` +
        '&track_daily_stats.order=date.desc&track_daily_stats.limit=2',
        { headers: { Accept: 'application/json' } },
      ),
      upstashGet(YEAR_BASELINE_KEY).then(b => b || {}).catch(() => ({})),
      fetchAnchorTotals(),
    ]);
    if (!artistRes.ok || !historyRes.ok || !tracksRes.ok) {
      return res.status(502).json({ error: 'Supabase query failed' });
    }
    const [artistRows, history, trackRows] = await Promise.all([artistRes.json(), historyRes.json(), tracksRes.json()]);
    if (!artistRows.length) return res.status(404).json({ error: 'Artist not tracked' });

    const tracks = trackRows
      .map(t => ({
        name: t.name,
        album: t.album,
        album_release_date: t.album_release_date,
        track_number: t.track_number,
        album_art_url: t.album_art_url,
        ...(t.track_daily_stats[0] || {}),
        prev_daily_delta: t.track_daily_stats[1]?.daily_delta ?? null,
        prev_streams: t.track_daily_stats[1]?.streams ?? null,
      }))
      .sort((a, b) => (b.streams || 0) - (a.streams || 0));

    // Tag Spotify-merged version duplicates so the UI shows a disclaimer instead
    // of the repeated count (matching the deduped total in fetch_artist_streams.py).
    annotateMergedTracks(tracks);
    // Merge/split change-detection: compare today's equal-count groups to
    // yesterday's so the page can announce the moment Spotify merges or splits.
    const merges = detectMergeChanges(tracks);
    const year_gained = computeYearGained(artistId, history[0]?.total_streams ?? null, anchors, baselines);
    return res.status(200).json({ ...artistRows[0], year_gained, history, tracks, merges });
  }

  // ── GET ?charts=list&chart_type=daily|weekly&country=GLOBAL&limit=50 ───────
  // Real per-country Spotify chart positions (BLACKPINK + members), sourced
  // from kworb.net's official-chart mirror via fetch_chart_positions.mjs --
  // NOT our own tracked-catalog streams-gained ranking.
  if (req.query.charts === 'list') {
    const chartType = req.query.chart_type === 'weekly' ? 'weekly' : 'daily';
    const country = (req.query.country || 'GLOBAL').toUpperCase();
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    const latestRes = await sbFetch(
      `/chart_positions?chart_type=eq.${chartType}&country=eq.${country}&select=tracking_date&order=tracking_date.desc&limit=1`,
      { headers: { Accept: 'application/json' } },
    );
    if (!latestRes.ok) return res.status(502).json({ error: 'Supabase query failed' });
    const [latest] = await latestRes.json();
    if (!latest) return res.status(200).json({ chartType, country, trackingDate: null, rows: [] });

    const rowsRes = await sbFetch(
      `/chart_positions?chart_type=eq.${chartType}&country=eq.${country}&tracking_date=eq.${latest.tracking_date}` +
      `&select=spotify_track_id,track_name,primary_artist_name,featured_artists,position,peak_position,` +
      `days_on_chart,streams,streams_change,total_streams,previous_position,position_change,entry_status` +
      `&order=position.asc&limit=${limit}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!rowsRes.ok) return res.status(502).json({ error: 'Supabase query failed' });
    const rows = await rowsRes.json();
    return res.status(200).json({ chartType, country, trackingDate: latest.tracking_date, rows });
  }

  // ── GET ?charts=countries&chart_type=daily|weekly ───────────────────────────
  // Which countries have at least one BLACKPINK/member entry on the most
  // recent tracking_date for this chart type -- powers the "currently
  // charting" highlight in the Charts page's country dropdown.
  if (req.query.charts === 'countries') {
    const chartType = req.query.chart_type === 'weekly' ? 'weekly' : 'daily';

    const latestRes = await sbFetch(
      `/chart_positions?chart_type=eq.${chartType}&select=tracking_date&order=tracking_date.desc&limit=1`,
      { headers: { Accept: 'application/json' } },
    );
    if (!latestRes.ok) return res.status(502).json({ error: 'Supabase query failed' });
    const [latest] = await latestRes.json();
    if (!latest) return res.status(200).json({ chartType, trackingDate: null, countries: [] });

    const rowsRes = await sbFetch(
      `/chart_positions?chart_type=eq.${chartType}&tracking_date=eq.${latest.tracking_date}&select=country`,
      { headers: { Accept: 'application/json' } },
    );
    if (!rowsRes.ok) return res.status(502).json({ error: 'Supabase query failed' });
    const rows = await rowsRes.json();
    const countries = [...new Set(rows.map(r => r.country))];
    return res.status(200).json({ chartType, trackingDate: latest.tracking_date, countries });
  }

  // ── GET ?charts=fetch-artists (cron/admin trigger) ──────────────────────────
  // Fetches REAL per-country/global Spotify "Top Artists" chart positions
  // (official charts.spotify.com data) for BLACKPINK + members and stores them.
  // Runs here (Vercel), not GitHub Actions, because Spotify's anti-bot layer
  // blocks GitHub Actions' IP ranges but not Vercel's.
  if (req.query.charts === 'fetch-artists') {
    const cronSecret = process.env.CRON_SECRET;
    const adminSecret = process.env.ADMIN_SECRET;
    const bearer = req.headers.authorization === `Bearer ${cronSecret}` && cronSecret;
    const adminKey = (req.headers['x-admin-secret'] || req.query.key) === adminSecret && adminSecret;
    if (!bearer && !adminKey) return res.status(401).json({ error: 'Unauthorized' });

    const CHART_COUNTRIES = ['global', 'us', 'gb', 'kr', 'fr', 'de', 'br', 'mx', 'jp', 'au', 'ca'];
    const today = new Date().toISOString().slice(0, 10);

    try {
      const token = await getChartsAuthToken();
      const upsertRows = [];
      const skipped = [];

      for (const chartType of ['daily', 'weekly']) {
        for (const country of CHART_COUNTRIES) {
          const result = await fetchOfficialArtistChart(token, chartType, country);
          if (!result.ok) { skipped.push({ chartType, country, status: result.status }); continue; }

          const entries = result.data?.displayChart?.entries ?? [];
          for (const entry of entries) {
            const uri = entry.artistMetadata?.artistUri || '';
            const artistId = uri.startsWith('spotify:artist:') ? uri.slice('spotify:artist:'.length) : null;
            if (!artistId || !CHARTS_TRACKED_ARTISTS[artistId]) continue;

            const d = entry.chartEntryData;
            upsertRows.push({
              artist_spotify_id: artistId,
              artist_name: CHARTS_TRACKED_ARTISTS[artistId],
              country: country.toUpperCase(),
              chart_type: chartType,
              tracking_date: today,
              current_rank: d.currentRank,
              previous_rank: d.previousRank ?? null,
              peak_rank: d.peakRank ?? null,
              streak: d.appearancesOnChart ?? null,
              entry_status: d.entryStatus ?? null,
              entry_date: d.entryDate ?? null,
              peak_date: d.peakDate ?? null,
              image_url: entry.artistMetadata?.displayImageUri ?? null,
            });
          }
        }
      }

      if (upsertRows.length) {
        const upsertRes = await sbFetch('/artist_chart_positions?on_conflict=artist_spotify_id,country,chart_type,tracking_date', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(upsertRows),
        });
        if (!upsertRes.ok) return res.status(502).json({ error: `Supabase upsert failed: ${await upsertRes.text()}` });
      }

      return res.status(200).json({ ok: true, date: today, upserted: upsertRows.length, skipped });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET ?charts=list-artists&chart_type=daily|weekly&country=GLOBAL ────────
  // Real per-country/global Spotify Top Artists chart positions (BLACKPINK +
  // members), sourced from the official charts.spotify.com data above.
  if (req.query.charts === 'list-artists') {
    const chartType = req.query.chart_type === 'weekly' ? 'weekly' : 'daily';
    const country = (req.query.country || 'GLOBAL').toUpperCase();

    const latestRes = await sbFetch(
      `/artist_chart_positions?chart_type=eq.${chartType}&country=eq.${country}&select=tracking_date&order=tracking_date.desc&limit=1`,
      { headers: { Accept: 'application/json' } },
    );
    if (!latestRes.ok) return res.status(502).json({ error: 'Supabase query failed' });
    const [latest] = await latestRes.json();
    if (!latest) return res.status(200).json({ chartType, country, trackingDate: null, rows: [] });

    const rowsRes = await sbFetch(
      `/artist_chart_positions?chart_type=eq.${chartType}&country=eq.${country}&tracking_date=eq.${latest.tracking_date}` +
      `&select=artist_spotify_id,artist_name,current_rank,previous_rank,peak_rank,streak,entry_status,entry_date,peak_date,image_url` +
      `&order=current_rank.asc`,
      { headers: { Accept: 'application/json' } },
    );
    if (!rowsRes.ok) return res.status(502).json({ error: 'Supabase query failed' });
    const rows = await rowsRes.json();
    return res.status(200).json({ chartType, country, trackingDate: latest.tracking_date, rows });
  }

  // ── GET ?artist_streams=csv[&scope=tracks] (admin) — daily history CSV ─────
  if (req.query.artist_streams === 'csv') {
    const adminSecret = process.env.ADMIN_SECRET;
    const key = req.headers['x-admin-secret'] || req.query.key;
    if (!adminSecret || key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });

    const ARTIST_ORDER = ['BLACKPINK', 'JISOO', 'JENNIE', 'ROSÉ', 'LISA'];
    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const toCsv = (header, rows) => [header.join(',')]
      .concat(rows.map(r => header.map(h => esc(r[h])).join(',')))
      .join('\n');

    if (req.query.scope === 'tracks') {
      // Every track this tracker follows for each artist (113 for BLACKPINK,
      // 12 for JISOO, 40 for JENNIE, 18 for ROSÉ, 31 for LISA), one row per
      // track per day -- this list *is* "the ones we track", there's no
      // separate untracked set to distinguish it from.
      const [artistsRes, tracksRes] = await Promise.all([
        sbFetch('/tracked_artists?select=spotify_artist_id,name', { headers: { Accept: 'application/json' } }),
        sbFetch(
          '/artist_tracks?select=id,artist_id,name,album,track_daily_stats(date,streams,daily_delta)',
          { headers: { Accept: 'application/json' } },
        ),
      ]);
      if (!artistsRes.ok || !tracksRes.ok) return res.status(502).json({ error: 'Supabase query failed' });
      const [artists, trackRows] = await Promise.all([artistsRes.json(), tracksRes.json()]);
      const nameById = Object.fromEntries(artists.map(a => [a.spotify_artist_id, a.name]));

      const rows = [];
      for (const t of trackRows) {
        const artist = nameById[t.artist_id] || t.artist_id;
        for (const d of t.track_daily_stats) {
          rows.push({ artist, album: t.album || '', track: t.name, date: d.date, streams: d.streams, daily_delta: d.daily_delta });
        }
      }
      rows.sort((a, b) =>
        (ARTIST_ORDER.indexOf(a.artist) - ARTIST_ORDER.indexOf(b.artist)) ||
        a.album.localeCompare(b.album) ||
        a.track.localeCompare(b.track) ||
        a.date.localeCompare(b.date));

      const csv = toCsv(['artist', 'album', 'track', 'date', 'streams', 'daily_delta'], rows);
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="track_streams_${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.end(csv);
    }

    const [artistsRes, statsRes] = await Promise.all([
      sbFetch('/tracked_artists?select=spotify_artist_id,name', { headers: { Accept: 'application/json' } }),
      sbFetch(
        '/artist_daily_stats?select=artist_id,date,total_streams,daily_delta,followers,followers_delta,monthly_listeners,monthly_listeners_delta,world_rank,world_rank_delta,track_count&order=artist_id.asc,date.asc',
        { headers: { Accept: 'application/json' } },
      ),
    ]);
    if (!artistsRes.ok || !statsRes.ok) return res.status(502).json({ error: 'Supabase query failed' });
    const [artists, stats] = await Promise.all([artistsRes.json(), statsRes.json()]);
    const nameById = Object.fromEntries(artists.map(a => [a.spotify_artist_id, a.name]));

    const rows = stats
      .map(s => ({ ...s, artist: nameById[s.artist_id] || s.artist_id }))
      .sort((a, b) => (ARTIST_ORDER.indexOf(a.artist) - ARTIST_ORDER.indexOf(b.artist)) || a.date.localeCompare(b.date));

    const csv = toCsv(['artist', 'date', 'total_streams', 'daily_delta', 'followers', 'followers_delta', 'monthly_listeners', 'monthly_listeners_delta', 'world_rank', 'world_rank_delta', 'track_count'], rows);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="artist_streams_${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.end(csv);
  }

  // ── GET ?global_streams=history ───────────────────────────────────────────
  if (req.query.global_streams === 'history') {
    const limit = Math.min(Number(req.query.limit ?? 30), 365);
    const r = await sbFetch(
      `/global_stream_snapshots?order=date.desc&limit=${limit}&select=date,jump_total,shutdown_total,ddududu_total,jump_daily,shutdown_daily,ddududu_daily`,
      { headers: { Accept: 'application/json' } },
    );
    return res.status(200).json({ data: r.ok ? await r.json() : [] });
  }

  // ── GET ?global_streams=cron (cron trigger) ─────────────────────────────
  if (req.query.global_streams === 'cron') {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      // Spotify publishes yesterday's stream count today, so label the entry
      // with the actual streaming day (yesterday), not the fetch day.
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      const streamDate = d.toISOString().split('T')[0];
      const token = await getSpotifyToken();
      const [jumpTotal, shutdownTotal, ddududuTotal] = await Promise.all([
        fetchSpotifyPlayCount(token, SP_TRACKS.jump),
        fetchSpotifyPlayCount(token, SP_TRACKS.shutdown),
        fetchSpotifyPlayCount(token, SP_TRACKS.ddududu),
      ]);
      await storeGlobalSnapshot(streamDate, jumpTotal, shutdownTotal, ddududuTotal);
      return res.status(200).json({ ok: true, date: streamDate, jump: jumpTotal, shutdown: shutdownTotal, ddududu: ddududuTotal });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET ?global_streams=migrate (one-time Redis→Supabase history migration) ─
  if (req.query.global_streams === 'migrate') {
    const adminSecret = process.env.ADMIN_SECRET;
    const providedSecret = req.headers['x-admin-secret'] || req.query.key;
    if (!adminSecret || providedSecret !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
      return res.status(500).json({ error: 'Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN' });
    }
    async function rGet(key) {
      const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      const d = await r.json();
      if (d.result === null || d.result === undefined) return null;
      try { return JSON.parse(d.result); } catch { return d.result; }
    }
    const [histJump, histSD, histDDU, prevJump, prevSD, prevDDU] = await Promise.all([
      rGet('bp_hist_jump'), rGet('bp_hist_shutdown'), rGet('bp_hist_ddududu'),
      rGet('bp_prev_jump'), rGet('bp_prev_shutdown'), rGet('bp_prev_ddududu'),
    ]);
    // Reconstruct cumulative totals working backwards from latest bp_prev snapshot.
    // History entry {date: D, streams: S} means snapshot(D+1) - snapshot(D) = S,
    // so snapshot(D) = snapshot(D+1) - S. bp_prev holds the most recent snapshot.
    function reconstructTotals(history, prev) {
      if (!history?.length || !prev) return {};
      const sorted = [...history].sort((a, b) => {
        const [ad, am] = a.date.split('/').map(Number);
        const [bd, bm] = b.date.split('/').map(Number);
        return (bm * 100 + bd) - (am * 100 + ad);
      });
      const totals = {};
      let running = prev.total;
      totals[prev.date] = prev.total;
      for (const entry of sorted) {
        running -= entry.streams;
        totals[entry.date] = running;
      }
      return totals;
    }
    const jumpTotals = reconstructTotals(histJump, prevJump);
    const sdTotals   = reconstructTotals(histSD,   prevSD);
    const dduTotals  = reconstructTotals(histDDU,  prevDDU);
    function toISO(ddmm) {
      const [dd, mm] = ddmm.split('/').map(Number);
      return `2026-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    }
    const allDDMM = new Set([...Object.keys(jumpTotals), ...Object.keys(sdTotals), ...Object.keys(dduTotals)]);
    const rows = [];
    for (const ddmm of allDDMM) {
      const jt = jumpTotals[ddmm], st = sdTotals[ddmm], dt = dduTotals[ddmm];
      if (!jt || !st || !dt) continue;
      rows.push({ _ddmm: ddmm, date: toISO(ddmm), jump_total: jt, shutdown_total: st, ddududu_total: dt });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < rows.length; i++) {
      rows[i].jump_daily     = i === 0 ? null : rows[i].jump_total     - rows[i-1].jump_total;
      rows[i].shutdown_daily = i === 0 ? null : rows[i].shutdown_total - rows[i-1].shutdown_total;
      rows[i].ddududu_daily  = i === 0 ? null : rows[i].ddududu_total  - rows[i-1].ddududu_total;
    }
    const insertPayload = rows.map(({ _ddmm, ...r }) => r);
    const insertRes = await sbFetch('/global_stream_snapshots', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify(insertPayload),
    });
    if (!insertRes.ok) {
      const errBody = await insertRes.text();
      return res.status(500).json({ error: `Supabase insert failed: ${errBody}` });
    }
    // Patch any pre-existing rows whose daily is null but predecessor now exists in batch
    const totalsMap = {};
    for (const r of rows) totalsMap[r.date] = r;
    const nullRes = await sbFetch(
      '/global_stream_snapshots?jump_daily=is.null&select=date,jump_total,shutdown_total,ddududu_total&order=date.asc',
      { headers: { Accept: 'application/json' } },
    );
    const patchedDates = [];
    if (nullRes.ok) {
      for (const entry of await nullRes.json()) {
        const d = new Date(entry.date + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        const prevDate = d.toISOString().split('T')[0];
        const prevRow  = totalsMap[prevDate];
        if (!prevRow) continue;
        await sbFetch(`/global_stream_snapshots?date=eq.${entry.date}`, {
          method: 'PATCH',
          body: JSON.stringify({
            jump_daily:     entry.jump_total     - prevRow.jump_total,
            shutdown_daily: entry.shutdown_total - prevRow.shutdown_total,
            ddududu_daily:  entry.ddududu_total  - prevRow.ddududu_total,
          }),
        });
        patchedDates.push(entry.date);
      }
    }
    return res.status(200).json({
      ok: true, rows_attempted: rows.length, patched_nulls: patchedDates,
      date_range: rows.length ? `${rows[0].date} → ${rows[rows.length-1].date}` : null,
      debug: {
        histLengths: { jump: histJump?.length, sd: histSD?.length, ddu: histDDU?.length },
        prevDates:   { jump: prevJump?.date,   sd: prevSD?.date,   ddu: prevDDU?.date   },
      },
    });
  }

  // ── Musicat stats proxy ──────────────────────────────────────────────────
  const mcUser = req.query.musicat_user;
  if (mcUser) {
    // Stale-while-error cache: Musicat fires 13 upstream stat calls per lookup and
    // throttles under the leaderboard cron's burst. Serve fresh cache for 20 min,
    // re-scrape when stale, and fall back to the last good payload on any upstream
    // failure so a throttled call never zeroes a fan's Musicat contribution.
    // v2: bumped when GO + Fallen Angel + Heaven were added to the per-track set.
    const mcKey = `mccache:v2:${String(mcUser).toLowerCase()}`;
    const mcCached = await upstashGet(mcKey);
    if (mcCached?.payload && mcCached.at && (Date.now() - mcCached.at) < 20 * 60 * 1000) {
      return res.status(200).json(mcCached.payload);
    }
    const mcStale = (errObj, status) => mcCached?.payload
      ? res.status(200).json(mcCached.payload)
      : res.status(status).json(errObj);
    try {
      const ur = await fetch(`${MUSICAT_BASE}/users?user=${encodeURIComponent(mcUser)}`, { headers: MC_HEADERS });
      if (!ur.ok) return mcStale({ error: `User "${mcUser}" not found (${ur.status})` }, 400);
      const ud = await ur.json();
      const publicId = ud.publicId ?? ud.id ?? ud.uuid;
      if (!publicId) return res.status(400).json({ error: 'publicId missing' });
      const displayName    = ud.displayName ?? ud.username ?? ud.name ?? mcUser;
      const totalScrobbles = ud.totalScrobbles ?? ud.listenCount ?? null;

      const now        = new Date();
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
      const allTime    = { start: null, end: null };
      const today      = { start: todayStart, end: null };

      const [bpGroupPlays, jisooPlays, lisaPlays, rosePlays, jenniePlays] = await Promise.all([
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: BLACKPINK_ARTIST }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.jisoo }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.lisa }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.rose }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.jennie }),
      ]);
      // Per-track all-time + today, one query each, for the full campaign + EP set.
      const [allTimeVals, todayVals] = await Promise.all([
        Promise.all(MC_TRACKS.map(id => statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS[id] }))),
        Promise.all(MC_TRACKS.map(id => statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS[id] }))),
      ]);
      const tracks = {}, tracksToday = {};
      MC_TRACKS.forEach((id, i) => { tracks[id] = allTimeVals[i]; tracksToday[id] = todayVals[i]; });

      const memberPlays = { jisoo: jisooPlays, lisa: lisaPlays, rose: rosePlays, jennie: jenniePlays };
      const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

      const mcPayload = {
        publicId, displayName,
        playcount: totalScrobbles ?? artistPlays,
        artistPlays, bpGroupPlays, memberPlays,
        tracks,
        today: tracksToday,
      };
      await upstashSetEx(mcKey, { payload: mcPayload, at: Date.now() }, 7 * 24 * 3600);
      return res.status(200).json(mcPayload);
    } catch(err) {
      return mcStale({ error: err.message }, 400);
    }
  }

  // ── Stats.fm stats proxy ───────────────────────────────────────────────
  const sfmUser = req.query.statsfm_user;
  if (sfmUser) {
    try {
      const SFM_BASE = 'https://api.stats.fm/api/v1';
      const SFM_H = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' };

      const ur = await fetch(`${SFM_BASE}/users/${encodeURIComponent(sfmUser)}`, { headers: SFM_H });
      if (!ur.ok) return res.status(400).json({ error: `Stats.fm user "${sfmUser}" not found (${ur.status})` });
      const ud = await ur.json();
      const user = ud.item ?? ud;
      const customId    = user.customId ?? user.id ?? sfmUser;
      const displayName = user.displayName ?? customId;

      // Fetch top tracks (try limit=100; Stats.fm may reject higher limits).
      // Also fetch top artists for member breakdown.
      const [tr, ar] = await Promise.all([
        fetch(`${SFM_BASE}/users/${encodeURIComponent(customId)}/top/tracks?range=lifetime&limit=100`, { headers: SFM_H }),
        fetch(`${SFM_BASE}/users/${encodeURIComponent(customId)}/top/artists?range=lifetime&limit=50`, { headers: SFM_H }),
      ]);

      const items = tr.ok ? ((await tr.json()).items ?? []) : [];
      const adData = ar.ok ? await ar.json() : null;

      const MEMBER_MAP = { 'JISOO': 'jisoo', 'LISA': 'lisa', 'ROSÉ': 'rose', 'JENNIE': 'jennie' };
      let bpGroupPlays = 0;
      const memberPlays = { jisoo: 0, lisa: 0, rose: 0, jennie: 0 };
      for (const item of (adData?.items ?? [])) {
        const n = item.artist?.name;
        // streams field or playedMs/60000 as fallback
        const streams = item.streams ?? Math.round((item.playedMs ?? 0) / 180000);
        if (n === 'BLACKPINK') bpGroupPlays += streams;
        else if (MEMBER_MAP[n]) memberPlays[MEMBER_MAP[n]] += streams;
      }
      const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

      // Match tracks by name prefix; also accept streams or count field
      const TRACKS = [
        { id: 'jump',     prefix: 'jump',              artist: 'BLACKPINK' },
        { id: 'shutdown', prefix: 'shut down',          artist: 'BLACKPINK' },
        { id: 'ddududu',  prefix: 'ddu-du ddu-du',      artist: 'BLACKPINK' },
        { id: 'ltal',     prefix: 'less than a lover',  artist: 'JENNIE' },
      ];
      const tracks = {};
      for (const t of TRACKS) {
        tracks[t.id] = items
          .filter(i => {
            const name = (i.track?.name ?? i.name ?? '').toLowerCase();
            const artists = i.track?.artists ?? i.artists ?? [];
            return name.startsWith(t.prefix) && artists.some(a => a.name === t.artist);
          })
          .reduce((sum, i) => sum + (i.streams ?? i.count ?? Math.round((i.playedMs ?? 0) / 180000)), 0);
      }

      return res.status(200).json({
        customId, displayName,
        playcount: artistPlays || Object.values(tracks).reduce((s, v) => s + v, 0),
        artistPlays, bpGroupPlays, memberPlays, tracks,
        today: { jump: 0, shutdown: 0, ddududu: 0, ltal: 0 },
      });
    } catch(err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // ── Spotify artwork proxy (?spotify_art=<trackId>) ──────────────────────
  const spotifyArtTrack = req.query.spotify_art;
  if (spotifyArtTrack) {
    try {
      const artUrl = await fetchSpotifyArtworkUrl(spotifyArtTrack);
      if (!artUrl) return res.status(404).json({ error: 'No artwork found' });
      const imgRes = await fetch(artUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!imgRes.ok) return res.status(imgRes.status).end();
      const buf = await imgRes.arrayBuffer();
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
      return res.end(Buffer.from(buf));
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Image proxy ─────────────────────────────────────────────────────────
  const { url } = req.query;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Invalid URL' });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(r.status).end();
    const buf = await r.arrayBuffer();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.end(Buffer.from(buf));
  } catch(e) {
    res.status(500).json({ error: 'Proxy failed' });
  }
}
