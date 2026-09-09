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
// moment a video first crosses them. Release times come from api/_releases.js —
// this file used to keep its own copy, which never learned about the MVs and so
// stamped `since: null` on their milestones, permanently (HSETNX).
// NOTE: these are duplicated in youtube-history.js and youtube-stats.js on
// purpose. They lived in a shared api/_*.mjs module, and Vercel would not load
// it — the function crashed at import with FUNCTION_INVOCATION_FAILED and both
// endpoints 500'd. Until that is solved on a preview deploy rather than against
// production, the copies stay and MUST be kept in sync: a stale RELEASE here is
// what silently stamped `since: null` on the MVs' milestones.
// Release moments for the videos tracked on /vs.html — the single source of truth.
//
// .mjs, not .js, and that matters: package.json has no "type": "module", so Node
// loads a .js sibling as CommonJS and `const` is a syntax error there.
// Vercel special-cases the route file itself, so youtube-history.js can use ESM,
// but an imported .js sibling is resolved by Node — which threw on every request
// and took the whole read endpoint to a 500. .mjs is always ESM.
//
// This lived as three separate copies: youtube-history.js, youtube-stats.js and
// vs.html. They drifted the moment the MVs were registered, twice over. vs.html
// lost its countdowns and 24h lines (fixed by serving `releases` on the read
// response), and youtube-stats.js — which stamps a milestone the instant it is
// crossed — silently wrote `since: null` for anything it hadn't heard of. Those
// records are written with HSETNX, so a null stamped by the live path could
// never be corrected by the history path afterwards.
//
// Same clock times as the /countdowns cards: LISA 02:00 Rome (00:00 UTC),
// JISOO 06:00 Rome (04:00 UTC).
const RELEASE = {
  'LzgE8ift2Uw': '2026-09-02T04:00:00Z', // JISOO teaser — 06:00 Rome Sep 2 → 24h mark Sep 3, 06:00
  'h-7_04c_hVc': '2026-09-02T00:00:00Z', // LISA teaser  — 02:00 Rome Sep 2 → 24h mark Sep 3, 02:00
  'FyS5dAywkEo': '2026-09-04T00:00:00Z', // LISA MV      — 02:00 Rome Sep 4 → 24h mark Sep 5, 02:00
  'sf02ugzPFE4': '2026-09-04T04:00:00Z', // JISOO MV     — 06:00 Rome Sep 4 → 24h mark Sep 5, 06:00
};

const DAY_MS = 24 * 60 * 60 * 1000;
const releaseMs = id => (RELEASE[id] ? Date.parse(RELEASE[id]) : null);
const markOf = id => (RELEASE[id] ? Date.parse(RELEASE[id]) + DAY_MS : null);
// View thresholds we timestamp, and how crossings are stored.
//
// A threshold can be crossed more than ONCE. YouTube recounts continuously and
// can take the total back below a milestone, after which it is crossed again.
// Every crossing is kept: a later one never replaces an earlier one, they sit
// side by side, so the record shows both when it was first reached and when it
// settled back above. Nothing here overwrites anything.
//
// Storage is one hash per video, bu_yt_ms_<id>:
//
// Every write is HSETNX, so a crossing is written once and re-deriving it on a
// later read can neither duplicate nor restate it. The hour bucket is what makes
// that idempotent: the interpolated crossing time can shift slightly when the
// fine live series is trimmed and a coarser pair of samples takes over, and
// bucketing absorbs that instead of inventing a second crossing from it.
// Kept in sync between youtube-history.js and youtube-stats.js — see the NOTE above.
// Generated, not typed out. Three hand-written versions of this list each shipped
// with a hole in it — 5M→10M lost SaWaDiKa's 6M through 9M, 10M→15M lost its 11M,
// and 20M→25M lost 21M, 22M and 23M — because a threshold that isn't in the list
// isn't merely unshown, it is never recorded. A range with a step can't have a
// gap, so the list is built from ranges.
// Adding a threshold backfills: the read path re-derives crossings from the whole
// stored series, so any already inside it are recovered on the next read rather
// than lost for good. That is why every one of those holes was recoverable.
// Kept in sync between youtube-history.js and youtube-stats.js — see the NOTE above.
const msRange = (from, to, step) => { const a = []; for (let v = from; v <= to; v += step) a.push(v); return a; };
const VIEW_MILESTONES = [
  ...msRange(1e6, 100e6, 1e6),      // every million to 100M — first-week territory
  ...msRange(105e6, 300e6, 5e6),    // every 5M to 300M
  ...msRange(310e6, 1e9, 10e6),     // every 10M to a billion
  ...msRange(1.05e9, 5e9, 50e6),    // every 50M past it
];

