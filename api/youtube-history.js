// /api/youtube-history
//
//   ?history=1&ids=<id>,<id>         → read stored hourly snapshots per video
//   ?snapshot=1  (x-admin-secret / Bearer CRON_SECRET)  → capture one snapshot now
//   ?repin=1&ids=… (same auth)       → overwrite a frozen 24h pin (see RE-PIN below)
//
// Reads are not purely read-only: they freeze newly-derived view-milestone
// crossings and the 24h pin with NX writes, so a milestone the cron missed is
// recovered by the next visitor instead of being lost.
//
// Snapshots (views / likes / comments) are appended to a per-video Redis list in
// Upstash (RPUSH + LTRIM), so there's no SQL table to create. An hourly cron
// (youtube-snapshots.yml) calls snapshot mode; the read mode feeds the chart on
// /vs.html. MIN_GAP keeps it to ~one point/hour even if called more often.
//
// Env: YOUTUBE_API_KEY (snapshot), UPSTASH_REDIS_REST_URL / _TOKEN, and one of
// ADMIN_SECRET / CRON_SECRET to authorize snapshot writes.

const YT_API = 'https://www.googleapis.com/youtube/v3/videos';
// s466YCiHfKw is collected for its 7-day figure. It has no RELEASE entry: RELEASE
// drives the release+24h pin, and a 7-day mark is a different thing the pin logic
// doesn't model yet. Collecting it now is what matters — the 7-day value is
// recoverable from the stored series afterwards, a missed sample is not.
const DEFAULT_IDS = ['LzgE8ift2Uw', 'h-7_04c_hVc', 'FyS5dAywkEo', 'sf02ugzPFE4', 's466YCiHfKw'];
const MAX_POINTS = 2400;              // ~100 days at hourly — keep the full-life gain list
const MIN_GAP_MS = 55 * 60 * 1000;    // don't store more than ~once an hour
const key = id => `bu_yt_hist_${id}`;
const liveKey = id => `bu_yt_live_${id}`;
const pinKey = id => `bu_yt_24h_${id}`;

// 24-hour milestone: freeze each video's exact view/like count at release + 24h.
// Same clock times as the /countdowns cards — SawaDika/LISA = 02:00 Rome
// (00:00 UTC), JISOO = 06:00 Rome (04:00 UTC) — dated to when the teasers dropped
// (Sep 2), so the 24h marks land Sep 3. This is the single source of truth for
// release times: the read response carries them as `releases`, so vs.html shows
// countdowns and 24h marks for whatever is listed here without needing its own
// copy. (It used to keep one, and it silently drifted the moment the MVs were
// added here — the MV cards lost their countdown and their 24h line.)
const RELEASE = {
  'LzgE8ift2Uw': '2026-09-02T04:00:00Z', // JISOO — 06:00 Rome (jisoo.io countdown time) → 24h mark Sep 3, 06:00
  'h-7_04c_hVc': '2026-09-02T00:00:00Z', // LISA  — 02:00 Rome (hellosawadika countdown time) → 24h mark Sep 3, 02:00
  // SaWaDiKa full MV. Tracked from here so collection starts the instant it
  // premieres — the /vs.html row for it comes later, and the snapshot job reads
  // DEFAULT_IDS, not the page. Before the premiere YouTube omits it from the
  // videos.list response and the snapshot loop skips it.
  'FyS5dAywkEo': '2026-09-04T00:00:00Z', // LISA MV — premieres 02:00 Rome Sep 4 → 24h mark Sep 5, 02:00
  'sf02ugzPFE4': '2026-09-04T04:00:00Z', // JISOO MV — premieres 06:00 Rome Sep 4 → 24h mark Sep 5, 06:00
};
const DAY_MS = 24 * 60 * 60 * 1000;
const PIN_TOL_MS = 95 * 60 * 1000;    // accept a stored point within ~95 min of the exact mark
const AUDIT_WINDOW_MS = 7 * DAY_MS;   // how long after a mark we keep attributing drops to its audit
const markOf = id => (RELEASE[id] ? Date.parse(RELEASE[id]) + DAY_MS : null);
// The frozen 24h record. `s` (followers) is carried too, so the chart's gold dot
// can be drawn on every metric tab and not just views/likes/comments.
const pinFrom = (p, mark) => ({ t: p.t, v: p.v, l: p.l, c: p.c, s: p.s ?? null, mark });
// Views go DOWN as well as up: YouTube audits a release and removes views it
// decides don't count, and that correction lands *after* the 24h mark. The
// pinned figure and the number people end up quoting can therefore differ.
//
// It can't be re-read. YouTube only exposes the current total, which keeps
// climbing, so there is no way to ask what 24h reads after an audit. But every
// audit shows up as a negative step in the stored series, so summing the drops
// after the mark gives the correction that applies to the pinned number — and it
// keeps updating as further audits land, without touching the frozen pin.
function auditAfter(series, mark, windowMs = AUDIT_WINDOW_MS) {
  let drop = 0, steps = 0, last = null, at = null;
  for (const p of series) {
    if (!p || p.t == null || p.v == null) continue;
    if (p.t < mark) { last = p; continue; }     // keep the last pre-mark point, so the first comparison spans the mark
    if (p.t > mark + windowMs) break;
    if (last && p.v < last.v) { drop += last.v - p.v; steps++; at = p.t; }
    last = p;
  }
  return steps ? { drop, steps, at } : null;
}

