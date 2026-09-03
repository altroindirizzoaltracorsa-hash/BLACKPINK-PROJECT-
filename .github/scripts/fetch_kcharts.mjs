// Fetch Korean music charts from 가이섬 (xn--o39an51b2re.com), a Next.js chart
// aggregator, filter each chart to BLACKPINK + members (Jisoo/Jennie/Rosé/Lisa),
// and write data/kcharts-latest.json (+ a dated copy). Same JSON-file pattern as
// the Apple/iTunes/YouTube trackers — committed by .github/workflows/fetch-kcharts.yml.
//
// Read side: the chart page embeds the whole chart as JSON in
//   <script id="__NEXT_DATA__">…</script>  -> props.pageProps -> a list of rows
//   { ranking, previous, like, song{ name, link, artists:[{name,nameEn}], … } }
// We match on the ARTIST field (not the song title) so a song merely *titled*
// "ROSE" by another act is never mistaken for ROSÉ. Distinctive member tokens
// (jennie/jisoo/lisa/blackpink + Korean) are also honoured inside a title so
// featured credits like "SPOT! (Feat. JENNIE)" are caught.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '..', '..', 'data');
const BASE      = 'https://xn--o39an51b2re.com';

// Every song-ranking chart on the site (kr = 가이섬's exact menu label so it's
// easy to cross-check), including Melon's "5분 차트" 5-minute snapshots — the
// freshest ranking Melon exposes. Skipped: the "그래프" graph views, the "추이"
// trend views (they 500), and "이용자 수" listener-count views — none are the
// standard song rankings. Charts are kept even when no BLACKPINK/member is
// charting (they may enter later).
const CHARTS = [
  // Melon
  { service: 'Melon',   type: 'Realtime',            kr: '실시간 차트',              path: '/chart/melon/realtime' },
  { service: 'Melon',   type: 'Realtime 5-min',      kr: '5분 차트',                 path: '/chart/melon/realtime-five' },
  { service: 'Melon',   type: 'Daily',               kr: '일간 차트',                path: '/chart/melon/daily' },
  { service: 'Melon',   type: 'Weekly',              kr: '주간 차트',                path: '/chart/melon/weekly' },
  { service: 'Melon',   type: 'Monthly',             kr: '월간 차트',                path: '/chart/melon/monthly' },
  { service: 'Melon',   type: 'Yearly',              kr: '연간 차트',                path: '/chart/melon/yearly' },
  { service: 'Melon',   type: 'TOP100',              kr: 'TOP100',                   path: '/chart/melon/top100' },
  { service: 'Melon',   type: 'HOT100 (30d)',        kr: 'HOT100 (30일)',            path: '/chart/melon/hot100-d30' },
  { service: 'Melon',   type: 'HOT100 (100d)',       kr: 'HOT100 (100일)',           path: '/chart/melon/hot100-d100' },
  { service: 'Melon',   type: 'HOT100 5-min',        kr: 'HOT100 5분 차트',          path: '/chart/melon/hot100-five' },
  { service: 'Melon',   type: '24Hits',              kr: '24Hits',                   path: '/chart/melon/24hits' },
  { service: 'Melon',   type: '24Hits Newest (1w)',  kr: '최신 24Hits (1주)',        path: '/chart/melon/24hits-newest-w1' },
  { service: 'Melon',   type: '24Hits Newest (4w)',  kr: '최신 24Hits (4주)',        path: '/chart/melon/24hits-newest-w4' },
  { service: 'Melon',   type: 'Newest (1w)',         kr: '최신차트 (1주)',           path: '/chart/melon/newest-w1' },
  { service: 'Melon',   type: 'Newest (4w)',         kr: '최신차트 (4주)',           path: '/chart/melon/newest-w4' },
  { service: 'Melon',   type: 'Daily Long-run',      kr: '일간 차트 연속 진입 일수', path: '/chart/melon/daily-long-run' },
  // Genie
  { service: 'Genie',   type: 'Realtime',            kr: '실시간 차트',              path: '/chart/genie/realtime' },
  { service: 'Genie',   type: 'Daily',               kr: '일간 차트',                path: '/chart/genie/daily' },
  // Bugs
  { service: 'Bugs',    type: 'Realtime',            kr: '실시간 차트',              path: '/chart/bugs/realtime' },
  { service: 'Bugs',    type: 'Daily',               kr: '일간 차트',                path: '/chart/bugs/daily' },
  // FLO
  { service: 'FLO',     type: '24 Hour',             kr: 'FLO 차트',                 path: '/chart/flo/24hour' },
  // Vibe
  { service: 'Vibe',    type: 'Daily',               kr: '일간 차트',                path: '/chart/vibe/daily' },
  // Circle
  { service: 'Circle',  type: 'Digital Weekly',      kr: '주간 디지털 차트',         path: '/chart/circle/digital-weekly' },
  // YouTube
  { service: 'YouTube', type: 'Track Weekly',        kr: '주간 인기곡 차트',         path: '/chart/youtube/track-weekly' },
  { service: 'YouTube', type: 'Video Weekly',        kr: '주간 인기 뮤직비디오 차트', path: '/chart/youtube/video-weekly' },
];

