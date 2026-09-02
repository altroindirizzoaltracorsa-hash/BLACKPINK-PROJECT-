// /api/youtube-history
//
//   ?history=1&ids=<id>,<id>         → read stored hourly snapshots per video
//   ?snapshot=1  (x-admin-secret / Bearer CRON_SECRET)  → capture one snapshot now
//
// Snapshots (views / likes / comments) are appended to a per-video Redis list in
// Upstash (RPUSH + LTRIM), so there's no SQL table to create. An hourly cron
// (youtube-snapshots.yml) calls snapshot mode; the read mode feeds the chart on
// /vs.html. MIN_GAP keeps it to ~one point/hour even if called more often.
//
// Env: YOUTUBE_API_KEY (snapshot), UPSTASH_REDIS_REST_URL / _TOKEN, and one of
// ADMIN_SECRET / CRON_SECRET to authorize snapshot writes.

const YT_API = 'https://www.googleapis.com/youtube/v3/videos';
const DEFAULT_IDS = ['LzgE8ift2Uw', 'h-7_04c_hVc'];
const MAX_POINTS = 2400;              // ~100 days at hourly — keep the full-life gain list
const MIN_GAP_MS = 55 * 60 * 1000;    // don't store more than ~once an hour
const key = id => `bu_yt_hist_${id}`;
const liveKey = id => `bu_yt_live_${id}`;
const pinKey = id => `bu_yt_24h_${id}`;

// 24-hour milestone: freeze each video's exact view/like count at release + 24h.
// Same clock times as the /countdowns cards — SawaDika/LISA = 02:00 Rome
// (00:00 UTC), JISOO = 06:00 Rome (04:00 UTC) — dated to when the teasers dropped
// (Sep 2), so the 24h marks land Sep 3. Keep in sync with vs.html's RELEASE map.
const RELEASE = {
  'LzgE8ift2Uw': '2026-09-02T04:00:00Z', // JISOO — 06:00 Rome (jisoo.io countdown time) → 24h mark Sep 3, 06:00
  'h-7_04c_hVc': '2026-09-02T00:00:00Z', // LISA  — 02:00 Rome (hellosawadika countdown time) → 24h mark Sep 3, 02:00
};
const DAY_MS = 24 * 60 * 60 * 1000;
const PIN_TOL_MS = 95 * 60 * 1000;    // accept a stored point within ~95 min of the exact mark
const markOf = id => (RELEASE[id] ? Date.parse(RELEASE[id]) + DAY_MS : null);
const releaseMs = id => (RELEASE[id] ? Date.parse(RELEASE[id]) : null);

// View thresholds we timestamp (kept in sync with youtube-stats.js). On read we
// ALSO derive crossings straight from the stored series — so a crossing the live
// path missed (deploy gap, quiet moment) is recovered and frozen.
const VIEW_MILESTONES = [
  1e6, 2e6, 3e6, 4e6, 5e6, 10e6, 20e6, 25e6, 30e6, 40e6, 50e6, 75e6,
  100e6, 150e6, 200e6, 250e6, 300e6, 400e6, 500e6, 750e6, 1e9,
];
// First-crossing time for each threshold, interpolated between the bracketing
// samples of a time-ascending [{t,v}] series.
function deriveMilestones(series, relMs) {
  const out = {};
  for (const th of VIEW_MILESTONES) {
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1], b = series[i];
      if (a.v != null && b.v != null && a.v < th && th <= b.v) {
        const frac = (b.v - a.v) > 0 ? (th - a.v) / (b.v - a.v) : 0;
        const tCross = Math.round(a.t + frac * (b.t - a.t));
        out[String(th)] = { v: th, t: tCross, since: relMs != null ? tCross - relMs : null };
        break;
      }
    }
  }
  return out;
}

async function upstash(cmds) {
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  return await r.json(); // [{ result }, ...] in order
}

// Upstash REST returns HGETALL as a flat [field, value, field, value, …] array
// (older) or a plain object (newer). Parse either into { field: parsedJSON }.
function parseHash(result) {
  const out = {};
  if (Array.isArray(result)) {
    for (let i = 0; i < result.length; i += 2) { try { out[result[i]] = JSON.parse(result[i + 1]); } catch {} }
  } else if (result && typeof result === 'object') {
    for (const k of Object.keys(result)) { try { out[k] = JSON.parse(result[k]); } catch {} }
  }
  return out;
}