const HOUR = 3600000;
const bucketOf = t => Math.floor(t / HOUR);
const crossingField = (th, t) => `${th}@${bucketOf(t)}`;

// { field: record } → { threshold: [record, …] }, oldest crossing first.
// Two records in the same hour bucket are the same crossing, so the later write
// simply lands on the same slot rather than appearing twice.
function groupCrossings(hash) {
  const byTh = {};
  for (const [field, rec] of Object.entries(hash || {})) {
    if (!rec || rec.t == null) continue;
    const th = String(field).split('@')[0];
    (byTh[th] = byTh[th] || new Map()).set(bucketOf(rec.t), rec);
  }
  const out = {};
  for (const th of Object.keys(byTh)) out[th] = [...byTh[th].values()].sort((a, b) => a.t - b.t);
  return out;
}

// Union of what's frozen and what we just recomputed. Frozen wins its bucket —
// a stored crossing is never restated — but it no longer hides the others.
function mergeCrossings(stored, derived) {
  const out = {};
  for (const th of new Set([...Object.keys(stored || {}), ...Object.keys(derived || {})])) {
    const m = new Map();
    for (const c of (derived?.[th] || [])) m.set(bucketOf(c.t), c);
    for (const c of (stored?.[th] || [])) {
      const bk = bucketOf(c.t), d = m.get(bk);
      m.set(bk, (c.t0 == null && d && d.t0 != null) ? { ...c, t0: d.t0, t1: d.t1, v0: d.v0, v1: d.v1 } : c);
    }
    out[th] = [...m.values()].sort((a, b) => a.t - b.t);
  }
  return out;
}

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

// Admin-only, like the rest of this working view. The page sends the key as a
// header rather than ?key= so the secret stays out of URLs, referrers and access
// logs; ?key= and Bearer CRON_SECRET still work for jobs.
const authed = req => {
  const cronSecret = process.env.CRON_SECRET, adminSecret = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-secret'] || req.query.key;
  return (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`)
      || (adminSecret && given === adminSecret);
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  if (!ids.every(id => /^[A-Za-z0-9_-]{11}$/.test(id))) return res.status(400).json({ error: 'invalid video id' });

  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

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
            // Bracket bounds travel with the record — see deriveMilestones in
            // youtube-history.js. Here they are ~15s apart, so the time is as
            // good as observed; the read path's brackets can be an hour wide.
            const rec = JSON.stringify({ v: th, t: tCross, since: rel != null ? tCross - rel : null,
                                         t0: prev.t, t1: payload.ts, v0: prev.v, v1: v.views });
            // One field per crossing. A threshold can be crossed again after a
            // recount takes the total back under it, and both are kept — the
            // plain field holds the first, so older records still read.
            cmds.push(['HSETNX', 'bu_yt_ms_' + v.id, crossingField(th, tCross), rec]);
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
      videos.forEach((v, i) => { vm[v.id] = groupCrossings(parseHash(hashes[i]?.result)); });
      payload.viewMilestones = vm;
    } catch {}
    await upstashSetEx(cacheKey, payload, CACHE_TTL);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
