/**
 * probe-youtube-charts-v24.mjs
 *
 * Probe: find the daily chart endpoint using proto-encoded params and global region.
 * The FEmusic_analytics_charts_home browseId always returns weekly regardless of query params.
 * Daily charts must use either a different browseId or a proto-encoded `params` field.
 *
 * InnerTube proto hint: field tag byte + value.
 * Trying common encodings for "DAILY" frequency selector.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE = 'https://charts.youtube.com/youtubei/v1/browse';

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchBaseClient() {
  const r = await fetch('https://charts.youtube.com/charts/TopVideos/KR', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) { try { Object.assign(cfg, JSON.parse(j)); } catch {} }
  return cfg.INNERTUBE_CONTEXT?.client ?? {};
}

async function tryBrowse(label, baseClient, bodyOverrides) {
  console.log(`\n[${label}]`);
  const body = {
    browseId: 'FEmusic_analytics_charts_home',
    context: { client: { ...baseClient, hl: 'en' } },
    ...bodyOverrides,
  };

  const resp = await fetch(BROWSE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://charts.youtube.com',
      'Referer': 'https://charts.youtube.com/',
      'X-YouTube-Client-Name': '31',
      'X-YouTube-Client-Version': '2.0',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) { console.log(`  HTTP ${resp.status}`); return null; }
  const data = await resp.json();

  const pm = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata;
  console.log(`  entityId: ${pm?.entityId ?? '(none)'}`);

  const content = data?.contents?.sectionListRenderer?.contents?.[0]
    ?.musicAnalyticsSectionRenderer?.content;
  const trackTypes = content?.trackTypes ?? [];
  for (const tt of trackTypes) {
    const entries = tt.trackViews ?? [];
    console.log(`  [${tt.listType}] ${entries.length} entries`);
    for (const e of entries) {
      const combined = ((e.name ?? '') + ' ' + (e.artists ?? []).map(a => a.name ?? '').join(' ')).toLowerCase();
      if (combined.includes('jennie') || combined.includes('less than')) {
        console.log(`    *** HIT: #${e.chartEntryMetadata?.currentPosition} "${e.name}" — ${(e.artists ?? []).map(a => a.name).join(', ')} (${e.viewCount} views)`);
      }
    }
    entries.slice(0, 2).forEach(e => {
      console.log(`    sample: #${e.chartEntryMetadata?.currentPosition} "${e.name}" — ${(e.artists ?? []).map(a => a.name).join(', ')}`);
    });
  }
  return { entityId: pm?.entityId, trackTypeCount: trackTypes.length };
}

async function main() {
  console.log('=== Probe v24: Daily chart via proto params + global region ===');
  const baseClient = await fetchBaseClient();
  console.log(`Client: ${baseClient.clientName} v${baseClient.clientVersion}\n`);

  // Proto-encoded params candidates for "daily" frequency:
  // Field 1 varint 1 = \x08\x01 = base64 "CAE="
  // Field 1 varint 2 = \x08\x02 = base64 "CAI="
  // Field 2 varint 1 = \x10\x01 = base64 "EAE="
  // Field 3 varint 1 = \x18\x01 = base64 "GAE="
  const paramsCandidates = [
    'CAE=', 'CAI=', 'EAE=', 'GAE=',
    // "daily" as string field: field 1 string "daily"
    'CgVkYWlseQ==',
    // "DAILY" as string
    'CgVEQUlMWQ==',
  ];

  for (const params of paramsCandidates) {
    await tryBrowse(`params=${params} (US)`, baseClient, {
      params,
      query: JSON.stringify({ region: 'us' }),
      context: { client: { ...baseClient, gl: 'US', hl: 'en' } },
    });
    await delay(200);
  }

  // Try global region (gl=global or no gl)
  await tryBrowse('global region (gl=GLOBAL)', baseClient, {
    query: JSON.stringify({ region: 'global' }),
    context: { client: { ...baseClient, gl: 'GLOBAL', hl: 'en' } },
  });
  await delay(300);

  await tryBrowse('global region (no gl)', baseClient, {
    query: JSON.stringify({ region: 'global' }),
    context: { client: { ...baseClient, hl: 'en' } },
  });
  await delay(300);

  // Try explicit daily entityId in query
  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  await tryBrowse(`explicit daily entityId (today=${today})`, baseClient, {
    query: JSON.stringify({ entityId: `daily:${today}:${today}:us` }),
    context: { client: { ...baseClient, gl: 'US', hl: 'en' } },
  });
  await delay(300);

  // Try browseId variants
  for (const browseId of [
    'FEmusic_analytics_charts_home_daily',
    'FEmusic_charts_home',
    'FEmusic_analytics_daily_charts',
  ]) {
    await tryBrowse(`browseId=${browseId}`, baseClient, {
      browseId,
      query: JSON.stringify({ region: 'us' }),
      context: { client: { ...baseClient, gl: 'US', hl: 'en' } },
    });
    await delay(200);
  }

  // Try the /browse endpoint on music.youtube.com (different client)
  console.log('\n[music.youtube.com browse - daily charts attempt]');
  const musicResp = await fetch('https://music.youtube.com/youtubei/v1/browse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://music.youtube.com',
      'Referer': 'https://music.youtube.com/',
      'X-YouTube-Client-Name': '67',
      'X-YouTube-Client-Version': '1.0',
    },
    body: JSON.stringify({
      browseId: 'FEmusic_charts',
      context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.0', hl: 'en', gl: 'US' } },
    }),
  });
  console.log(`  HTTP ${musicResp.status}`);
  if (musicResp.ok) {
    const md = await musicResp.json();
    const header = JSON.stringify(md).slice(0, 500);
    console.log(`  response preview: ${header}`);
  }

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
