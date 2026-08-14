// Live fetch of Melon's 5분 (5-minute) charts from the 가이섬 aggregator,
// filtered to BLACKPINK + members. These refresh every 5 minutes on the
// source — far faster than the hourly GitHub job that builds
// data/kcharts-latest.json — so the K-Charts page calls this endpoint on
// open and re-polls every 5 min while it stays open, giving true 5-minute
// freshness for these two cards without any schedule hammering the source.
//
// Fetched server-side (no browser CORS) and cached at the edge for ~2 min so
// bursts of visitors share one upstream fetch. Keys/shape mirror the hourly
// script (fetch_kcharts.mjs) so the client can splice these straight over the
// matching static cards.

import { Redis } from '@upstash/redis';

const BASE = 'https://xn--o39an51b2re.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// 가이섬's 5분 charts don't publish a previous-rank (the `previous` field is
// always null), so ▲/▼ movement can't come from the source like it does for
// the other charts. Instead we remember each chart's ranks in Redis and diff
// the next fetch against a baseline that rolls over ~every 5 min — giving a
// true 5-minute up/down for every charting song. Degrades to "NEW" (no
// movement) if Redis is unavailable.
let redis = null;
try { redis = Redis.fromEnv(); } catch { redis = null; }
const PREV_KEY = (chartKey) => 'kc5_prev:' + chartKey;
const REBASE_MS = 270000; // 4.5 min — roll the baseline forward once this elapses

// Stable per-song id for rank memory: fullId > link > name.
function songKey(song) {
  return String(song?.fullId || song?.link || song?.name || '').trim();
}

// The two Melon 5분 charts. `key` is computed the same way the hourly script
// does — (service + '-' + type).toLowerCase().replace(/[^a-z0-9]+/g,'-') — so
// they line up: melon-realtime-5-min / melon-hot100-5-min.
const CHARTS = [
  { service: 'Melon', type: 'Realtime 5-min', kr: '5분 차트',        path: '/chart/melon/realtime-five' },
  { service: 'Melon', type: 'HOT100 5-min',   kr: 'HOT100 5분 차트', path: '/chart/melon/hot100-five' },
];

const RULES = [
  { member: 'JISOO',     tokens: ['jisoo', '지수'],         titleSafe: true },
  { member: 'JENNIE',    tokens: ['jennie', '제니'],        titleSafe: true },
  { member: 'ROSÉ',      tokens: ['rosé', '로제'],          titleSafe: true },
  { member: 'ROSÉ',      tokens: ['rose'],                  titleSafe: false },
  { member: 'LISA',      tokens: ['lisa', '리사'],          titleSafe: true },
  { member: 'BLACKPINK', tokens: ['blackpink', '블랙핑크'], titleSafe: true },
];
const MEMBER_PRIORITY = ['JISOO', 'JENNIE', 'ROSÉ', 'LISA', 'BLACKPINK'];

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.9' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function findRows(o) {
  if (Array.isArray(o)) {
    if (o.length && o[0] && typeof o[0] === 'object' && ('ranking' in o[0]) && ('song' in o[0])) return o;
    return null;
  }
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) { const r = findRows(v); if (r) return r; }
  }
  return null;
}

function artistNames(song) {
  const out = [];
  const push = (a) => {
    if (!a) return;
    if (typeof a === 'string') { out.push(a); return; }
    for (const k of ['name', 'nameEn', 'fullName', 'krName', 'enName']) if (a[k]) out.push(String(a[k]));
  };
  for (const key of ['artists', 'artist', 'artistList', 'singers']) {
    const v = song?.[key];
    if (Array.isArray(v)) v.forEach(push);
    else if (v) push(v);
  }
  return out;
}

function displayArtists(names) {
  const seen = new Set(); const out = [];
  for (const n of names) { const k = n.toLowerCase().trim(); if (k && !seen.has(k)) { seen.add(k); out.push(n); } }
  return out.join(', ');
}

function matchMembers(song) {
  const names = artistNames(song);
  const artistBlob = names.join(' ').toLowerCase();
  const title = String(song?.name || '').toLowerCase();
  const found = new Set();
  for (const rule of RULES) {
    for (const tok of rule.tokens) {
      if (artistBlob.includes(tok)) { found.add(rule.member); break; }
      if (rule.titleSafe && title.includes(tok)) { found.add(rule.member); break; }
    }
  }
  return found;
}

async function buildChart(def) {
  const url = BASE + def.path;
  const key = (def.service + '-' + def.type).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const base = { key, service: def.service, type: def.type, kr: def.kr || '',
                 label: def.service + ' · ' + def.type, url };
  try {
    const nd = nextData(await fetchHtml(url));
    const pp = nd?.props?.pageProps;
    const rows = pp ? findRows(pp) : null;
    if (!rows) return { ...base, available: false, totalRows: 0, entries: [] };

    // Snapshot every song's current rank, and load the last baseline so we can
    // diff for ▲/▼ (the source's own `previous` is null on these charts).
    const curRanks = {};
    for (const r of rows) {
      const k = songKey(r.song || {});
      if (k && r.ranking != null) curRanks[k] = r.ranking;
    }
    let baseline = null;
    if (redis) { try { baseline = await redis.get(PREV_KEY(key)); } catch { baseline = null; } }
    const prevRanks = baseline?.ranks || {};

    const entries = [];
    for (const r of rows) {
      const song = r.song || {};
      const members = matchMembers(song);
      if (!members.size) continue;
      const member = MEMBER_PRIORITY.find(m => members.has(m)) || [...members][0];
      const rank = r.ranking ?? null;
      // Prefer the source's own previous-rank when present (other charts);
      // fall back to our remembered baseline (the 5분 charts).
      let previous = (typeof r.previous === 'number' && r.previous > 0) ? r.previous : null;
      if (previous == null) {
        const p = prevRanks[songKey(song)];
        if (typeof p === 'number' && p > 0) previous = p;
      }
      entries.push({
        rank,
        previous,
        song: song.name || '',
        artists: displayArtists(artistNames(song)),
        member,
        link: song.link || null,
      });
    }
    entries.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));

    // Roll the baseline forward once it's ~5 min old (or missing), so the diff
    // window stays a genuine 5 minutes regardless of how often visitors poll.
    if (redis) {
      const now = Date.now();
      if (!baseline || typeof baseline.at !== 'number' || (now - baseline.at) >= REBASE_MS) {
        try { await redis.set(PREV_KEY(key), { at: now, ranks: curRanks }, { ex: 86400 }); } catch { /* best-effort */ }
      }
    }
    return { ...base, available: true, totalRows: rows.length, entries };
  } catch (e) {
    return { ...base, available: false, totalRows: 0, entries: [], error: e.message };
  }
}

export default async function handler(req, res) {
  try {
    const charts = await Promise.all(CHARTS.map(buildChart));
    // Edge-cache ~2 min; serve stale up to 5 min while revalidating so a burst
    // of visitors never fans out to the source more than a couple times per window.
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
    res.status(200).json({ generatedAt: new Date().toISOString(), source: BASE, charts });
  } catch (e) {
    res.status(200).json({ generatedAt: new Date().toISOString(), source: BASE, charts: [], error: String(e?.message || e) });
  }
}
