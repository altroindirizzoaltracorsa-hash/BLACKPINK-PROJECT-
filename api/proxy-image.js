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
  jump:     '502a16cf-fa8a-4fd3-a184-dbd49c10ce5f',
  shutdown: '3420a915-4654-4251-9c5b-43039ca74b66',
  ddududu:  '736f62c7-066c-4dd1-853c-c5cf5934b642',
};
const MC_HEADERS = { 'Authorization': 'Bearer empty', 'Content-Type': 'application/json' };

const SP_TRACKS = {
  jump:     '5H1sKFMzDeMtXwND3V6hRY',
  shutdown: '6tCd8bPvYnceDG7W9M1RMk',
  ddududu:  '69BIczdH6QMnFx7dsSssN8',
};

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
      const today = new Date().toISOString().split('T')[0];
      const token = await getSpotifyToken();
      const [jumpTotal, shutdownTotal, ddududuTotal] = await Promise.all([
        fetchSpotifyPlayCount(token, SP_TRACKS.jump),
        fetchSpotifyPlayCount(token, SP_TRACKS.shutdown),
        fetchSpotifyPlayCount(token, SP_TRACKS.ddududu),
      ]);
      await storeGlobalSnapshot(today, jumpTotal, shutdownTotal, ddududuTotal);
      return res.status(200).json({ ok: true, date: today, jump: jumpTotal, shutdown: shutdownTotal, ddududu: ddududuTotal });
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
    try {
      const ur = await fetch(`${MUSICAT_BASE}/users?user=${encodeURIComponent(mcUser)}`, { headers: MC_HEADERS });
      if (!ur.ok) return res.status(400).json({ error: `User "${mcUser}" not found (${ur.status})` });
      const ud = await ur.json();
      const publicId = ud.publicId ?? ud.id ?? ud.uuid;
      if (!publicId) return res.status(400).json({ error: 'publicId missing' });
      const displayName    = ud.displayName ?? ud.username ?? ud.name ?? mcUser;
      const totalScrobbles = ud.totalScrobbles ?? ud.listenCount ?? null;

      const now        = new Date();
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
      const allTime    = { start: null, end: null };
      const today      = { start: todayStart, end: null };

      const [bpGroupPlays, jisooPlays, lisaPlays, rosePlays, jenniePlays, jumpAll, shutdownAll, ddududuAll, jumpToday, shutdownToday, ddududuToday] = await Promise.all([
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: BLACKPINK_ARTIST }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.jisoo }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.lisa }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.rose }),
        statsPost({ range: allTime, publicUserId: publicId, publicArtistId: MEMBER_ARTIST_IDS.jennie }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.jump }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.shutdown }),
        statsPost({ range: allTime, publicUserId: publicId, publicTrackId: TRACK_IDS.ddududu }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.jump }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.shutdown }),
        statsPost({ range: today,   publicUserId: publicId, publicTrackId: TRACK_IDS.ddududu }),
      ]);
      const memberPlays = { jisoo: jisooPlays, lisa: lisaPlays, rose: rosePlays, jennie: jenniePlays };
      const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

      return res.status(200).json({
        publicId, displayName,
        playcount: totalScrobbles ?? artistPlays,
        artistPlays, bpGroupPlays, memberPlays,
        tracks: { jump: jumpAll, shutdown: shutdownAll, ddududu: ddududuAll },
        today:  { jump: jumpToday, shutdown: shutdownToday, ddududu: ddududuToday },
      });
    } catch(err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // ── Stats.fm stats proxy ───────────────────────────────────────────────
  const sfmUser = req.query.statsfm_user;
  if (sfmUser) {
    try {
      const SFM_BASE    = 'https://api.stats.fm/api/v1';
      const SFM_HEADERS = { 'content-type': 'application/json' };

      const ur = await fetch(`${SFM_BASE}/users/${encodeURIComponent(sfmUser)}`, { headers: SFM_HEADERS });
      if (!ur.ok) return res.status(400).json({ error: `Stats.fm user "${sfmUser}" not found (${ur.status})` });
      const ud = await ur.json();
      const user = ud.item ?? ud;
      const customId    = user.customId ?? user.id ?? sfmUser;
      const displayName = user.displayName ?? customId;

      const [tr, ar, sr] = await Promise.all([
        fetch(`${SFM_BASE}/users/${encodeURIComponent(customId)}/top/tracks?range=lifetime&limit=500`, { headers: SFM_HEADERS }),
        fetch(`${SFM_BASE}/users/${encodeURIComponent(customId)}/top/artists?range=lifetime&limit=50`,  { headers: SFM_HEADERS }),
        fetch(`${SFM_BASE}/users/${encodeURIComponent(customId)}/streams/stats?range=lifetime`,          { headers: SFM_HEADERS }),
      ]);
      if (!tr.ok) return res.status(400).json({ error: 'Could not fetch track stats from Stats.fm' });
      const [td, ad] = await Promise.all([ tr.json(), ar.ok ? ar.json() : Promise.resolve(null), sr.ok ? sr.json() : Promise.resolve(null) ]);
      const items = td.items ?? [];

      const MEMBER_MAP = { 'JISOO': 'jisoo', 'LISA': 'lisa', 'ROSÉ': 'rose', 'JENNIE': 'jennie' };
      let bpGroupPlays = 0;
      const memberPlays = { jisoo: 0, lisa: 0, rose: 0, jennie: 0 };
      for (const item of (ad?.items ?? [])) {
        const n = item.artist?.name;
        const streams = item.streams ?? 0;
        if (n === 'BLACKPINK') bpGroupPlays += streams;
        else if (MEMBER_MAP[n]) memberPlays[MEMBER_MAP[n]] += streams;
      }
      const artistPlays = bpGroupPlays + Object.values(memberPlays).reduce((s, v) => s + v, 0);

      const TRACK_PREFIXES = { jump: 'jump', shutdown: 'shut down', ddududu: 'ddu-du ddu-du' };
      const tracks = {};
      for (const [key, prefix] of Object.entries(TRACK_PREFIXES)) {
        tracks[key] = items
          .filter(i => i.track?.name?.toLowerCase().startsWith(prefix) && i.track?.artists?.some(a => a.name === 'BLACKPINK'))
          .reduce((sum, i) => sum + (i.streams ?? 0), 0);
      }

      return res.status(200).json({
        customId, displayName,
        playcount: artistPlays || Object.values(tracks).reduce((s, v) => s + v, 0),
        artistPlays, bpGroupPlays, memberPlays, tracks,
        today: { jump: 0, shutdown: 0, ddududu: 0 },
      });
    } catch(err) {
      return res.status(400).json({ error: err.message });
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
