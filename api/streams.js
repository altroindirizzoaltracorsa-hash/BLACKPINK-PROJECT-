import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
  go:       '0mYa3o6tlUN5HRippmKmwH',
};

// Canary-gate track. Spotify refreshes all four campaign tracks' play counts
// together (verified: their daily-gap days line up exactly), so while we wait
// for the daily bump to land we only spend RapidAPI keys on this ONE track.
// The moment the canary shows new streams, the handler fans out and fetches
// the other three once. Cuts waiting-phase quota ~4x, which is what lets the
// watch window run long enough to catch late (post-midnight) Spotify updates.
// JUMP is the highest-velocity track, so it's the most reliable bump signal.
const CANARY = 'jump';

// Version-merge / split guard. These campaign tracks gain at most ~1M streams a
// day, so a single-day change beyond this is almost certainly Spotify combining
// versions (a huge up-spike) or correcting a merge (a big down-drop) — NOT real
// streams. Adopting such a value corrupts the daily history and, when it later
// falls back, FREEZES the only-up counter (what happened to DDU-DU on Aug 17).
// Instead we HOLD an anomaly for admin confirmation (see the fetch loop below and
// ?action=anomalies / ?action=resolve-anomaly).
const MERGE_SPIKE_ABS = 15_000_000;

// Spotify's public play count generally only jumps once a day, sometime
// between midday and late evening Italy time. Outside that window (or once
// today's jump has already landed) there's nothing new to find, so we poll
// far less aggressively there to protect the RapidAPI quota.
function getCacheTtlMs(needsDailyUpdate) {
  if (!needsDailyUpdate) return 4 * 60 * 60 * 1000; // today's bump already seen — recheck in ~4h
  const romeHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false }).format(new Date())
  );
  // Active watch window: 3pm Rome straight through to 7am next morning. Spotify's
  // streaming day resets at 00:00 UTC (= 2am Rome in summer) and lately the daily
  // play-count refresh has been landing in the small hours AFTER that reset — the
  // usual cause of "2-day gap" entries, since the old window shut at midnight Rome
  // and nothing polled in the early morning to catch it. The overnight hours cover
  // the 2am-reset-through-dawn stretch where those late refreshes appear. The quiet
  // stretch is only 7am–3pm, when yesterday's numbers are already booked and the
  // next refresh isn't due yet. Running the window this long is cheap because the
  // canary gate means just ONE track is polled while we wait for the bump.
  if (romeHour >= 7 && romeHour < 15) return Infinity; // quiet: nothing new to find
  return 15 * 60 * 1000; // in the watch window — poll every ~15min
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
const SUPABASE_TRACK_NAMES = {
  jump:     'JUMP',
  shutdown: 'Shut Down',
  ddududu:  'DDU-DU DDU-DU',
  go:       'GO',
};

async function fetchTrackViaSupabase(trackKey) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');

  const trackName = SUPABASE_TRACK_NAMES[trackKey];
  if (!trackName) throw new Error(`No Supabase track name for key: ${trackKey}`);

  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };

  const r1 = await fetch(
    `${supabaseUrl}/rest/v1/artist_tracks?artist_id=eq.41MozSoPIsD1dJM0CLPjZF&name=eq.${encodeURIComponent(trackName)}&select=id&limit=1`,
    { headers },
  );
  if (!r1.ok) throw new Error(`Supabase artist_tracks ${r1.status}`);
  const tracks = await r1.json();
  if (!tracks?.length) throw new Error(`Supabase: no row for "${trackName}"`);

  const r2 = await fetch(
    `${supabaseUrl}/rest/v1/track_daily_stats?track_ref=eq.${tracks[0].id}&order=date.desc&limit=1&select=streams,date`,
    { headers },
  );
  if (!r2.ok) throw new Error(`Supabase track_daily_stats ${r2.status}`);
  const stats = await r2.json();
  if (!stats?.length) throw new Error(`Supabase: no stats for "${trackName}"`);

  return { playCount: stats[0].streams };
}

