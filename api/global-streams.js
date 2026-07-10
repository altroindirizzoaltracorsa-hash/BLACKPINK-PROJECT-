const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey':        SUPABASE_SERVICE_KEY,
      'Content-Type':  'application/json',
      ...options.headers,
    },
    ...options,
  });
  return res;
}

async function getSpotifyToken() {
  const res = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } },
  );
  if (!res.ok) throw new Error(`Spotify token: ${res.status}`);
  const data = await res.json();
  if (!data.accessToken) throw new Error('accessToken missing from Spotify response');
  return data.accessToken;
}

async function fetchPlayCountPartner(token, trackId) {
  const variables  = JSON.stringify({ uri: `spotify:track:${trackId}` });
  const extensions = JSON.stringify({
    persistedQuery: { version: 1, sha256Hash: 'ae85b52abb74d20a4c331d4143d4772c95f34757a435d55406e6a2f17ad41c42' },
  });
  const url = `https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack` +
    `&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`partner API: ${res.status}`);
  const data = await res.json();
  const count = data?.data?.trackUnion?.playcount;
  if (!count) throw new Error('playcount missing in partner response');
  return Number(count);
}

async function fetchPlayCountScrape(trackId) {
  const res = await fetch(`https://open.spotify.com/track/${trackId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`track page: ${res.status}`);
  const html = await res.text();
  const m1 = html.match(/"playCount":"(\d+)"/);
  if (m1) return Number(m1[1]);
  const m2 = html.match(/"playcount":"(\d+)"/i);
  if (m2) return Number(m2[1]);
  throw new Error('playCount not found in page HTML');
}

async function fetchPlayCount(token, trackId) {
  try {
    return await fetchPlayCountPartner(token, trackId);
  } catch (e1) {
    try {
      return await fetchPlayCountScrape(trackId);
    } catch (e2) {
      throw new Error(`partner: ${e1.message}; scrape: ${e2.message}`);
    }
  }
}

async function storeSnapshot(date, jumpTotal, shutdownTotal, ddududuTotal) {
  // Get the most recent previous snapshot for delta computation
  const prevRes = await sb(
    `/global_stream_snapshots?date=lt.${date}&order=date.desc&limit=1&select=jump_total,shutdown_total,ddududu_total`,
    { headers: { Accept: 'application/json' } },
  );
  const prevRows = prevRes.ok ? await prevRes.json() : [];
  const prev = prevRows[0] ?? null;

  const jumpDaily     = prev != null ? jumpTotal     - prev.jump_total     : null;
  const shutdownDaily = prev != null ? shutdownTotal - prev.shutdown_total : null;
  const ddududuDaily  = prev != null ? ddududuTotal  - prev.ddududu_total  : null;

  // Upsert the snapshot row
  await sb('/global_stream_snapshots', {
    method:  'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      date,
      jump_total:     jumpTotal,
      shutdown_total: shutdownTotal,
      ddududu_total:  ddududuTotal,
      jump_daily:     jumpDaily,
      shutdown_daily: shutdownDaily,
      ddududu_daily:  ddududuDaily,
    }),
  });

  // Recompute the immediately following day's delta
  const nextRes = await sb(
    `/global_stream_snapshots?date=gt.${date}&order=date.asc&limit=1&select=date,jump_total,shutdown_total,ddududu_total`,
    { headers: { Accept: 'application/json' } },
  );
  const nextRows = nextRes.ok ? await nextRes.json() : [];
  const next = nextRows[0] ?? null;

  if (next) {
    await sb(`/global_stream_snapshots?date=eq.${next.date}`, {
      method:  'PATCH',
      body: JSON.stringify({
        jump_daily:     next.jump_total     - jumpTotal,
        shutdown_daily: next.shutdown_total - shutdownTotal,
        ddududu_daily:  next.ddududu_total  - ddududuTotal,
      }),
    });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── POST: manual backfill (admin only) ───────────────────────────────────
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
      await storeSnapshot(date, Number(jump_total), Number(shutdown_total), Number(ddududu_total));
      return res.status(200).json({ ok: true, date });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET ?history=1: public stream history ────────────────────────────────
  if (req.query.history) {
    const limit = Math.min(Number(req.query.limit ?? 30), 365);
    const r = await sb(
      `/global_stream_snapshots?order=date.desc&limit=${limit}&select=date,jump_total,shutdown_total,ddududu_total,jump_daily,shutdown_daily,ddududu_daily`,
      { headers: { Accept: 'application/json' } },
    );
    const data = r.ok ? await r.json() : [];
    return res.status(200).json({ data });
  }

  // ── GET (cron): fetch from Spotify + store snapshot ──────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const today = new Date().toISOString().split('T')[0];
    const token = await getSpotifyToken();
    const [jumpTotal, shutdownTotal, ddududuTotal] = await Promise.all([
      fetchPlayCount(token, TRACKS.jump),
      fetchPlayCount(token, TRACKS.shutdown),
      fetchPlayCount(token, TRACKS.ddududu),
    ]);
    await storeSnapshot(today, jumpTotal, shutdownTotal, ddududuTotal);
    return res.status(200).json({ ok: true, date: today, jump: jumpTotal, shutdown: shutdownTotal, ddududu: ddududuTotal });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
