// GET /api/youtube-stats?ids=<id1>,<id2>,...
//
// Live view/like counts for YouTube videos via the Data API v3. Cached ~20s in
// Upstash so many polling visitors share ONE upstream call (protects the daily
// quota — a videos.list call is 1 unit, free quota is 10k/day).
//
// Returns: { ts, videos: [{ id, title, channel, thumb, views, likes, publishedAt }] }
// likes is null when the channel hides its like count.
//
// Env: YOUTUBE_API_KEY (required); UPSTASH_REDIS_REST_URL / _TOKEN (optional cache).

const YT_API = 'https://www.googleapis.com/youtube/v3/videos';
const CACHE_TTL = 14; // seconds — just under the 15s client poll so points stay fresh
const LIVE_MAX = 5760; // fine points kept per video (~24h at ~15s)

// Release times (for "time since release") + the view thresholds we timestamp the
// moment a video first crosses them. Keep RELEASE in sync with youtube-history.js
// and vs.html. Detection runs on this frequent path so crossings are caught within
// ~one 15s sample; the exact crossing time is interpolated between the two samples.
const RELEASE = {
  'LzgE8ift2Uw': '2026-09-02T04:00:00Z', // JISOO teaser — 06:00 Rome
  'h-7_04c_hVc': '2026-09-02T00:00:00Z', // LISA teaser  — 02:00 Rome
};
const releaseMs = id => (RELEASE[id] ? Date.parse(RELEASE[id]) : null);
const VIEW_MILESTONES = [
  1e6, 2e6, 3e6, 4e6, 5e6, 10e6, 20e6, 25e6, 30e6, 40e6, 50e6, 75e6,
  100e6, 150e6, 200e6, 250e6, 300e6, 400e6, 500e6, 750e6, 1e9,
];

async function upstashPipe(cmds) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
  } catch {}
}

// fetch with a hard timeout so a slow third-party never stalls the response.
async function fetchT(url, ms = 4000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal, headers: { accept: 'application/json' } }); }
  finally { clearTimeout(t); }
}
// Live (ticking, estimated) subscriber count for one channel. YouTube only exposes
// a rounded count; these hobby counters interpolate a finer estimate. socialcounts
// first (same source as socialcounts.org), mixerno as backup. Returns null on fail.
async function liveSubCount(channelId) {
  try {
    const r = await fetchT(`https://api.socialcounts.org/youtube-live-subscriber-count/${channelId}`);
    if (r && r.ok) { const d = await r.json(); const est = d?.est?.count ?? d?.est?.subscriberCount ?? d?.api?.count;
      if (est != null && Number.isFinite(Number(est))) return Math.round(Number(est)); }
  } catch {}
  try {
    const r = await fetchT(`https://mixerno.space/api/youtube-channel-counter/user/${channelId}`);
    if (r && r.ok) { const d = await r.json();
      const c = Array.isArray(d?.counts) ? d.counts.find(x => /subscrib/i.test(x?.value || x?.name || '')) : null;
      if (c?.count != null && Number.isFinite(Number(c.count))) return Math.round(Number(c.count)); }
  } catch {}
  return null;
}

// Upstash REST returns HGETALL as a flat [field,value,…] array (older) or a plain
// object (newer). Parse either into { field: parsedJSON }.
function parseHash(result) {
  const out = {};
  if (Array.isArray(result)) {
    for (let i = 0; i < result.length; i += 2) { try { out[result[i]] = JSON.parse(result[i + 1]); } catch {} }
  } else if (result && typeof result === 'object') {
    for (const k of Object.keys(result)) { try { out[k] = JSON.parse(result[k]); } catch {} }
  }
  return out;
}

async function upstashRead(cmds) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return [];
  try {
    const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    return await r.json();
  } catch { return []; }
}