// Stored point nearest the mark, or null if nothing lands within tolerance.
const nearestToMark = (points, mark) => {
  let best = null;
  for (const p of points) {
    if (!p || !p.t) continue;
    if (!best || Math.abs(p.t - mark) < Math.abs(best.t - mark)) best = p;
  }
  return best && Math.abs(best.t - mark) <= PIN_TOL_MS ? best : null;
};
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

async function fetchT(url, ms = 4000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal, headers: { accept: 'application/json' } }); }
  finally { clearTimeout(t); }
}
// Live estimated subscriber count (socialcounts → mixerno); null on failure.
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
  const url = `${YT_API}?part=statistics,snippet&id=${encodeURIComponent(ids.join(','))}&key=${encodeURIComponent(apiKey)}`;
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
      s: null,
      channelId: it.snippet?.channelId || null,
    };
  }
  // Channel followers: live estimate primary, YouTube's rounded count as fallback.
  const chIds = [...new Set(Object.values(out).map(o => o.channelId).filter(Boolean))];
  if (chIds.length) {
    const subs = {};
    const live = await Promise.all(chIds.map(async id => [id, await liveSubCount(id)]));
    for (const [id, n] of live) if (n != null) subs[id] = n;
    const missing = chIds.filter(id => subs[id] == null);
    if (missing.length) {
      try {
        const cr = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${encodeURIComponent(missing.join(','))}&key=${encodeURIComponent(apiKey)}`);
        const cj = await cr.json();
        for (const ch of (cj.items || [])) subs[ch.id] = ch.statistics?.hiddenSubscriberCount ? null : (ch.statistics?.subscriberCount != null ? Number(ch.statistics.subscriberCount) : null);
      } catch {}
    }
    for (const o of Object.values(out)) o.s = o.channelId ? (subs[o.channelId] ?? null) : null;
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
        const point = JSON.stringify({ t: now, v: s.v, l: s.l, c: s.c, s: s.s });
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
        const stored = [...(lists[0]?.result || []), ...(lists[1]?.result || [])]
          .map(str => { try { return JSON.parse(str); } catch { return null; } }).filter(Boolean);
        const best = nearestToMark(stored, mark);
        if (!best) continue;                                            // no point near the mark yet
        await upstash([['SET', pinKey(id), JSON.stringify(pinFrom(best, mark))]]);
        pinned.push(id);
      }
      return res.status(200).json({ ok: true, written, pinned, ts: now });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── RE-PIN (write; admin only) ─────────────────────────────────────────────
  // The pin is immutable by design — every other path writes it with NX — but an
  // audit can land after the mark and leave the frozen figure above the number
  // that ends up being quoted. This is the one deliberate way to overwrite it,
  // and it is admin-gated and explicit about what it changed.
  //   ?repin=1&ids=<id>                 → recompute from the stored point nearest the mark
  //   ?repin=1&ids=<id>&v=…&l=…&c=…     → set an exact figure (single id only)
  if (req.query.repin) {
    const cronSecret = process.env.CRON_SECRET, adminSecret = process.env.ADMIN_SECRET;
    const given = req.headers['x-admin-secret'] || req.query.key;
    const ok = (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`) || (adminSecret && given === adminSecret);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    const manual = req.query.v != null;
    if (manual && ids.length !== 1) return res.status(400).json({ error: 'an explicit value needs exactly one id' });
    const repinned = {};
    try {
      for (const id of ids) {
        const mark = markOf(id);
        if (mark == null) { repinned[id] = { skipped: 'no release date, so no mark' }; continue; }
        const had = await upstash([['GET', pinKey(id)]]);
        let was = null; try { was = JSON.parse(had[0]?.result); } catch {}
        let pin;
        if (manual) {
          const num = q => (q == null ? null : (Number.isFinite(Number(q)) ? Number(q) : null));
          const v = num(req.query.v);
          if (v == null) { repinned[id] = { skipped: 'v is not a number' }; continue; }
          pin = { t: num(req.query.t) ?? mark, v, l: num(req.query.l) ?? was?.l ?? null,
                  c: num(req.query.c) ?? was?.c ?? null, s: was?.s ?? null, mark, manual: true };
        } else {
          const lists = await upstash([['LRANGE', key(id), '0', '-1'], ['LRANGE', liveKey(id), '-1200', '-1']]);
          const stored = [...(lists[0]?.result || []), ...(lists[1]?.result || [])]
            .map(str => { try { return JSON.parse(str); } catch { return null; } }).filter(Boolean);
          const best = nearestToMark(stored, mark);
          if (!best) { repinned[id] = { skipped: 'no stored point within tolerance of the mark' }; continue; }
          pin = pinFrom(best, mark);
        }
        await upstash([['SET', pinKey(id), JSON.stringify(pin)]]);
        repinned[id] = { was, now: pin };
      }
      return res.status(200).json({ ok: true, repinned });
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
    const heal = []; // NX writes to freeze any newly-derived crossing / 24h pin
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

      // 24h pin, self-healing. The hourly snapshot job is the primary writer, but
      // GitHub drops scheduled runs (seen: 4-5h gaps against an hourly cron), so a
      // mark can sit uncaptured for hours while the points that would pin it are
      // already sitting in `merged`. Pin it here too — SETNX, so an existing pin
      // always wins and this can never revise a frozen number.
      const mark = markOf(id);
      if (!milestones[id] && mark != null && Date.now() >= mark) {
        const best = nearestToMark(merged, mark);
        if (best) {
          const pin = pinFrom(best, mark);
          heal.push(['SET', pinKey(id), JSON.stringify(pin), 'NX']);
          milestones[id] = pin;   // serve it on this response, not 45s from now
        }
      }
      // Pins frozen before `s` was carried have no followers value; fill it from
      // the stored point at the pinned instant (in-memory only — never rewrites).
      if (milestones[id] && milestones[id].s == null) {
        const at = merged.find(p => p.t === milestones[id].t);
        if (at && at.s != null) milestones[id] = { ...milestones[id], s: at.s };
      }
      // What YouTube has taken back off the counter since the mark. Derived on
      // every read rather than stored, so it keeps up with later audits and the
      // frozen pin is never touched.
      if (milestones[id] && mark != null) {
        const a = auditAfter(merged, mark);
        if (a) milestones[id] = { ...milestones[id], audit: a };
      }
    });
    if (heal.length) { try { await upstash(heal); } catch {} }
    const releases = Object.fromEntries(ids.filter(i => RELEASE[i]).map(i => [i, RELEASE[i]]));
    return res.status(200).json({ videos, milestones, viewMilestones, releases });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
