/**
 * probe-youtube-charts-v22.mjs
 *
 * Probe: dump ALL trackTypes listType values and their entry counts.
 * Also search for "Less Than A Lover" (or any JENNIE song) across all list types.
 * Regions: US, GB, PH, TH, SG, KR (likely candidates for JENNIE charting).
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE = 'https://charts.youtube.com/youtubei/v1/browse';

const PROBE_REGIONS = [
  { gl: 'PH', region: 'ph', name: 'Philippines' },
  { gl: 'TH', region: 'th', name: 'Thailand' },
  { gl: 'SG', region: 'sg', name: 'Singapore' },
  { gl: 'US', region: 'us', name: 'United States' },
  { gl: 'GB', region: 'gb', name: 'United Kingdom' },
  { gl: 'KR', region: 'kr', name: 'South Korea' },
  { gl: 'ID', region: 'id', name: 'Indonesia' },
  { gl: 'MY', region: 'my', name: 'Malaysia' },
];

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

async function fetchChartsHome(baseClient, gl, region) {
  const client = { ...baseClient, gl: gl.toUpperCase(), hl: 'en' };
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
    body: JSON.stringify({
      browseId: 'FEmusic_analytics_charts_home',
      query: JSON.stringify({ region }),
      context: { client },
    }),
  });
  if (!resp.ok) { console.error(`  [${gl}] HTTP ${resp.status}`); return null; }
  return resp.json();
}

async function main() {
  console.log('=== Probe v22: Dump all trackTypes + search for JENNIE songs ===');
  const baseClient = await fetchBaseClient();
  console.log(`  Client: ${baseClient.clientName ?? '?'} v${baseClient.clientVersion ?? '?'}\n`);

  const JENNIE_TERMS = ['jennie', 'less than a lover', 'mantra', 'solo', 'you & me'];

  const allDumps = {};

  for (const { gl, region, name } of PROBE_REGIONS) {
    console.log(`\n--- ${name} (gl=${gl}) ---`);
    const data = await fetchChartsHome(baseClient, gl, region);
    if (!data) { await delay(500); continue; }

    const content = data?.contents?.sectionListRenderer?.contents?.[0]
      ?.musicAnalyticsSectionRenderer?.content;

    if (!content) { console.log('  No content found'); await delay(250); continue; }

    const dump = { region: name, gl, trackTypes: [], artistTypes: [] };

    // Dump all trackTypes
    console.log(`  trackTypes count: ${(content.trackTypes ?? []).length}`);
    for (const tt of (content.trackTypes ?? [])) {
      const entries = tt.trackViews ?? [];
      const typeInfo = {
        listType: tt.listType,
        count: entries.length,
        jennieHits: [],
        sampleEntries: [],
      };

      console.log(`    [${tt.listType}] ${entries.length} entries`);

      for (const e of entries) {
        const name_lc = (e.name ?? '').toLowerCase();
        const artists_lc = (e.artists ?? []).map(a => (a.name ?? '').toLowerCase()).join(' ');
        const combined = name_lc + ' ' + artists_lc;

        const isJennie = JENNIE_TERMS.some(t => combined.includes(t));
        if (isJennie) {
          const hit = {
            position: e.chartEntryMetadata?.currentPosition,
            name: e.name,
            artists: (e.artists ?? []).map(a => a.name),
            viewCount: e.viewCount,
            videoId: e.encryptedVideoId,
          };
          typeInfo.jennieHits.push(hit);
          console.log(`      *** JENNIE HIT: #${hit.position} "${hit.name}" — ${hit.artists.join(', ')} (${hit.viewCount} views)`);
        }

        // Sample first 5 entries of each type
        if (typeInfo.sampleEntries.length < 5) {
          typeInfo.sampleEntries.push({
            position: e.chartEntryMetadata?.currentPosition,
            name: e.name,
            artists: (e.artists ?? []).map(a => a.name),
          });
        }
      }

      // Print sample entries for new list types
      if (tt.listType !== 'TOP_VIEWS_CHART') {
        console.log(`    Sample entries for ${tt.listType}:`);
        typeInfo.sampleEntries.forEach(s => {
          console.log(`      #${s.position} "${s.name}" — ${s.artists.join(', ')}`);
        });
      }

      dump.trackTypes.push(typeInfo);
    }

    // Also check artist chart for JENNIE
    for (const ac of (content.artists ?? [])) {
      for (const av of (ac.artistViews ?? [])) {
        const n = (av.name ?? '').toLowerCase();
        if (JENNIE_TERMS.includes(n) || n === 'jennie') {
          console.log(`  *** JENNIE IN ARTIST CHART: "${av.name}" pos=${av.position}`);
        }
      }
    }

    allDumps[gl] = dump;
    await delay(300);
  }

  // Save full dump
  mkdirSync(DATA_DIR, { recursive: true });
  const outFile = join(DATA_DIR, 'probe-v22-tracktypes-dump.json');
  writeFileSync(outFile, JSON.stringify(allDumps, null, 2));
  console.log(`\n\nSaved full dump: ${outFile}`);
  console.log('=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