// member -> tokens; titleSafe=false tokens only match inside artist names (never
// the song title), so a bare "rose" in a title can't false-match ROSÉ.
const RULES = [
  { member: 'JISOO',     tokens: ['jisoo', '지수'],         titleSafe: true },
  { member: 'JENNIE',    tokens: ['jennie', '제니'],        titleSafe: true },
  { member: 'ROSÉ',      tokens: ['rosé', '로제'],          titleSafe: true },
  { member: 'ROSÉ',      tokens: ['rose'],                  titleSafe: false },
  { member: 'LISA',      tokens: ['lisa', '리사'],          titleSafe: true },
  { member: 'BLACKPINK', tokens: ['blackpink', '블랙핑크'], titleSafe: true },
];
// Tag priority: a member solo/collab wins over the group label.
const MEMBER_PRIORITY = ['JISOO', 'JENNIE', 'ROSÉ', 'LISA', 'BLACKPINK'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
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

// Deep-find the chart rows: the first array whose items look like chart rows.
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
  // de-dupe while preserving order, prefer readable (skip pure-duplicate KR/EN pairs)
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
  const base = { key: (def.service + '-' + def.type).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                 service: def.service, type: def.type, kr: def.kr || '', label: def.service + ' · ' + def.type, url };
  try {
    const nd = nextData(await fetchHtml(url));
    const pp = nd?.props?.pageProps;
    const rows = pp ? findRows(pp) : null;
    if (!rows) return { ...base, available: false, totalRows: 0, entries: [] };
    const entries = [];
    for (const r of rows) {
      const song = r.song || {};
      const members = matchMembers(song);
      if (!members.size) continue;
      const member = MEMBER_PRIORITY.find(m => members.has(m)) || [...members][0];
      const rank = r.ranking ?? null;
      const previous = (typeof r.previous === 'number' && r.previous > 0) ? r.previous : null;
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
    return { ...base, available: true, totalRows: rows.length, entries };
  } catch (e) {
    console.error('  !', def.path, '->', e.message);
    return { ...base, available: false, totalRows: 0, entries: [] };
  }
}

// Melon Global-K Chart: unlike the others this ranks ARTISTS (not songs) by
// global popularity, aggregating Korea/China/Japan. It's an Astro SPA whose
// rankings come from a JSON API on the mobile host (www 500s, m2 serves it).
// Rows: { ARTISTID, ARTISTNAME, CURRANK, RANKTYPE, RANKGAP, RANK_KR/CN/JP }.
// We match members on ARTISTNAME and reuse the song/artists entry shape so the
// /kcharts renderer needs no change (artist name -> song, country ranks ->
// the sub-line, RANKTYPE/RANKGAP -> the movement arrow).
const GLOBALK = {
  service: 'Melon', type: 'Global-K (Daily)', kr: '글로벌 K 차트',
  // The endpoint is flaky: it intermittently answers a soft HTTP 500
  // ("잠시 후 다시 시도" / try again later) on both hosts, so we retry with
  // backoff and fall back m2 -> www.
  path: '/m6/chart/globalk.json?chartType=D',
  hosts: ['https://m2.melon.com', 'https://www.melon.com'],
  page: 'https://www.melon.com/en/global-k-chart/?chartType=D',
};

async function fetchJsonOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*', 'Accept-Language': 'en,ko;q=0.9', 'Referer': 'https://www.melon.com/en/global-k-chart/' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = JSON.parse(await r.text());
    if (!Array.isArray(data?.response) || !data.response.length) throw new Error('empty response');
    return data;
  } finally { clearTimeout(t); }
}

