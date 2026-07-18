import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

// Spotify's public play count generally only jumps once a day, sometime
// between midday and late evening Italy time. Outside that window (or once
// today's jump has already landed) there's nothing new to find, so we poll
// far less aggressively there to protect the RapidAPI quota.
function getCacheTtlMs(needsDailyUpdate) {
  if (!needsDailyUpdate) return 4 * 60 * 60 * 1000; // today's bump already seen — recheck in ~4h
  const romeHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false }).format(new Date())
  );
  if (romeHour < 12) return Infinity; // before midday — Spotify never updates this early, don't call at all
  return 15 * 60 * 1000; // in the daily watch window — poll every ~15min
}

// Returns all configured RapidAPI keys for the given env vars, in priority order.
// Add extras as RAPIDAPI_KEYS=key1,key2,key3 in Vercel env vars.
// RAPIDAPI_KEYS_2 is a spillover slot for adding more keys to the same provider
// without touching the existing var (handy when editing env vars from a phone).
function getApiKeys(envVarNames) {
  const keys = [];
  for (const name of envVarNames) {
    const envVar = process.env[name];
    if (!envVar) continue;
    for (const k of envVar.split(',').map(k => k.trim()).filter(Boolean)) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

// Two independent RapidAPI providers, each with its own subscription/quota.
// If every key on one provider is rate-limited or quota-exceeded, we move on
// to the next provider entirely before giving up.
const PROVIDERS = [
  {
    name: 'spotify-scraper',
    host: 'spotify-scraper.p.rapidapi.com',
    keyEnvVars: ['RAPIDAPI_KEYS', 'RAPIDAPI_KEYS_2', 'RAPIDAPI_KEY'],
    url: trackId => `https://spotify-scraper.p.rapidapi.com/v1/track/metadata?trackId=${trackId}`,
    // 429 = rate limit, 403 = quota exceeded, data.message = API-level error
    isQuotaError: (r, data) => r.status === 429 || r.status === 403 || !!data?.message,
    getPlayCount: data => Number(data?.playCount) || 0,
  },
  {
    name: 'spotify-scraper-api',
    host: 'spotify-scraper-api.p.rapidapi.com',
    keyEnvVars: ['RAPIDAPI_KEYS_API2'],
    url: trackId => `https://spotify-scraper-api.p.rapidapi.com/api/v1/track/info?track_id=${trackId}`,
    // 429 = rate limit, 403 = quota exceeded, anything other than status "Successful" is an error
    isQuotaError: (r, data) => r.status === 429 || r.status === 403 || data?.status !== 'Successful',
    getPlayCount: data => Number(data?.data?.playcount) || 0,
  },
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

function extractPlayCount(html) {
  for (const re of [
    /"playCount":"(\d+)"/i,
    /"playcount":"(\d+)"/i,
    /"playcount":(\d+)/i,
    /playCount["']?\s*:\s*["']?(\d+)/i,
  ]) {
    const m = html.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

// Direct Spotify fallback — no RapidAPI needed.
// Tries the unofficial partner API first, then scrapes the track page and embed.
async function fetchSpotifyDirectPlayCount(trackId) {
  const errors = [];

  // Try 1: anonymous token + partner API
  try {
    const tr = await fetch(
      'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
      { headers: { 'User-Agent': UA, 'Accept': 'application/json' } },
    );
    const td = tr.ok ? await tr.json() : null;
    const token = td?.accessToken;
    if (token) {
      const variables  = JSON.stringify({ uri: `spotify:track:${trackId}` });
      const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42' } });
      const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA } });
      if (r.ok) {
        const d = await r.json();
        const count = d?.data?.trackUnion?.playcount;
        if (count) return Number(count);
        errors.push(`partner: no playcount in response`);
      } else {
        errors.push(`partner: ${r.status}`);
      }
    } else {
      errors.push(`token: ${td ? 'null accessToken' : tr.status}`);
    }
  } catch(e) { errors.push(`token/partner: ${e.message}`); }

  // Try 2: scrape open.spotify.com track page
  try {
    const r = await fetch(`https://open.spotify.com/track/${trackId}`, { headers: BROWSE_HEADERS });
    if (r.ok) {
      const count = extractPlayCount(await r.text());
      if (count) return count;
      errors.push('scrape: playCount not found in page HTML');
    } else {
      errors.push(`scrape: ${r.status}`);
    }
  } catch(e) { errors.push(`scrape: ${e.message}`); }

  // Try 3: scrape embed page (different bot-detection surface)
  try {
    const r = await fetch(`https://open.spotify.com/embed/track/${trackId}`, { headers: BROWSE_HEADERS });
    if (r.ok) {
      const count = extractPlayCount(await r.text());
      if (count) return count;
      errors.push('embed: playCount not found in embed HTML');
    } else {
      errors.push(`embed: ${r.status}`);
    }
  } catch(e) { errors.push(`embed: ${e.message}`); }

  throw new Error(errors.join('; ') || 'all direct methods failed');
}

// Tries each provider in order, and within a provider tries each key in
// order, moving on if one is rate-limited or quota-exceeded.
// prevTotal: if a provider returns this exact count (or lower), its scraper
// cache is stale — we continue to the next provider instead of returning
// immediately, since it may have already picked up the day's update.
// All keys on the same provider share the same scraper cache, so there's no
// point trying more than one key per provider on a stale response — we break
// out and try the next provider directly.
async function fetchTrackMetadata(trackId, prevTotal = 0) {
  let lastError = 'No API keys configured';
  let staleResult = null; // best valid-but-unchanged result seen so far
  for (const provider of PROVIDERS) {
    const keys = getApiKeys(provider.keyEnvVars);
    for (const key of keys) {
      const r = await fetch(provider.url(trackId), {
        headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': provider.host },
      });
      const data = await r.json();
      if (provider.isQuotaError(r, data)) {
        lastError = data?.message || `HTTP ${r.status}`;
        continue;
      }
      if (!r.ok) { lastError = `HTTP ${r.status}`; continue; }
      const playCount = provider.getPlayCount(data);
      // Fresh data — higher than yesterday's snapshot, return immediately.
      if (playCount > prevTotal) return { playCount };
      // Stale data — same or lower than yesterday. Save it as a fallback,
      // then break out of the key loop and try the next provider.
      if (!staleResult) staleResult = { playCount };
      break;
    }
  }
  // All RapidAPI providers failed or returned stale — try direct Spotify as last resort.
  try {
    const playCount = await fetchSpotifyDirectPlayCount(trackId);
    if (playCount > 0) return { playCount };
  } catch(e) {
    lastError = `direct: ${e.message}`;
  }
  // Return stale RapidAPI result if we have one, otherwise throw.
  if (staleResult) return staleResult;
  throw new Error(lastError);
}

// ── Catalog total helpers (merged from catalog-streams.js) ───────────────────

const CAT_CACHE_KEY    = 'bp_catalog_total';
const CAT_HIST_KEY     = 'bp_catalog_hist';
const BP_TRACK_IDS_KEY = 'bp_track_ids';
const BP_TRACK_IDS_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days

async function getSpotifyClientToken() {
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
  if (!r.ok) throw new Error(`client-token ${r.status}`);
  return (await r.json()).access_token;
}

async function getSpotifyAnonToken() {
  const r = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    { headers: { 'User-Agent': UA } },
  );
  if (!r.ok) throw new Error(`anon-token ${r.status}`);
  const d = await r.json();
  if (!d.accessToken) throw new Error('accessToken missing');
  return d.accessToken;
}

async function getAllBpTrackIds(clientToken) {
  const ARTIST_ID = '41MozSoPIsD1dJM0CLPjZF';
  const albumIds  = [];
  let url = `https://api.spotify.com/v1/artists/${ARTIST_ID}/albums?include_groups=album,single&limit=50&market=US`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${clientToken}` } });
    if (!r.ok) throw new Error(`albums ${r.status}`);
    const d = await r.json();
    for (const a of (d.items || [])) albumIds.push(a.id);
    url = d.next || null;
  }
  const seen = new Set(), ids = [];
  for (let i = 0; i < albumIds.length; i += 20) {
    const r = await fetch(`https://api.spotify.com/v1/albums?ids=${albumIds.slice(i,i+20).join(',')}&market=US`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    if (!r.ok) continue;
    for (const album of ((await r.json()).albums || [])) {
      for (const t of (album?.tracks?.items || [])) {
        if (t?.id && !seen.has(t.id)) { seen.add(t.id); ids.push(t.id); }
      }
    }
  }
  return ids;
}

async function fetchCatalogViaSpotifyAPI() {
  // Use cached track IDs to avoid the albums-listing 429 on every fetch.
  // Only fetch fresh IDs when the cache is missing or older than 14 days.
  let ids = null;
  const cachedIds = await redis.get(BP_TRACK_IDS_KEY);
  if (cachedIds?.ids?.length && cachedIds.ts && Date.now() - cachedIds.ts < BP_TRACK_IDS_TTL) {
    ids = cachedIds.ids;
  } else {
    const ct = await getSpotifyClientToken();
    ids = await getAllBpTrackIds(ct);
    await redis.set(BP_TRACK_IDS_KEY, { ids, ts: Date.now() });
  }

  const at  = await getSpotifyAnonToken();
  let total = 0, failed = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const counts = await Promise.all(ids.slice(i, i + 10).map(async id => {
      try {
        const vars = JSON.stringify({ uri: `spotify:track:${id}` });
        const exts = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42' } });
        const r = await fetch(`https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${encodeURIComponent(vars)}&extensions=${encodeURIComponent(exts)}`, {
          headers: { Authorization: `Bearer ${at}`, 'User-Agent': UA },
        });
        const count = (await r.json())?.data?.trackUnion?.playcount;
        return count ? Number(count) : 0;
      } catch { failed++; return 0; }
    }));
    total += counts.reduce((s, c) => s + c, 0);
  }
  if (!total) throw new Error('all play counts returned 0');
  // Refresh cache timestamp on successful full fetch
  await redis.set(BP_TRACK_IDS_KEY, { ids, ts: Date.now() });
  return { total, trackCount: ids.length, failed, source: 'spotify-api' };
}