// All keys on the same provider share the same scraper cache, so there's no
// point trying more than one key per provider on a stale response — we break
// out and try the next provider directly.
async function fetchTrackMetadata(trackId, prevTotal = 0, trackKey = null) {
  // Check for a recently-cached result from the Cloudflare Worker.
  // The worker is called when the catalog total is refreshed and stores
  // per-track counts as a side-effect — Cloudflare IPs can get a fresh
  // Spotify anon token, so these counts are reliable and free of RapidAPI quota.
  if (trackKey) {
    try {
      const wc = await redis.get(`bp_worker_${trackKey}`);
      if (wc?.total > 0 && Date.now() - wc.ts < 4 * 60 * 60 * 1000) {
        return { playCount: wc.total };
      }
    } catch {}
  }

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
  // Return stale RapidAPI result if we have one.
  if (staleResult) return staleResult;
  // Last resort: Supabase snapshot from the daily Python cron.
  if (trackKey) {
    try {
      const sbResult = await fetchTrackViaSupabase(trackKey);
      if (sbResult.playCount > 0) return sbResult;
    } catch(e) {
      lastError = `supabase: ${e.message}`;
    }
  }
  throw new Error(lastError);
}

// ── Catalog total helpers (merged from catalog-streams.js) ─────────────────────────────────

const CAT_CACHE_KEY          = 'bp_catalog_total';
const CAT_HIST_KEY           = 'bp_catalog_hist';
const BP_TRACK_IDS_KEY       = 'bp_track_ids';
const BP_TRACK_IDS_TTL       = 14 * 24 * 60 * 60 * 1000; // 14 days
const SPOTIFY_USER_CREDS_KEY = 'bp_spotify_user_creds';
const BP_ANON_TOKEN_KEY      = 'bp_spotify_anon_token';

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

// Separate Spotify app credentials used only for the catalog fetch,
// so the main SPOTIFY_CLIENT_ID/SECRET quota is never touched.
async function getCatalogClientToken() {
  const id     = process.env.SPOTIFY_CLIENT_ID_2     || process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET_2 || process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('SPOTIFY_CLIENT_ID_2 / SPOTIFY_CLIENT_SECRET_2 not set');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`catalog-client-token ${r.status}`);
  return (await r.json()).access_token;
}

async function getSpotifyAnonToken() {
  // Check Redis for a token cached by a browser visitor (residential IP, not blocked)
  const cached = await redis.get(BP_ANON_TOKEN_KEY);
  if (cached?.token && cached.expires_at > Date.now()) return cached.token;

  // Fall through to the endpoint — blocked from cloud IPs, but try anyway
  const r = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    { headers: { 'User-Agent': UA } },
  );
  if (!r.ok) throw new Error(`anon-token ${r.status} (no cached token in Redis)`);
  const d = await r.json();
  if (!d.accessToken) throw new Error('accessToken missing');
  return d.accessToken;
}