async function fetchYt(ids, apiKey) {
  const url = `${YT_API}?part=statistics&id=${encodeURIComponent(ids.join(','))}&key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `YouTube API ${r.status}`);
  const out = {};
  for (const it of (j.items || [])) {
    const s = it.statistics || {};
    out[it.id] = {
      v: Number(s.viewCount ?? 0),
      l: s.likeCount != null ? Number(s.likeCount) : null,
      c: s.commentCount != null ? Number(s.commentCount) : null,
    };
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const idsParam = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const ids = (idsParam.length ? idsParam : DEFAULT_IDS).slice(0, 10);
  if (!ids.every(id => /^[A-Za-z0-9_-]{11}$/.test(id))) return res.status(400).json({ error: 'invalid video id' });
  if (!process.env.UPSTASH_REDIS_REST_URL) return res.status(200).json({ error: 'no-store', videos: {} });

  // ── SNAPSHOT (write; cron/admin only) ──────────────────────────────────────
  if (req.query.snapshot) {
    const cronSecret = process.env.CRON_SECRET, adminSecret = process.env.ADMIN_SECRET;
    const given = req.headers['x-admin-secret'] || req.query.key;
    const ok = (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`) || (adminSecret && given === adminSecret);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    const ytKey = process.env.YOUTUBE_API_KEY;
    if (!ytKey) return res.status(200).json({ error: 'not-configured' });
    try {
      const stats = await fetchYt(ids, ytKey);
      const now = Date.now();
      const written = [];
      for (const id of ids) {
        const s = stats[id];
        if (!s) continue;
        const last = await upstash([['LINDEX', key(id), '-1']]);
        let lastT = 0;
        try { lastT = JSON.parse(last[0]?.result)?.t || 0; } catch {}
        if (!req.query.force && now - lastT < MIN_GAP_MS) continue;   // already have this hour
        const point = JSON.stringify({ t: now, v: s.v, l: s.l, c: s.c });
        await upstash([['RPUSH', key(id), point], ['LTRIM', key(id), String(-MAX_POINTS), '-1']]);
        written.push(id);
      }

      // Pin the 24-hour value once the mark has passed (frozen forever). Pick the
      // stored point (hourly snapshot or fine live series) closest to the exact
      // mark; skip until one lands within tolerance so we never pin a stale value.
      const pinned = [];
      for (const id of ids) {
        const mark = markOf(id);
        if (mark == null || now < mark) continue;
        const have = await upstash([['GET', pinKey(id)]]);
        if (have[0]?.result) continue;                                  // already pinned
        const lists = await upstash([['LRANGE', key(id), '0', '-1'], ['LRANGE', liveKey(id), '-1200', '-1']]);
        let best = null;
        for (const arr of [lists[0]?.result || [], lists[1]?.result || []]) {
          for (const str of arr) {
            let p; try { p = JSON.parse(str); } catch { continue; }
            if (!p || !p.t) continue;
            if (!best || Math.abs(p.t - mark) < Math.abs(best.t - mark)) best = p;
          }
        }
        if (!best || Math.abs(best.t - mark) > PIN_TOL_MS) continue;    // no point near the mark yet
        await upstash([['SET', pinKey(id), JSON.stringify({ t: best.t, v: best.v, l: best.l, c: best.c, mark })]]);
        pinned.push(id);
      }
      return res.status(200).json({ ok: true, written, pinned, ts: now });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── HISTORY (read) ── ?live=1 → dense fine series (bu_yt_live_*, last ~1200
  //    points ≈ a few hours) for the live-growing chart; otherwise the hourly
  //    long-term series (bu_yt_hist_*). Both are [{t,v,l,c}] newest-last.
  try {
    const listKey = req.query.live ? liveKey : key;
    const lo = req.query.live ? '-1200' : '0';
    // One pipeline, five id-length blocks: [display series][24h pin][ms hash]
    // [hourly hist series][fine live series]. The last two feed milestone derivation.
    const n = ids.length;
    const parseList = arr => (arr || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    const cmds = ids.map(id => ['LRANGE', listKey(id), lo, '-1'])
      .concat(ids.map(id => ['GET', pinKey(id)]))
      .concat(ids.map(id => ['HGETALL', `bu_yt_ms_${id}`]))
      .concat(ids.map(id => ['LRANGE', key(id), '0', '-1']))
      .concat(ids.map(id => ['LRANGE', liveKey(id), '-1200', '-1']));
    const results = await upstash(cmds);
    const videos = {}, milestones = {}, viewMilestones = {};
    const heal = []; // HSETNX writes to freeze any newly-derived crossing
    ids.forEach((id, i) => {
      videos[id] = parseList(results[i]?.result);
      const m = results[n + i]?.result;
      if (m) { try { milestones[id] = JSON.parse(m); } catch {} }
      const existing = parseHash(results[2 * n + i]?.result);
      // Merge hourly + fine series (time-ascending, deduped) and derive crossings.
      const merged = [...parseList(results[3 * n + i]?.result), ...parseList(results[4 * n + i]?.result)]
        .sort((a, b) => a.t - b.t).filter((p, k, a) => k === 0 || p.t !== a[k - 1].t);
      const derived = deriveMilestones(merged, releaseMs(id));
      for (const th of Object.keys(derived)) {
        if (!(th in existing)) heal.push(['HSETNX', `bu_yt_ms_${id}`, th, JSON.stringify(derived[th])]);
      }
      viewMilestones[id] = { ...derived, ...existing }; // frozen values win over recomputed
    });
    if (heal.length) { try { await upstash(heal); } catch {} }
    return res.status(200).json({ videos, milestones, viewMilestones });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
