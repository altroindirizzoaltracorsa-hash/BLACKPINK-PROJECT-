/**
 * probe-youtube-charts-v27.mjs
 *
 * Mirrors the exact production fetchDailyChart + extractDailyChartEntries
 * path, but logs full structure of content.videos to diagnose why 0 entries
 * are returned in production.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE_ALT = 'https://charts.youtube.com/youtubei/v1/browse?alt=json';

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

async function fetchDailyChart(baseClient, gl, region) {
  const clientGl = region === 'global' ? 'US' : gl.toUpperCase();
  const client = { ...baseClient, gl: clientGl, hl: 'en' };
  const query = [
    'flags=MusicCharts__enable_apac_and_shorts_charts_expansion',
    'perspective=CHART_DETAILS',
    `chart_params_country_code=${region}`,
    'chart_params_chart_type=VIDEOS',
    'chart_params_period_type=DAILY',
  ].join('&');

  console.log(`  POST ${BROWSE_ALT}`);
  console.log(`  query: ${query}`);
  console.log(`  client.gl: ${clientGl}, client.hl: en`);

  const resp = await fetch(BROWSE_ALT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': 'https://charts.youtube.com',
      'Referer': 'https://charts.youtube.com/',
      'X-YouTube-Client-Name': '31',
      'X-YouTube-Client-Version': '2.0',
    },
    body: JSON.stringify({
      browseId: 'FEmusic_analytics_charts_home',
      query,
      context: { client },
    }),
  });

  console.log(`  HTTP ${resp.status}`);
  if (!resp.ok) {
    console.error(`  FAILED: ${resp.status} ${resp.statusText}`);
    return null;
  }
  return resp.json();
}

async function main() {
  console.log('=== Probe v27: Daily chart content.videos structure ===');

  const baseClient = await fetchBaseClient();
  console.log(`Client: ${baseClient.clientName ?? '?'} v${baseClient.clientVersion ?? '?'} gl=${baseClient.gl ?? '?'}`);

  for (const { gl, region, name } of [
    { gl: 'US', region: 'global', name: 'Global' },
    { gl: 'US', region: 'us', name: 'United States' },
    { gl: 'KR', region: 'kr', name: 'South Korea' },
  ]) {
    console.log(`\n=== ${name} (${region}) ===`);
    const data = await fetchDailyChart(baseClient, gl, region);
    if (!data) { console.log('  No data returned'); continue; }

    // Top-level keys
    console.log('  Top-level keys:', Object.keys(data).join(', '));

    // Standard path
    const slr = data?.contents?.sectionListRenderer?.contents;
    console.log(`  sectionListRenderer.contents: ${Array.isArray(slr) ? `Array(${slr.length})` : typeof slr}`);

    const sec0 = slr?.[0];
    console.log('  contents[0] keys:', sec0 ? Object.keys(sec0).join(', ') : 'undefined');

    const mar = sec0?.musicAnalyticsSectionRenderer;
    console.log('  musicAnalyticsSectionRenderer:', mar ? `{${Object.keys(mar).join(', ')}}` : 'MISSING');

    const content = mar?.content;
    console.log('  content:', content ? `{${Object.keys(content).join(', ')}}` : 'NULL/UNDEFINED');

    if (!content) {
      // Walk deeper to see what's in sec0
      console.log('  Full sec0 keys:', sec0 ? JSON.stringify(Object.keys(sec0)) : 'n/a');
      if (sec0) {
        for (const k of Object.keys(sec0)) {
          const v = sec0[k];
          const t = Array.isArray(v) ? `Array(${v.length})` : typeof v;
          console.log(`    sec0.${k}: ${t}`);
        }
      }
      continue;
    }

    // content.videos
    const videos = content.videos;
    console.log(`  content.videos: ${Array.isArray(videos) ? `Array(${videos.length})` : typeof videos}`);

    if (Array.isArray(videos) && videos.length > 0) {
      const v0 = videos[0];
      console.log('  videos[0] keys:', Object.keys(v0).join(', '));
      console.log(`  videos[0].id: ${v0.id}`);
      console.log(`  videos[0].title: ${v0.title}`);
      console.log(`  videos[0].isVisible: ${v0.isVisible}`);
      console.log(`  videos[0].viewCount: ${v0.viewCount}`);
      console.log(`  videos[0].artists: ${JSON.stringify(v0.artists)}`);

      // Check isVisible distribution
      const visibleCount = videos.filter(v => v.isVisible !== false).length;
      const hasId = videos.filter(v => v.id).length;
      console.log(`  videos with id: ${hasId} / ${videos.length}`);
      console.log(`  videos isVisible !== false: ${visibleCount} / ${videos.length}`);

      // Search for Jennie / Less Than
      let found = false;
      for (const v of videos) {
        const combined = ((v.title ?? '') + ' ' + (v.artists ?? []).map(a => a.name ?? '').join(' ')).toLowerCase();
        if (combined.includes('jennie') || combined.includes('less than')) {
          console.log(`  *** BP HIT: "${v.title}" — ${(v.artists ?? []).map(a => a.name).join(', ')} (${v.viewCount} views, isVisible=${v.isVisible})`);
          found = true;
        }
      }
      if (!found) console.log('  No Jennie/Less Than in videos array');
    } else if (!Array.isArray(videos)) {
      // Maybe videos is an object
      console.log('  content.videos is not an array — dumping:', JSON.stringify(videos)?.slice(0, 300));
    }

    // content.perspectiveMetadata
    const pm = content.perspectiveMetadata;
    console.log(`  perspectiveMetadata.entityId: ${pm?.entityId ?? '(absent)'}`);

    // Also search raw JSON for "less than"
    const rawJson = JSON.stringify(data);
    const ltIdx = rawJson.toLowerCase().indexOf('less than');
    if (ltIdx >= 0) {
      console.log(`  "less than" in raw JSON at pos ${ltIdx}: ...${rawJson.slice(Math.max(0, ltIdx - 20), ltIdx + 80)}...`);
    } else {
      console.log('  "less than" NOT in raw JSON');
    }

    // Save raw for region=global only
    if (region === 'global') {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(
        join(DATA_DIR, 'probe-v27-global-daily-raw.json'),
        JSON.stringify(data, null, 2),
      );
      console.log('  Saved full response to data/probe-v27-global-daily-raw.json');
    }
  }

  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