async function fetchCatalogViaKworb() {
  const r = await fetch('https://kworb.net/spotify/artist/41MozSoPIsD1dJM0CLPjZF.html', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
  });
  if (!r.ok) throw new Error(`kworb ${r.status}`);
  const html = await r.text();

  // Try 1: explicit total/sum row by class or text label
  const totalRow = html.match(/<tr[^>]*class="[^"]*total[^"]*"[^>]*>([\s\S]*?)<\/tr>/i)
    || html.match(/<tr[^>]*class="[^"]*sum[^"]*"[^>]*>([\s\S]*?)<\/tr>/i)
    || html.match(/>Total<\/(td|th)>[\s\S]{0,300}?([\d,]{8,})/i)
    || html.match(/>Sum<\/(td|th)>[\s\S]{0,300}?([\d,]{8,})/i);
  if (totalRow) {
    const nums = totalRow[0].match(/\d{1,3}(?:,\d{3}){3,}/g);
    if (nums) {
      const v = Math.max(...nums.map(n => Number(n.replace(/,/g, ''))));
      if (v > 100_000_000) return { total: v, source: 'kworb' };
    }
  }

  // Try 2: find any number >= 10 billion — the catalog total (~17.5B) is
  // far larger than any individual track, so it's unambiguous.
  const hugeNums = [...html.matchAll(/\b(\d{1,3}(?:,\d{3}){3,})\b/g)]
    .map(m => Number(m[1].replace(/,/g, '')))
    .filter(n => n >= 10_000_000_000);
  if (hugeNums.length >= 1) {
    return { total: Math.max(...hugeNums), source: 'kworb' };
  }

  // Try 3: mark elements (legacy fallback)
  const marks = [...html.matchAll(/class="mark[^"]*"[^>]*>([\d,]+)/g)]
    .map(m => Number(m[1].replace(/,/g, ''))).filter(n => n >= 1_000_000);
  if (marks.length >= 3) {
    const sorted = [...marks].sort((a, b) => b - a);
    const rest   = sorted.slice(1).reduce((s, n) => s + n, 0);
    if (sorted[0] >= rest * 0.8 && sorted[0] > 500_000_000) return { total: sorted[0], source: 'kworb' };
    return { total: sorted.reduce((s, n) => s + n, 0), trackCount: marks.length, source: 'kworb' };
  }

  throw new Error('kworb: no data found');
}