// Returns a valid Spotify user access token using the refresh token stored in
// Redis after a one-time OAuth authorization via /api/spotify-auth.
// accounts.spotify.com/api/token (refresh) is not IP-blocked, so this works
// from Vercel even though open.spotify.com/get_access_token is blocked.
async function getStoredUserToken() {
  const creds = await redis.get(SPOTIFY_USER_CREDS_KEY);
  if (!creds?.refresh_token) {
    throw new Error('No stored Spotify OAuth token — visit /api/spotify-auth?key=<admin> to authorize once');
  }

  // Return cached token if it has more than 5 minutes remaining
  if (creds.access_token && creds.expires_at && Date.now() < creds.expires_at - 5 * 60 * 1000) {
    return creds.access_token;
  }

  // Refresh the access token using the stored refresh token
  const id     = process.env.SPOTIFY_CLIENT_ID_2 || process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET_2 || process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: creds.refresh_token,
    }),
  });
  if (!r.ok) throw new Error(`token-refresh ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (!d.access_token) throw new Error('token-refresh: access_token missing');

  const updated = {
    ...creds,
    access_token: d.access_token,
    expires_at:   Date.now() + d.expires_in * 1000,
    ts:           Date.now(),
  };
  if (d.refresh_token) updated.refresh_token = d.refresh_token;
  await redis.set(SPOTIFY_USER_CREDS_KEY, updated);

  return d.access_token;
}

async function getAllBpTrackIds(clientToken) {
  const ARTIST_ID = '41MozSoPIsD1dJM0CLPjZF';
  const albumIds  = [];
  let url = `https://api.spotify.com/v1/artists/${ARTIST_ID}/albums?include_groups=album,single`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${clientToken}` } });
    if (!r.ok) throw new Error(`albums ${r.status}: ${await r.text()}`);
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

const BP_ARTIST_ID = '41MozSoPIsD1dJM0CLPjZF';

// Single-call artist overview endpoints — much cheaper than summing 113 tracks individually.
// Tries both RapidAPI providers in order; falls back gracefully on any error.
async function fetchCatalogViaRapidAPI() {
  const ARTIST_ENDPOINTS = [
    {
      name: 'spotify-scraper',
      keyEnvVars: ['RAPIDAPI_KEYS', 'RAPIDAPI_KEYS_2', 'RAPIDAPI_KEY'],
      host: 'spotify-scraper.p.rapidapi.com',
      url: `https://spotify-scraper.p.rapidapi.com/v1/artist/overview?artistId=${BP_ARTIST_ID}`,
      // Returns { totalPlayCount, monthlyListeners, ... }
      getTotal: d => Number(d?.totalPlayCount || d?.total_play_count || d?.streams || 0),
    },
    {
      name: 'spotify-scraper-api',
      keyEnvVars: ['RAPIDAPI_KEYS_API2'],
      host: 'spotify-scraper-api.p.rapidapi.com',
      url: `https://spotify-scraper-api.p.rapidapi.com/api/v1/artist/info?artist_id=${BP_ARTIST_ID}`,
      getTotal: d => Number(d?.data?.total_play_count || d?.data?.streams || d?.data?.totalStreams || 0),
    },
  ];

  const errors = [];
  for (const ep of ARTIST_ENDPOINTS) {
    const keys = getApiKeys(ep.keyEnvVars);
    for (const key of keys) {
      try {
        const r = await fetch(ep.url, {
          headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': ep.host },
        });
        const data = await r.json();
        if (!r.ok) { errors.push(`${ep.name}: HTTP ${r.status}`); break; }
        const total = ep.getTotal(data);
        if (total > 1_000_000_000) return { total, source: `rapidapi-${ep.name}` };
        errors.push(`${ep.name}: total=${total} (raw: ${JSON.stringify(data).slice(0, 2000)})`);
      } catch(e) { errors.push(`${ep.name}: ${e.message}`); }
      break;
    }
  }
  throw new Error(errors.join('; ') || 'no RapidAPI keys configured');
}

async function fetchCatalogViaSpotifyAPI() {
  // The partner API only accepts the web-player anon token. Get it first so we
  // fail fast if it isn't cached yet (no point enumerating albums we can't use).
  // getSpotifyAnonToken() checks Redis first for a token cached by a browser visitor.
  const at = await getSpotifyAnonToken(); // throws if not cached

  // Use cached track IDs to avoid the albums-listing rate limit on every fetch.
  // Only fetch fresh IDs when the cache is missing or older than 14 days.
  // Use the anon token for enumeration too — it works for the official API and
  // doesn't consume the client-credentials quota.
  let ids = null;
  const cachedIds = await redis.get(BP_TRACK_IDS_KEY);
  if (cachedIds?.ids?.length && cachedIds.ts && Date.now() - cachedIds.ts < BP_TRACK_IDS_TTL) {
    ids = cachedIds.ids;
  } else {
    // Try anon token first; fall back to OAuth token then client credentials
    try {
      ids = await getAllBpTrackIds(at);
    } catch {
      try { ids = await getAllBpTrackIds(await getStoredUserToken()); }
      catch { ids = await getAllBpTrackIds(await getCatalogClientToken()); }
    }
    await redis.set(BP_TRACK_IDS_KEY, { ids, ts: Date.now() });
  }

  const tokenSource = 'anon';

  // Probe the first track to detect partner API auth failures early
  const probeId = ids[0];
  const probeVars = JSON.stringify({ uri: `spotify:track:${probeId}` });
  const probeExts = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42' } });
  const probeR = await fetch(`https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=${encodeURIComponent(probeVars)}&extensions=${encodeURIComponent(probeExts)}`, {
    headers: { Authorization: `Bearer ${at}`, 'User-Agent': UA },
  });
  if (!probeR.ok) {
    const probeText = await probeR.text();
    throw new Error(`partner-api ${probeR.status} (token=${tokenSource}): ${probeText.slice(0, 200)}`);
  }
  const probeD = await probeR.json();
  const probeCount = probeD?.data?.trackUnion?.playcount;
  if (!probeCount && probeD?.errors) {
    throw new Error(`partner-api errors (token=${tokenSource}): ${JSON.stringify(probeD.errors).slice(0, 200)}`);
  }

  let total = probeCount ? Number(probeCount) : 0, failed = 0;
  for (let i = 1; i < ids.length; i += 10) {
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
  if (!total) throw new Error(`all play counts returned 0 (token=${tokenSource})`);
  // Refresh cache timestamp on successful full fetch
  await redis.set(BP_TRACK_IDS_KEY, { ids, ts: Date.now() });
  return { total, trackCount: ids.length, failed, source: 'spotify-api' };
}

// Calls the Cloudflare Worker which gets a fresh Spotify anon token (Cloudflare
// IPs are not blocked by Spotify) and sums play counts via the partner API.
// The worker also returns per-track counts so campaign tracks can be cached
// as a side-effect, eliminating their dependence on RapidAPI quota.
// Requires SPOTIFY_WORKER_URL and SPOTIFY_WORKER_KEY env vars in Vercel.
async function fetchCatalogViaWorker() {
  const workerUrl = process.env.SPOTIFY_WORKER_URL;
  const workerKey = process.env.SPOTIFY_WORKER_KEY;
  if (!workerUrl || !workerKey) throw new Error('SPOTIFY_WORKER_URL / SPOTIFY_WORKER_KEY not set');
  const r = await fetch(`${workerUrl}?key=${encodeURIComponent(workerKey)}`, {
    signal: AbortSignal.timeout(90_000), // Worker may take up to ~60s for 120 tracks
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`worker ${r.status}: ${text.slice(0, 300)}`);
  }
  const d = await r.json();
  if (!d.total || d.total < 1_000_000_000) throw new Error(`worker bad total: ${JSON.stringify(d).slice(0, 200)}`);
  return { total: d.total, trackCount: d.trackCount, failed: d.failed || 0, source: 'cloudflare-worker', tracks: d.tracks || {} };
}

async function fetchCatalogViaKworb() {
  // Try both the songs page (has per-track streams) and the main artist page
  const urls = [
    'https://kworb.net/spotify/artist/41MozSoPIsD1dJM0CLPjZF_songs.html',
    'https://kworb.net/spotify/artist/41MozSoPIsD1dJM0CLPjZF.html',
  ];
  const errors = [];
  for (const kworbUrl of urls) {
    let html;
    try {
      const r = await fetch(kworbUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' } });
      if (!r.ok) { errors.push(`kworb ${r.status} (${kworbUrl})`); continue; }
      html = await r.text();
    } catch(e) { errors.push(`kworb fetch error: ${e.message}`); continue; }

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

    // Try 2: US comma format >= 10 billion (17,517,380,913)
    const hugeNums = [...html.matchAll(/\b(\d{1,3}(?:,\d{3}){3,})\b/g)]
      .map(m => Number(m[1].replace(/,/g, '')))
      .filter(n => n >= 10_000_000_000);
    if (hugeNums.length >= 1) return { total: Math.max(...hugeNums), source: 'kworb' };

    // Try 3: European dot format >= 10 billion (17.517.380.913)
    const euroNums = [...html.matchAll(/\b(\d{1,3}(?:\.\d{3}){3,})\b/g)]
      .map(m => Number(m[1].replace(/\./g, '')))
      .filter(n => n >= 10_000_000_000);
    if (euroNums.length >= 1) return { total: Math.max(...euroNums), source: 'kworb' };

    // Try 4: raw unseparated 11+ digit number (17517380913) — cap at 1T to skip IDs/attributes
    const rawNums = [...html.matchAll(/\b(\d{11,})\b/g)]
      .map(m => Number(m[1]))
      .filter(n => n >= 10_000_000_000 && n < 1_000_000_000_000);
    if (rawNums.length >= 1) return { total: Math.max(...rawNums), source: 'kworb' };

    // Try 5: sum individual track streams from <td> cells (each 10M–5B, total should be >10B)
    const tdNums = [...html.matchAll(/<td[^>]*>\s*([\d,]{7,})\s*<\/td>/g)]
      .map(m => Number(m[1].replace(/,/g, '')))
      .filter(n => n >= 10_000_000 && n < 5_000_000_000);
    if (tdNums.length >= 10) {
      const sum = tdNums.reduce((s, n) => s + n, 0);
      if (sum > 5_000_000_000) return { total: sum, trackCount: tdNums.length, source: 'kworb-sum' };
    }

    // Try 6: mark elements (legacy fallback)
    const marks = [...html.matchAll(/class="mark[^"]*"[^>]*>([\d,]+)/g)]
      .map(m => Number(m[1].replace(/,/g, ''))).filter(n => n >= 1_000_000);
    if (marks.length >= 3) {
      const sorted = [...marks].sort((a, b) => b - a);
      const rest   = sorted.slice(1).reduce((s, n) => s + n, 0);
      if (sorted[0] >= rest * 0.8 && sorted[0] > 500_000_000) return { total: sorted[0], source: 'kworb' };
      return { total: sorted.reduce((s, n) => s + n, 0), trackCount: marks.length, source: 'kworb' };
    }

    errors.push(`kworb no match (${kworbUrl}) len=${html.length} s2k=${html.slice(2000,3000)} s5k=${html.slice(5000,6000)}`);
  }

  throw new Error(errors.join(' | '));
}

async function updateCatalogHistory(total, daily = null, overrideDate = null, forceOverwrite = false) {
  const d    = new Date();
  d.setUTCDate(d.getUTCDate() - 1); // Spotify reports previous day's streams
  const date = overrideDate || `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  const hist = (await redis.get(CAT_HIST_KEY)) || [];
  const ex   = hist.find(h => h.date === date);
  if (ex) {
    // Also overwrite if the stored value looks corrupted (>10× new = stale junk from a bad parse)
    if (forceOverwrite || total > ex.total || ex.total > total * 10) ex.total = total;
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

  // Browser token cache: ?action=cache-anon-token&token=<spotify-anon-token>
  // Called from page load JS (no auth required — token is public and expires in 50 min)
  if (req.query.action === 'cache-anon-token') {
    const token = req.query.token;
    if (!token || typeof token !== 'string' || token.length < 50) {
      return res.status(400).json({ error: 'invalid token' });
    }
    await redis.set(BP_ANON_TOKEN_KEY, { token, expires_at: Date.now() + 50 * 60 * 1000 });
    return res.status(200).json({ ok: true });
  }

  // Browser track-ID cache: POST ?action=cache-track-ids&key=admin  body: {ids:[...]}
  // Called from the admin "Refresh catalog total" button after it enumerates albums
  // in the browser (no rate-limit issues there), so the server never needs to enumerate.
  if (req.query.action === 'cache-track-ids') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) return res.status(401).json({ error: 'Unauthorized' });
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length < 10) return res.status(400).json({ error: 'ids array required' });
    await redis.set(BP_TRACK_IDS_KEY, { ids, ts: Date.now() });
    return res.status(200).json({ ok: true, count: ids.length });
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
    const hist = await updateCatalogHistory(total, daily, overrideDate, true);
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
  try { result = await fetchCatalogViaWorker(); } catch(e) { errors.push(`worker: ${e.message}`); }

  // If the worker returned per-track counts, cache the campaign tracks in Redis
  // so fetchTrackMetadata() can use them directly instead of hitting RapidAPI.
  if (result?.tracks && Object.keys(result.tracks).length > 0) {
    const ts = Date.now();
    Promise.all(
      Object.entries(TRACKS)
        .filter(([, id]) => (result.tracks[id] || 0) > 0)
        .map(([key, id]) => redis.set(`bp_worker_${key}`, { total: result.tracks[id], ts }))
    ).catch(() => {});
  }

  if (!result) { try { result = await fetchCatalogViaRapidAPI(); } catch(e) { errors.push(`rapidapi: ${e.message}`); } }
  if (!result) { try { result = await fetchCatalogViaSpotifyAPI(); } catch(e) { errors.push(`spotify-api: ${e.message}`); } }
  if (!result) { try { result = await fetchCatalogViaKworb(); } catch(e) { errors.push(`kworb: ${e.message}`); } }

  if (!result) {
    if (cached?.total) {
      // Never skip a day: even when every live source fails this run, stamp today's
      // history entry by carrying the last known total forward (no daily delta), so
      // the daily catalog list always advances instead of leaving a gap.
      const hist = await updateCatalogHistory(cached.total, null);
      return res.status(200).json({ ...cached, history: hist, stale: true, errors });
    }
    return res.status(503).json({ error: 'All methods failed. Use ?action=set&total=X&key=<admin> to seed.', errors });
  }

  result.ts = Date.now();
  await redis.set(CAT_CACHE_KEY, result);
  // Compute daily delta from the most recent history entry
  const prevHist  = (await redis.get(CAT_HIST_KEY)) || [];
  const prevEntry = prevHist.length ? prevHist[prevHist.length - 1] : null;
  const daily     = (prevEntry && result.total > prevEntry.total) ? result.total - prevEntry.total : null;
  const hist = await updateCatalogHistory(result.total, daily);
  return res.status(200).json({ ...result, history: hist, ...(errors.length ? { errors } : {}) });
}

// ─────────────────────────────────────────────────────────────────────────────

// Day label is UTC-based ON PURPOSE: Spotify's streaming day resets worldwide at
// 00:00 UTC (= 2am Rome in summer), and the whole site — leaderboard, badges,
// scrobblers — resets on that same boundary. So `todayLabel` must roll at 00:00
// UTC to stay aligned. Late Spotify play-count refreshes land AFTER that reset,
// which is exactly when this label flips and needsDailyUpdate turns true, so the
// canary starts polling right at the reset and catches them. Do NOT switch this
// to Rome-local time — it would desync the campaign tracks from the site reset.
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

  // tracks_only=1 refreshes ONLY the 4 campaign-track cards via the RapidAPI
  // scraper keys and skips the (expensive) catalog-total recompute that a normal
  // cron/force run kicks off afterward. Powers the "campaign tracks only" command.
  const tracksOnly = req.query.tracks_only === '1';

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

  // Read the canary attempt log (newest first): each live canary poll's
  // {ts, got, prev, fresh, trig}. Lets us reconstruct the waiting→catch sequence.
  if (req.query.action === 'canary-log') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const n = Math.min(Number(req.query.n) || 100, 300);
    const raw = await redis.lrange('bp_canary_log_v1', 0, n - 1);
    const entries = (raw || []).map(e => {
      const o = typeof e === 'string' ? JSON.parse(e) : e;
      return { ...o, at: new Date(o.ts).toISOString() };
    });
    return res.status(200).json({ count: entries.length, entries });
  }

  // List pending merge/split anomalies awaiting admin confirmation (public read —
  // it only reports that a big jump was held; resolving it still needs the admin key).
  if (req.query.action === 'anomalies') {
    const out = {};
    for (const t of Object.keys(TRACKS)) {
      const a = await redis.get(`bp_anomaly_${t}`);
      if (a) out[t] = { ...a, at: a.ts ? new Date(a.ts).toISOString() : null };
    }
    return res.status(200).json({ anomalies: out });
  }

  // Confirm a held anomaly: accept = adopt the new value as the baseline (no fake
  // history bar), reject = ignore that value from now on. Either way counting
  // resumes cleanly. ?action=resolve-anomaly&track=ddududu&decision=accept|reject&key=ADMIN
  if (req.query.action === 'resolve-anomaly') {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { track, decision } = req.query;
    if (!TRACKS[track] || (decision !== 'accept' && decision !== 'reject')) {
      return res.status(400).json({ error: 'Requires track and decision=accept|reject' });
    }
    const anomaly = await redis.get(`bp_anomaly_${track}`);
    if (!anomaly) return res.status(404).json({ error: 'No pending anomaly for that track' });

    const lockKey = `bp_lock_${track}`;
    const gotLock = !!(await redis.set(lockKey, '1', { nx: true, ex: 30 }));
    if (!gotLock) return res.status(409).json({ error: 'Track is busy updating, try again in a few seconds' });
    try {
      if (decision === 'accept') {
        // Re-baseline to the merged/corrected value (streams "combined", not a real
        // daily gain) — no history entry, just a new floor so daily recording resumes.
        await redis.set(`bp_prev_${track}`, { total: anomaly.fetched, date: getDateLabel(new Date()) });
        await redis.set(`bp_live_${track}`, { total: anomaly.fetched, ts: Date.now() });
        await redis.del(`bp_ignore_${track}`);
      } else {
        // Ignore this value going forward so it stops re-flagging every fetch.
        await redis.set(`bp_ignore_${track}`, anomaly.fetched);
      }
      await redis.del(`bp_anomaly_${track}`);
      return res.status(200).json({ ok: true, track, decision, anomaly });
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
  // Canary first: we decide whether to fan out to the other three based on
  // whether the canary has booked today's bump, so it must be processed before
  // them. (A cron/force sweep ignores the gate and fetches all four anyway.)
  trackEntries.sort((a, b) => (a[0] === CANARY ? -1 : b[0] === CANARY ? 1 : 0));
  // Set once the canary has today's entry (either it just bumped this request,
  // or an earlier poll already booked it). Gates the non-canary live fetches.
  let canaryDoneToday = false;
  // Set only in the request where the canary FIRST catches today's bump (a real
  // increase, not a cached "already done"). Spotify updates every track's play
  // count together, so the moment the campaign tracks bump the whole catalog is
  // fresh too — we use this to kick the catalog-total refresh right then instead
  // of waiting for the 11pm cron.
  let canaryCaughtBump = false;

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
        // Another request holds the canary lock — read its snapshot so we can
        // still gate the non-canary tracks correctly this pass.
        if (name === CANARY) canaryDoneToday = prevOnly?.date === todayLabel;
        results[name] = { total: cachedOnly?.total || 0, history: histOnly || [], prev: prevOnly ? { total: prevOnly.total, date: prevOnly.date } : null };
        continue;
      }

      const [cached, prev, hist] = await Promise.all([
        redis.get(liveKey),
        redis.get(prevKey),
        redis.get(histKey),
      ]);

      const history   = hist || [];
      // Recorded history days are IMMUTABLE. We deliberately do NOT auto-relabel
      // existing entries here anymore: silently rewriting a stored day's date is
      // what shifted the whole series and moved earlier days' numbers around.
      // Corrections go only through the admin ?action=set-entry / delete-history-entry
      // endpoints (key-gated) — nothing on the normal fetch path may mutate a day
      // that was already written.
      const cacheAge  = cached?.ts ? Date.now() - cached.ts : Infinity;
      // Skip cache if we haven't recorded today's history entry yet, even if the
      // live total is recent — otherwise a fetch that straddles midnight stays
      // cached across the day boundary and the daily diff never gets written.
      const needsDailyUpdate = !prev || prev.date !== todayLabel;
      const isCanary = name === CANARY;
      // Canary gate: while waiting for today's bump, only the canary may hit the
      // API. The other three stay on cache until the canary has booked today
      // (canaryDoneToday) — then they fan out and fetch once to catch the same
      // refresh. A cron/force run bypasses the gate and sweeps all four (the
      // guaranteed daily floor). A track with no cache yet is always allowed to
      // fetch so it can seed itself on first run.
      const gateOpen = isCanary || isCron || isForced
        || (canaryDoneToday && needsDailyUpdate) || !(cached?.total > 0);
      const cacheValid = !gateOpen
        ? (cached?.total || 0) > 0
        : (!isCron && !isForced && cacheAge < getCacheTtlMs(needsDailyUpdate) && (cached?.total || 0) > 0);
      let total;
      let updatedAt = cached?.ts || null;
      let stale = false;
      let advancedToday = false;

      if (cacheValid) {
        total = cached.total;
      } else {
        let data;
        try {
          data = await fetchTrackMetadata(trackId, Number(prev?.total || 0), name);
        } catch(e) {
          errors[name] = { message: e.message, ts: new Date().toISOString() };
          await redis.set(errKey, { message: e.message, ts: Date.now() });
          data = {};
        }
        const fetchedTotal = data?.playCount || 0;
        fetchedLive = true;
        const prevT = Number(prev?.total || 0);
        // Merge/split guard: hold an abnormally large single-day change instead of
        // adopting it. Keep the last-good total + prev so the card neither shows a
        // phantom spike nor freezes; stash a pending anomaly for admin confirmation.
        // A value the admin explicitly rejected (bp_ignore_<track>) stops flagging.
        const ignoredVal = Number((await redis.get(`bp_ignore_${name}`)) || 0);
        const isAnomaly = fetchedTotal > 0 && prevT > 0
          && Math.abs(fetchedTotal - prevT) > MERGE_SPIKE_ABS
          && fetchedTotal !== ignoredVal;
        if (isAnomaly) {
          await redis.set(`bp_anomaly_${name}`, {
            kind:    fetchedTotal > prevT ? 'spike' : 'drop',
            fetched: fetchedTotal,
            prev:    prevT,
            delta:   fetchedTotal - prevT,
            date:    todayLabel,
            ts:      Date.now(),
          });
          total = cached?.total || prevT;  // keep last-good; do NOT adopt or advance
          stale = total > 0;
        } else if (fetchedTotal > 0) {
          total = fetchedTotal;
          updatedAt = Date.now();
          await redis.set(liveKey, { total, ts: updatedAt });
          await redis.del(errKey);
          await redis.del(`bp_anomaly_${name}`);  // value looks normal again — clear any hold
        } else {
          // Live fetch failed (e.g. all RapidAPI keys exhausted) — fall back to
          // the last known-good cached total instead of showing 0.
          total = cached?.total || 0;
          stale = total > 0;
        }

        const prevTotal = Number(prev?.total || 0);

        // Canary attempt log: record every live canary poll so the waiting→catch
        // sequence is reconstructable (e.g. why a late Spotify update wasn't seen
        // until attempt N — scraper cache still stale vs no request came in).
        // Newest-first, capped at 300. Read via ?action=canary-log&key=ADMIN.
        if (isCanary) {
          await redis.lpush('bp_canary_log_v1', {
            ts: Date.now(),
            got: fetchedTotal,               // raw scraper result (0 = fetch failed / all keys stale-or-exhausted)
            prev: prevTotal,                 // total we compared against
            fresh: fetchedTotal > prevTotal, // true = new numbers caught on this attempt
            trig: isCron ? 'cron' : isForced ? 'force' : (req.query._poll ? 'poller' : 'visitor'),
          });
          await redis.ltrim('bp_canary_log_v1', 0, 299);
        }

        if (total > 0 && prevTotal > 0 && total > prevTotal) {
          // Label the new daily entry as the day AFTER the most recent history
          // entry. Spotify publishes finalized streaming days IN ORDER (just
          // sometimes late), so a freshly-caught bump is always the next
          // unrecorded day — regardless of which UTC day we happen to catch it.
          // This replaces the old prev.date/todayLabel gap logic, which mislabeled
          // late catches (Aug-4-as-Aug-5 style) and left spurious "N-day gap"
          // notes that needed the relabel band-aid above. Same lag-proof rule as
          // the artist fetch (snapshot_date_for). prev.date still tracks todayLabel
          // (below) purely to drive the needsDailyUpdate gate, not the labels.
          const lastEntry = history[history.length - 1];
          const yLabel = lastEntry ? addDaysToLabel(lastEntry.date, 1) : yesterdayLabel();
          const dailyStreams = total - prevTotal;
          const existing = history.find(h => h.date === yLabel);
          // Never record a day in the FUTURE relative to the current UTC streaming
          // day. If the day-after-last would land past today — e.g. today's entry
          // is already booked and this is just an intraday nudge, or a forced/cron
          // re-fetch caught the number moving again — do NOT invent tomorrow. Keep
          // the live total fresh (already cached above) and leave history frozen.
          const isFuture = daysBetween(todayLabel, yLabel) > 0;
          if (!existing && !isFuture) {
            history.push({ date: yLabel, streams: dailyStreams });
            if (history.length > 60) history.shift();
            await redis.set(histKey, history);
          }
          // Never overwrite an existing entry, and never create a future-dated one
          // — recorded days are immutable on the normal fetch path.

          await redis.set(prevKey, { total, date: todayLabel });
          advancedToday = true;
          // Canary just caught a real daily increase → the catalog is fresh too.
          if (isCanary) canaryCaughtBump = true;
        }

        if (total > 0 && !prev) {
          await redis.set(prevKey, { total, date: todayLabel });
          advancedToday = true;
        }
      }

      // The canary is processed first; record whether today's bump is now booked
      // so the remaining (non-canary) tracks know whether to fan out and fetch.
      if (isCanary) canaryDoneToday = !needsDailyUpdate || advancedToday;

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

  // Surface any held merge/split anomalies so the admin banner can prompt to confirm.
  const anomalies = {};
  for (const name of Object.keys(TRACKS)) {
    const a = await redis.get(`bp_anomaly_${name}`);
    if (a) anomalies[name] = a;
  }

  // Trigger catalog total update (fire-and-forget, no await) when:
  //   - the canary just caught today's bump (Spotify updates all counters
  //     together, so the whole catalog is fresh the moment the tracks move —
  //     this is the primary path now, catching it in the small hours), OR
  //   - a cron/force sweep ran (the 11pm floor / manual refresh).
  // Skipped when tracks_only=1 — that path is campaign cards only.
  if ((canaryCaughtBump || isCron || isForced) && fetchedLive && !tracksOnly) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'blinksunited.com';
    fetch(`https://${host}/api/streams?catalog=1&force=1&key=${process.env.ADMIN_SECRET || ''}`).catch(() => {});
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.status(200).json({
    ...results,
    _debug: { keyCounts, errors, live: fetchedLive, prev: prevSnaps, anomalies, ts: new Date().toISOString() },
  });
}