// Try each host up to `tries` times with backoff. Kept deliberately gentle
// (few requests per run): the endpoint rate-limits bursts, and the hourly job
// cadence is itself the real retry — a transient failure just self-heals next
// hour rather than us hammering the host now.
async function fetchGlobalK(def, tries = 2) {
  let lastErr;
  for (const host of def.hosts) {
    for (let i = 0; i < tries; i++) {
      try { return await fetchJsonOnce(host + def.path); }
      catch (e) {
        lastErr = e;
        if (i < tries - 1) await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

function matchMembersByName(name) {
  const blob = String(name || '').toLowerCase();
  const found = new Set();
  for (const rule of RULES) for (const tok of rule.tokens) { if (blob.includes(tok)) { found.add(rule.member); break; } }
  return found;
}

async function buildGlobalKChart(def) {
  const base = { key: 'melon-global-k-daily', service: def.service, type: def.type, kr: def.kr, label: def.service + ' · ' + def.type, url: def.page };
  try {
    const data = await fetchGlobalK(def);
    const rows = data?.response;
    if (!Array.isArray(rows) || !rows.length) return { ...base, available: false, totalRows: 0, entries: [] };
    const entries = [];
    for (const r of rows) {
      const members = matchMembersByName(r.ARTISTNAME);
      if (!members.size) continue;
      const member = MEMBER_PRIORITY.find(m => members.has(m)) || [...members][0];
      const rank = parseInt(r.CURRANK, 10);
      const gap = parseInt(r.RANKGAP, 10) || 0;
      const type = String(r.RANKTYPE || '').toUpperCase();
      // previous rank so kcMovement() renders the arrow; NEW -> null
      let previous = rank;
      if (type === 'UP') previous = rank + gap;
      else if (type === 'DOWN') previous = rank - gap;
      else if (type === 'NEW') previous = null;
      const countries = [['KR', r.RANK_KR], ['CN', r.RANK_CN], ['JP', r.RANK_JP]]
        .filter(([, v]) => parseInt(v, 10) > 0)
        .map(([c, v]) => c + ' #' + parseInt(v, 10)).join(' · ');
      entries.push({
        rank: Number.isFinite(rank) ? rank : null,
        previous,
        song: r.ARTISTNAME || '',
        artists: countries,
        member,
        link: r.ARTISTID ? ('https://www.melon.com/artist/detail.htm?artistId=' + r.ARTISTID) : null,
      });
    }
    entries.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
    return { ...base, available: true, totalRows: rows.length, entries };
  } catch (e) {
    console.error('  !', def.path, '->', e.message);
    return { ...base, available: false, totalRows: 0, entries: [] };
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const charts = [];
  for (const def of CHARTS) {
    const c = await buildChart(def);
    charts.push(c);
    console.log(`${c.available ? 'ok ' : 'NA '} ${c.label}: ${c.entries.length} BP entr${c.entries.length === 1 ? 'y' : 'ies'} / ${c.totalRows} rows`);
    await new Promise(res => setTimeout(res, 400)); // be polite
  }
  // Global-K artist chart (JSON API) — surfaced first under the Melon tab.
  const gk = await buildGlobalKChart(GLOBALK);
  charts.unshift(gk);
  console.log(`${gk.available ? 'ok ' : 'NA '} ${gk.label}: ${gk.entries.length} BP entries / ${gk.totalRows} rows`);
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const output = {
    generatedAt: now.toISOString(),
    date,
    source: BASE,
    charts,
    summary: {
      chartsChecked: charts.length,
      chartsAvailable: charts.filter(c => c.available).length,
      totalEntries: charts.reduce((n, c) => n + c.entries.length, 0),
    },
  };
  const json = JSON.stringify(output, null, 2);
  writeFileSync(join(DATA_DIR, `kcharts-${date}.json`), json);
  // Only overwrite latest if at least one chart came back (never blank the page on a bad run).
  if (output.summary.chartsAvailable > 0) writeFileSync(join(DATA_DIR, 'kcharts-latest.json'), json);
  console.log(`\nDone: ${output.summary.chartsAvailable}/${output.summary.chartsChecked} charts, ${output.summary.totalEntries} total BP/member entries.`);
}

main().catch(e => { console.error(e); process.exit(1); });