async function updateCatalogHistory(total, daily = null, overrideDate = null) {
  const d    = new Date();
  d.setUTCDate(d.getUTCDate() - 1); // Spotify reports previous day's streams
  const date = overrideDate || `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  const hist = (await redis.get(CAT_HIST_KEY)) || [];
  const ex   = hist.find(h => h.date === date);
  if (ex) {
    if (total > ex.total) ex.total = total;
    if (daily !== null) ex.daily = daily;
  } else {
    const entry = { date, total };
    if (daily !== null) entry.daily = daily;
    hist.push(entry);
    hist.sort((a, b) => {
      const [ad, am] = a.date.split('/').map(Number);
      const [bd, bm] = b.date.split('/').map(Number);
      return am !== bm ? am - bm : ad - bd;
    });
  }
  if (hist.length > 90) hist.shift();
  await redis.set(CAT_HIST_KEY, hist);
  return hist;
}

async function handleCatalogRequest(req, res) {
  const isForced = req.query.force === '1';
  if (isForced) {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Admin delete history entry: ?action=delete&date=DD/MM&key=admin
  if (req.query.action === 'delete') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date required (DD/MM)' });
    const hist = (await redis.get(CAT_HIST_KEY)) || [];
    const before = hist.length;
    const updated = hist.filter(h => h.date !== date);
    await redis.set(CAT_HIST_KEY, updated);
    return res.status(200).json({ ok: true, removed: before - updated.length, history: updated });
  }

  // Admin manual seed: ?action=set&total=X[&daily=Y][&date=DD/MM]&key=admin
  if (req.query.action === 'set') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
    const total = Number(String(req.query.total || '').replace(/[^0-9]/g, ''));
    if (!total || total < 100000000) return res.status(400).json({ error: 'total must be > 100M' });
    const daily = req.query.daily ? Number(String(req.query.daily).replace(/[^0-9]/g, '')) : null;
    const entry = { total, source: 'manual', ts: Date.now() };
    await redis.set(CAT_CACHE_KEY, entry);
    // Override date if provided (for backfilling historical entries)
    const overrideDate = req.query.date || null;
    const hist = await updateCatalogHistory(total, daily, overrideDate);
    return res.status(200).json({ ok: true, ...entry, history: hist });
  }

  const cached  = await redis.get(CAT_CACHE_KEY);
  const cacheMs = cached?.ts ? Date.now() - cached.ts : Infinity;
  if (!isForced && cacheMs < 4 * 60 * 60 * 1000 && (cached?.total || 0) > 0) {
    const hist = (await redis.get(CAT_HIST_KEY)) || [];
    return res.status(200).json({ ...cached, history: hist, cached: true });
  }

  const errors = [];
  let result   = null;
  try { result = await fetchCatalogViaSpotifyAPI(); } catch(e) { errors.push(`spotify-api: ${e.message}`); }
  if (!result) { try { result = await fetchCatalogViaKworb(); } catch(e) { errors.push(`kworb: ${e.message}`); } }

  if (!result) {
    if (cached?.total) {
      const hist = (await redis.get(CAT_HIST_KEY)) || [];
      return res.status(200).json({ ...cached, history: hist, stale: true, errors });
    }
    return res.status(503).json({ error: 'All methods failed. Use ?action=set&total=X&key=<admin> to seed.', errors });
  }

  result.ts = Date.now();
  await redis.set(CAT_CACHE_KEY, result);
  const hist = await updateCatalogHistory(result.total);
  return res.status(200).json({ ...result, history: hist });
}

// ─────────────────────────────────────────────────────────────────────────────

function getDateLabel(date) {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}
function parseDateLabel(label) {
  const [dd, mm] = label.split('/').map(Number);
  return new Date(Date.UTC(new Date().getUTCFullYear(), mm - 1, dd));
}
function daysBetween(labelA, labelB) {
  return Math.round((parseDateLabel(labelB) - parseDateLabel(labelA)) / 86_400_000);
}
function addDaysToLabel(ddmm, n) {
  const [dd, mm] = ddmm.split('/').map(Number);
  const d = new Date(Date.UTC(new Date().getUTCFullYear(), mm - 1, dd + n));
  return getDateLabel(d);
}
function yesterdayLabel() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return getDateLabel(d);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Catalog total sub-route: /api/streams?catalog=1[&action=set&total=X&key=Y | &force=1&key=Y]
  if (req.query.catalog === '1') return handleCatalogRequest(req, res);

  const isCron = req.query.cron === '1';
  if (isCron) {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Manual escape hatch for when a RapidAPI quota outage causes a day's entry
  // to go unrecorded — lets an admin force a real (non-cached) fetch on demand
  // instead of waiting for the next watch-window poll or the midnight cron.
  const isForced = req.query.force === '1';
  if (isForced) {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Manual escape hatch for directly setting/correcting a single day's history
  // entry — for when the upstream play count genuinely never moved (e.g. a
  // multi-day Spotify reporting freeze), so there's no live diff to compute and
  // the normal fetch-and-diff flow has nothing to write.
  if (req.query.action === 'delete-history-entry') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { track, date } = req.query;
    if (!TRACKS[track] || !date) {
      return res.status(400).json({ error: 'Requires track and date (dd/mm) query params' });
    }
    const lockKey = `bp_lock_${track}`;
    const gotLock = !!(await redis.set(lockKey, '1', { nx: true, ex: 30 }));
    if (!gotLock) return res.status(409).json({ error: 'Track is busy updating, try again in a few seconds' });
    try {
      const histKey = `bp_hist_${track}`;
      const history = (await redis.get(histKey)) || [];
      const before = history.length;
      const updated = history.filter(h => h.date !== date);
      await redis.set(histKey, updated);
      return res.status(200).json({ ok: true, track, removed: before - updated.length, history: updated });
    } finally {
      await redis.del(lockKey);
    }
  }

  if (req.query.action === 'set-entry') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { track, date, streams, total, prevDate } = req.query;
    if (!TRACKS[track] || !date || streams === undefined) {
      return res.status(400).json({ error: 'Requires track, date (dd/mm), and streams query params' });
    }

    // Share the same per-track lock as the regular fetch loop below — without
    // this, a manual correction can land in the middle of a cron/visitor-poll
    // fetch and get its write clobbered (or clobber that fetch's write).
    const lockKey = `bp_lock_${track}`;
    const gotLock = !!(await redis.set(lockKey, '1', { nx: true, ex: 30 }));
    if (!gotLock) {
      return res.status(409).json({ error: 'Track is busy updating, try again in a few seconds' });
    }
    try {
      const histKey = `bp_hist_${track}`;
      const history = (await redis.get(histKey)) || [];
      const entry = history.find(h => h.date === date);
      if (entry) {
        entry.streams = Number(streams);
      } else {
        history.push({ date, streams: Number(streams) });
        history.sort((a, b) => parseDateLabel(a.date) - parseDateLabel(b.date));
      }
      await redis.set(histKey, history);

      // Optional: also correct the running total/snapshot used as the baseline
      // for the next live diff, so a backfilled day doesn't get double-counted
      // once real fetches resume. The asserted date always wins here, since a
      // stale or race-written prev snapshot shouldn't override an explicit fix.
      // prevDate overrides the date stamped on prevKey — use it when the history
      // entry date (e.g. "10/07") differs from the actual snapshot date whose
      // total you're supplying (e.g. "11/07"), so the next live diff is anchored
      // to the right day instead of re-computing from the history entry date.
      if (total !== undefined) {
        const prevKey = `bp_prev_${track}`;
        const liveKey = `bp_live_${track}`;
        await redis.set(prevKey, { total: Number(total), date: prevDate || date });
        await redis.set(liveKey, { total: Number(total), ts: Date.now() });
      }

      return res.status(200).json({ ok: true, track, history });
    } finally {
      await redis.del(lockKey);
    }
  }

  const todayLabel = getDateLabel(new Date());
  const results    = {};
  const errors     = {};
  let fetchedLive  = false;

  // Shuffle track order so no single track is always last when quota runs dry
  // mid-loop. Fisher-Yates on the entries array.
  const trackEntries = Object.entries(TRACKS);
  for (let i = trackEntries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [trackEntries[i], trackEntries[j]] = [trackEntries[j], trackEntries[i]];
  }

  for (const [name, trackId] of trackEntries) {
    const liveKey = `bp_live_${name}`;
    const prevKey = `bp_prev_${name}`;
    const histKey = `bp_hist_${name}`;
    const errKey  = `bp_err_${name}`;
    const lockKey = `bp_lock_${name}`;
    let gotLock = false;

    try {
      // Overlapping requests (cron + a concurrent visitor poll, say) can both read
      // history/prev at once and then race to write it back, silently losing
      // whichever update saves first. A short-lived per-track lock serializes the
      // read-modify-write so only one request updates a track at a time; a request
      // that loses the race just returns the current cached snapshot instead.
      gotLock = !!(await redis.set(lockKey, '1', { nx: true, ex: 30 }));
      if (!gotLock) {
        const [cachedOnly, histOnly, prevOnly] = await Promise.all([redis.get(liveKey), redis.get(histKey), redis.get(prevKey)]);
        results[name] = { total: cachedOnly?.total || 0, history: histOnly || [], prev: prevOnly ? { total: prevOnly.total, date: prevOnly.date } : null };
        continue;
      }

      const [cached, prev, hist] = await Promise.all([
        redis.get(liveKey),
        redis.get(prevKey),
        redis.get(histKey),
      ]);

      const history   = hist || [];
      // Fix mislabeled latest entry: if the gap between the last two entries
      // is more than 1 day, the last entry was likely mislabeled by a previous
      // bug. Relabel it to addDaysToLabel(secondLast, 1) which is the correct
      // first new streaming day after the gap started.
      if (history.length >= 2) {
        const last       = history[history.length - 1];
        const secondLast = history[history.length - 2];
        const expected   = addDaysToLabel(secondLast.date, 1);
        if (last.date !== expected && daysBetween(secondLast.date, last.date) > 1) {
          last.date = expected;
          await redis.set(histKey, history);
        }
      }
      const cacheAge  = cached?.ts ? Date.now() - cached.ts : Infinity;
      // Skip cache if we haven't recorded today's history entry yet, even if the
      // live total is recent — otherwise a fetch that straddles midnight stays
      // cached across the day boundary and the daily diff never gets written.
      const needsDailyUpdate = !prev || prev.date !== todayLabel;
      const cacheValid = !isCron && !isForced && cacheAge < getCacheTtlMs(needsDailyUpdate) && (cached?.total || 0) > 0;
      let total;
      let updatedAt = cached?.ts || null;
      let stale = false;

      if (cacheValid) {
        total = cached.total;
      } else {
        let data;
        try {
          data = await fetchTrackMetadata(trackId, Number(prev?.total || 0));
        } catch(e) {
          errors[name] = { message: e.message, ts: new Date().toISOString() };
          await redis.set(errKey, { message: e.message, ts: Date.now() });
          data = {};
        }
        const fetchedTotal = data?.playCount || 0;
        fetchedLive = true;
        if (fetchedTotal > 0) {
          total = fetchedTotal;
          updatedAt = Date.now();
          await redis.set(liveKey, { total, ts: updatedAt });
          await redis.del(errKey);
        } else {
          // Live fetch failed (e.g. all RapidAPI keys exhausted) — fall back to
          // the last known-good cached total instead of showing 0.
          total = cached?.total || 0;
          stale = total > 0;
        }

        const prevTotal = Number(prev?.total || 0);

        if (total > 0 && prevTotal > 0 && total > prevTotal) {
          const gap = daysBetween(prev.date, todayLabel);

          if (gap >= 1) {
            // gap=1: prev.date IS the streaming day (snapshot was yesterday, streams are for that day)
            // gap>1: Spotify skipped days, label as the day after the last snapshot
            const yLabel = gap === 1 ? prev.date : addDaysToLabel(prev.date, 1);
            const dailyStreams = total - prevTotal;
            const existing = history.find(h => h.date === yLabel);
            if (!existing) {
              const entry = { date: yLabel, streams: dailyStreams };
              if (gap > 1) entry.note = `${gap}-day gap`;
              history.push(entry);
              if (history.length > 60) history.shift();
              await redis.set(histKey, history);
            }
            // Never overwrite an existing entry — it may have been manually corrected.
          }

          await redis.set(prevKey, { total, date: todayLabel });
        }

        if (total > 0 && !prev) {
          await redis.set(prevKey, { total, date: todayLabel });
        }
      }

      results[name] = {
        total,
        history,
        prev: prev ? { total: prev.total, date: prev.date } : null,
        ...(stale ? { stale: true, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null } : {}),
      };
    } catch (e) {
      console.error(`streams: ${name}:`, e.message);
      const fallback = await redis.get(`bp_live_${name}`);
      const history  = await redis.get(`bp_hist_${name}`);
      results[name] = {
        total: fallback?.total || 0,
        history: history || [],
        ...(fallback?.total ? { stale: true, updatedAt: fallback?.ts ? new Date(fallback.ts).toISOString() : null } : {}),
      };
    } finally {
      if (gotLock) await redis.del(lockKey);
    }
  }

  const prevSnaps = {};
  for (const name of Object.keys(TRACKS)) {
    prevSnaps[name] = await redis.get(`bp_prev_${name}`);
    if (!errors[name]) {
      const lastErr = await redis.get(`bp_err_${name}`);
      if (lastErr) errors[name] = { message: lastErr.message, ts: new Date(lastErr.ts).toISOString() };
    }
  }

  const keyCounts = {};
  for (const provider of PROVIDERS) {
    keyCounts[provider.name] = getApiKeys(provider.keyEnvVars).length;
  }

  // Trigger catalog total update on cron runs (fire-and-forget, no await)
  if (isCron && fetchedLive) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'blackpink-project.vercel.app';
    fetch(`https://${host}/api/streams?catalog=1&force=1&key=${process.env.ADMIN_SECRET || ''}`).catch(() => {});
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.status(200).json({
    ...results,
    _debug: { keyCounts, errors, live: fetchedLive, prev: prevSnaps, ts: new Date().toISOString() },
  });
}
