import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const ARTIST_ID = '41MozSoPIsD1dJM0CLPjZF'; // BLACKPINK on Spotify
const CACHE_KEY = 'bp_catalog_total';
const HIST_KEY  = 'bp_catalog_hist';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ── Spotify official API (needs SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET) ──

async function getClientToken() {
  const id     = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`client-token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

async function getAnonToken() {
  const r = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    { headers: { 'User-Agent': UA } },
  );
  if (!r.ok) throw new Error(`anon-token ${r.status}`);
  const d = await r.json();
  if (!d.accessToken) throw new Error('accessToken missing');
  return d.accessToken;
}

async function getAllTrackIds(clientToken) {
  const albumIds = [];
  let url = `https://api.spotify.com/v1/artists/${ARTIST_ID}/albums?include_groups=album,single&limit=50&market=US`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${clientToken}` } });
    if (!r.ok) throw new Error(`albums-list ${r.status}`);
    const d = await r.json();
    for (const a of (d.items || [])) albumIds.push(a.id);
    url = d.next || null;
  }
  if (!albumIds.length) throw new Error('no albums found');

  const seen     = new Set();
  const trackIds = [];
  for (let i = 0; i < albumIds.length; i += 20) {
    const batch = albumIds.slice(i, i + 20);
    const r = await fetch(`https://api.spotify.com/v1/albums?ids=${batch.join(',')}&market=US`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    if (!r.ok) continue;
    const d = await r.json();
    for (const album of (d.albums || [])) {
      for (const track of (album?.tracks?.items || [])) {
        if (track?.id && !seen.has(track.id)) {
          seen.add(track.id);
          trackIds.push(track.id);
        }
      }
    }
  }
  return trackIds;
}

async function fetchPartnerPlayCount(anonToken, trackId) {
  const variables  = JSON.stringify({ uri: `spotify:track:${trackId}` });
  const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42' } });
  const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${anonToken}`, 'User-Agent': UA } });
  if (!r.ok) throw new Error(`partner ${r.status}`);
  const count = (await r.json())?.data?.trackUnion?.playcount;
  return count ? Number(count) : 0;
}

async function fetchViaSpotifyAPI() {
  const clientToken = await getClientToken();
  const trackIds    = await getAllTrackIds(clientToken);
  const anonToken   = await getAnonToken();

  let total = 0, failed = 0;
  for (let i = 0; i < trackIds.length; i += 10) {
    const batch  = trackIds.slice(i, i + 10);
    const counts = await Promise.all(
      batch.map(id => fetchPartnerPlayCount(anonToken, id).catch(() => { failed++; return 0; }))
    );
    total += counts.reduce((s, c) => s + c, 0);
  }
  if (!total) throw new Error('all play counts returned 0');
  return { total, trackCount: trackIds.length, failed, source: 'spotify-api' };
}

// ── kworb.net fallback (no auth, scrapes artist page total) ──────────────────

async function fetchViaKworb() {
  const r = await fetch(`https://kworb.net/spotify/artist/${ARTIST_ID}.html`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!r.ok) throw new Error(`kworb ${r.status}`);
  const html = await r.text();

  // Try 1: explicit total row (kworb adds a "Total" row at the bottom of the table)
  const totalRow = html.match(/<tr[^>]*class="[^"]*total[^"]*"[^>]*>([\s\S]*?)<\/tr>/i)
    || html.match(/>Total<\/(td|th)>[\s\S]{0,200}?([\d,]{8,})/i);
  if (totalRow) {
    const nums = totalRow[0].match(/[\d]{1,3}(?:,[\d]{3}){3,}/g);
    if (nums) {
      const largest = Math.max(...nums.map(n => Number(n.replace(/,/g, ''))));
      if (largest > 100_000_000) return { total: largest, source: 'kworb' };
    }
  }

  // Try 2: sum the "mark" column (stream counts per track)
  const marks = [...html.matchAll(/class="mark[^"]*"[^>]*>([\d,]+)/g)]
    .map(m => Number(m[1].replace(/,/g, '')))
    .filter(n => n >= 1_000_000); // exclude chart positions / years

  if (marks.length >= 3) {
    // If the largest value is ≥ sum of the rest × 0.8, it IS the total row — use it directly
    const sorted = [...marks].sort((a, b) => b - a);
    const rest   = sorted.slice(1).reduce((s, n) => s + n, 0);
    if (sorted[0] >= rest * 0.8 && sorted[0] > 500_000_000) {
      return { total: sorted[0], source: 'kworb' };
    }
    return { total: sorted.reduce((s, n) => s + n, 0), trackCount: marks.length, source: 'kworb' };
  }

  // Try 3: any large number on the page labelled near "total" / "streams"
  const m = html.match(/(?:total|streams?)[\s\S]{0,200}?([\d]{1,3}(?:,[\d]{3}){4,})/i);
  if (m) {
    const n = Number(m[1].replace(/,/g, ''));
    if (n > 100_000_000) return { total: n, source: 'kworb' };
  }

  throw new Error('kworb: could not extract total streams');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDateLabel() {
  const d = new Date();
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function updateHistory(total) {
  const date = getDateLabel();
  const hist = (await redis.get(HIST_KEY)) || [];
  const ex   = hist.find(h => h.date === date);
  if (ex) { if (total > ex.total) ex.total = total; }
  else hist.push({ date, total });
  if (hist.length > 90) hist.shift();
  await redis.set(HIST_KEY, hist);
  return hist;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isCron   = req.query.cron === '1';
  const isForced = req.query.force === '1';

  if (isCron) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  if (isForced) {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // ── Admin manual seed ─────────────────────────────────────────────────────
  if (req.query.action === 'set') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const raw   = String(req.query.total || '').replace(/[^0-9]/g, '');
    const total = Number(raw);
    if (!total || total < 100_000_000) {
      return res.status(400).json({ error: 'total must be a number > 100M' });
    }
    const entry = { total, source: req.query.source || 'manual', ts: Date.now() };
    await redis.set(CACHE_KEY, entry);
    const hist = await updateHistory(total);
    return res.status(200).json({ ok: true, ...entry, history: hist });
  }

  // ── Serve cache for normal GETs (cron/force bypass this) ─────────────────
  const cached  = await redis.get(CACHE_KEY);
  const cacheMs = cached?.ts ? Date.now() - cached.ts : Infinity;
  const TTL_MS  = 4 * 60 * 60 * 1000; // 4 hours

  if (!isCron && !isForced && cacheMs < TTL_MS && (cached?.total || 0) > 0) {
    const hist = (await redis.get(HIST_KEY)) || [];
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({ ...cached, history: hist, cached: true });
  }

  // ── Live fetch (cron / force) ─────────────────────────────────────────────
  const errors = [];
  let result   = null;

  try {
    result = await fetchViaSpotifyAPI();
  } catch(e) {
    errors.push(`spotify-api: ${e.message}`);
  }

  if (!result) {
    try {
      result = await fetchViaKworb();
    } catch(e) {
      errors.push(`kworb: ${e.message}`);
    }
  }

  if (!result) {
    if (cached?.total) {
      const hist = (await redis.get(HIST_KEY)) || [];
      return res.status(200).json({ ...cached, history: hist, stale: true, errors });
    }
    return res.status(503).json({
      error: 'All fetch methods failed. Seed manually: ?action=set&total=XXXXXXX&key=<admin>',
      errors,
    });
  }

  result.ts = Date.now();
  await redis.set(CACHE_KEY, result);
  const hist = await updateHistory(result.total);

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  return res.status(200).json({ ...result, history: hist });
}