async function upstashGet(k) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return null;
  try {
    const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(k)}`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    });
    const d = await r.json();
    if (d.result == null) return null;
    try { return JSON.parse(d.result); } catch { return null; }
  } catch { return null; }
}
async function upstashSetEx(k, v, ttl) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', k, JSON.stringify(v), 'EX', String(ttl)]]),
    });
  } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  if (!ids.every(id => /^[A-Za-z0-9_-]{11}$/.test(id))) return res.status(400).json({ error: 'invalid video id' });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(200).json({ error: 'not-configured', videos: [] });

  const cacheKey = 'bu_yt_stats_' + ids.join('_');
  const cached = await upstashGet(cacheKey);
  if (cached) { res.setHeader('X-Cache', 'HIT'); return res.status(200).json(cached); }

  try {
    const url = `${YT_API}?part=statistics,snippet&id=${encodeURIComponent(ids.join(','))}&key=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j?.error?.message || `YouTube API ${r.status}` });

    const byId = {};
    for (const it of (j.items || [])) {
      byId[it.id] = {
        id: it.id,
        title: it.snippet?.title || '',
        channel: it.snippet?.channelTitle || '',
        channelId: it.snippet?.channelId || null,
        thumb: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || '',
        views: Number(it.statistics?.viewCount ?? 0),
        likes: it.statistics?.likeCount != null ? Number(it.statistics.likeCount) : null,
        comments: it.statistics?.commentCount != null ? Number(it.statistics.commentCount) : null,
        subscribers: null,
        publishedAt: it.snippet?.publishedAt || null,
      };
    }
    const videos = ids.map(id => byId[id]).filter(Boolean); // preserve request order

    // Channel followers. Primary: a live ticking ESTIMATE from a counter API;
    // fallback: YouTube's rounded count. Cached ~20s in Upstash so the value keeps
    // moving without hammering the third-party service.
    const chIds = [...new Set(videos.map(v => v.channelId).filter(Boolean))].sort();
    if (chIds.length) {
      const subsKey = 'bu_yt_subs_' + chIds.join('_');
      let subs = await upstashGet(subsKey);
      if (!subs) {
        subs = {};
        const live = await Promise.all(chIds.map(async id => [id, await liveSubCount(id)]));
        for (const [id, n] of live) if (n != null) subs[id] = n;
        const missing = chIds.filter(id => subs[id] == null);
        if (missing.length) {
          try {
            const cr = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${encodeURIComponent(missing.join(','))}&key=${encodeURIComponent(key)}`);
            const cj = await cr.json();
            for (const ch of (cj.items || [])) subs[ch.id] = ch.statistics?.hiddenSubscriberCount ? null : (ch.statistics?.subscriberCount != null ? Number(ch.statistics.subscriberCount) : null);
          } catch {}
        }
        await upstashSetEx(subsKey, subs, 20);
      }
      for (const v of videos) v.subscribers = v.channelId ? (subs[v.channelId] ?? null) : null;
    }
    const payload = { ts: Date.now(), videos };
    // Persist a fine-grained point per video on this fresh fetch (cache means ~1
    // write per ~14s regardless of traffic). Powers the live-growing, PERSISTENT
    // chart on /vs.html — unlike socialcounts, which starts empty every visit.
    // Read the previous fine point per video so we can catch view-milestone
    // crossings (1M, 2M, …) between the last sample and this one, then append this
    // sample. The crossing time is interpolated between the two samples; HSETNX
    // makes each milestone record write-once, so concurrent invocations can't dupe.
    const prevIdx = await upstashRead(videos.map(v => ['LINDEX', 'bu_yt_live_' + v.id, '-1']));
    const cmds = [];
    videos.forEach((v, i) => {
      let prev = null; try { prev = JSON.parse(prevIdx[i]?.result); } catch {}
      cmds.push(['RPUSH', 'bu_yt_live_' + v.id, JSON.stringify({ t: payload.ts, v: v.views, l: v.likes, c: v.comments, s: v.subscribers })]);
      cmds.push(['LTRIM', 'bu_yt_live_' + v.id, String(-LIVE_MAX), '-1']);
      if (prev && prev.v != null && v.views > prev.v) {
        const rel = releaseMs(v.id);
        for (const th of VIEW_MILESTONES) {
          if (prev.v < th && th <= v.views) {
            const frac = (th - prev.v) / (v.views - prev.v);
            const tCross = Math.round(prev.t + frac * (payload.ts - prev.t));
            const rec = JSON.stringify({ v: th, t: tCross, since: rel != null ? tCross - rel : null });
            cmds.push(['HSETNX', 'bu_yt_ms_' + v.id, String(th), rec]);
          }
        }
      }
    });
    if (cmds.length) await upstashPipe(cmds);
    // Attach the current milestone stamps so the fast 15s poll shows them promptly
    // (the history endpoint also backfills any the live path missed).
    try {
      const hashes = await upstashRead(videos.map(v => ['HGETALL', 'bu_yt_ms_' + v.id]));
      const vm = {};
      videos.forEach((v, i) => { vm[v.id] = parseHash(hashes[i]?.result); });
      payload.viewMilestones = vm;
    } catch {}
    await upstashSetEx(cacheKey, payload, CACHE_TTL);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
