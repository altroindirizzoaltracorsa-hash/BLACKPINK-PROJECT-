/**
 * Probe v15 — final validation before production script.
 *
 * v14 revealed:
 *   - FEmusic_analytics_charts_home returns 94 chart entities via deepFind(atvExternalVideoId)
 *   - chartEntryMetadata.currentPosition = rank
 *   - encryptedVideoId = YouTube video ID
 *   - Structure: contents.sectionListRenderer.contents[0].musicAnalyticsSectionRenderer.content
 *     .{artists, perspectiveMetadata, trackTypes, videos}
 *   - ChartType enum: 0=UNKNOWN,1=ARTISTS,2=TRACKS,3=VIDEOS,4=TRENDING,5=SHORTS_VIEWS,6=SHORTS_USAGE
 *
 * This version:
 * 1. Drills deeply into content.videos and content.trackTypes to identify chart sections.
 * 2. Prints full chart sorted by currentPosition.
 * 3. Reports all BLACKPINK/member entries with rank + chartType.
 * 4. Tries charts_detail with chartAttributeValue from perspectiveMetadata.entityId.
 * 5. Tests region=kr vs region=global for BLACKPINK coverage differences.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ARTISTS = ['BLACKPINK', 'JENNIE', 'JISOO', 'ROSÉ', 'ROSA', 'LISA', 'Less Than a Lover', 'Pink Venom', 'Shut Down'];
const ENDPOINT = 'https://charts.youtube.com/youtubei/v1/browse';

function snip(v, max = 300) { return String(v).length > max ? String(v).slice(0, max) + '…' : String(v); }

function deepFind(obj, pred, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (pred(obj)) acc.push(obj);
  for (const v of Object.values(obj)) deepFind(v, pred, acc);
  return acc;
}

async function fetchYtcfg() {
  const r = await fetch('https://charts.youtube.com/charts/TopVideos/KR', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const html = await r.text();
  const setCalls = [...html.matchAll(/ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g)];
  let cfg = {};
  for (const [, j] of setCalls) {
    try { Object.assign(cfg, JSON.parse(j)); } catch {}
  }
  return cfg;
}

async function browse(browseId, queryObj, clientCtx, label) {
  const body = { browseId, query: JSON.stringify(queryObj), context: { client: clientCtx } };
  console.log(`\n=== [${label}] ===`);
  const r = await fetch(ENDPOINT, {
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
  console.log(`  HTTP ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';
  if (!r.ok || !ct.includes('json')) {
    const txt = await r.text();
    let parsed; try { parsed = JSON.parse(txt); } catch {}
    if (parsed?.error) console.log(`  error: ${parsed.error.status} — ${parsed.error.message}`);
    else console.log(`  ${snip(txt, 300)}`);
    return null;
  }
  const data = await r.json();
  console.log(`  size: ${JSON.stringify(data).length} bytes`);
  return data;
}

function analyzeContent(data, region) {
  const content = data?.contents?.sectionListRenderer?.contents?.[0]?.musicAnalyticsSectionRenderer?.content;
  if (!content) { console.log('  ERROR: no musicAnalyticsSectionRenderer.content'); return; }

  // Perspective metadata
  const pm = content.perspectiveMetadata ?? {};
  console.log(`  perspectiveMetadata.entityId: ${pm.entityId ?? '(none)'}`);
  console.log(`  perspectiveMetadata.chartRestrictions: ${JSON.stringify(pm.chartRestrictions ?? {})}`);

  // Drill into each top-level key
  for (const key of ['artists', 'trackTypes', 'videos']) {
    const arr = content[key];
    if (!Array.isArray(arr)) continue;
    console.log(`\n  --- content.${key} (${arr.length} items) ---`);
    arr.forEach((item, i) => {
      // Look for chart section info
      const chartType = item.chartType ?? item.type ?? '?';
      const chartName = item.chartName ?? item.name ?? '?';
      const entities = deepFind(item, o => typeof o.atvExternalVideoId === 'string');
      console.log(`    [${i}] chartType=${chartType} name="${chartName}" entities=${entities.length}`);
      // Print top 5 from this section
      entities
        .map(e => ({ pos: e.chartEntryMetadata?.currentPosition ?? 9999, e }))
        .sort((a, b) => a.pos - b.pos)
        .slice(0, 5)
        .forEach(({ pos, e }) => {
          const arts = (e.artists ?? []).map(a => a.name).join(', ');
          console.log(`      #${String(pos).padStart(3)} "${e.name}" — ${arts} (${e.encryptedVideoId})`);
        });
    });
  }

  // Full sorted chart
  const allEntities = deepFind(data, o => typeof o.atvExternalVideoId === 'string');
  const sorted = allEntities
    .map(e => ({ pos: e.chartEntryMetadata?.currentPosition ?? 9999, e }))
    .sort((a, b) => a.pos - b.pos);

  console.log(`\n  === Full chart (${sorted.length} entries) for region=${region} ===`);
  sorted.forEach(({ pos, e }) => {
    const arts = (e.artists ?? []).map(a => a.name).join(', ');
    console.log(`  #${String(pos).padStart(3)} "${e.name}" — ${arts} [${e.encryptedVideoId}]`);
  });

  // BLACKPINK/member filter
  console.log(`\n  === BLACKPINK members in chart (region=${region}) ===`);
  let found = 0;
  sorted.forEach(({ pos, e }) => {
    const arts = (e.artists ?? []).map(a => a.name);
    for (const target of ARTISTS) {
      if (arts.some(a => a.includes(target)) || (e.name ?? '').includes(target)) {
        console.log(`  ★ #${pos} "${e.name}" — ${arts.join(', ')} [${e.encryptedVideoId}]`);
        found++;
        break;
      }
    }
  });
  if (found === 0) console.log('  (none found)');

  return pm.entityId;
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const cfg = await fetchYtcfg();
  const client = cfg.INNERTUBE_CONTEXT?.client ?? {};
  const baseClient = { ...client, hl: 'en' };
  console.log(`  clientName: ${baseClient.clientName}, version: ${baseClient.clientVersion}`);

  // Step 1: KR
  const d_kr = await browse('FEmusic_analytics_charts_home', { region: 'kr' }, baseClient, 'charts_home KR');
  let entityId;
  if (d_kr) entityId = analyzeContent(d_kr, 'kr');

  await delay(400);

  // Step 2: Global (for comparison — do more BLACKPINK appear globally?)
  const d_global = await browse('FEmusic_analytics_charts_home', { region: 'global' }, baseClient, 'charts_home Global');
  if (d_global) analyzeContent(d_global, 'global');

  await delay(400);

  // Step 3: Try charts_detail with chartAttributeValue from perspectiveMetadata.entityId
  console.log('\n=== Step 3: charts_detail with chartAttributeValue ===');
  if (entityId) console.log(`  Using entityId: ${entityId}`);

  // Try chartAttributeValue as entityId from perspectiveMetadata
  for (const ct of [2, 3, 4]) {
    for (const av of [entityId, '', '0', undefined].filter(v => v !== undefined)) {
      const q = { region: 'kr', chartType: ct, periodType: 2 };
      if (av !== '') q.chartAttributeValue = av;
      const d = await browse('FEmusic_analytics_charts_detail', q, baseClient,
        `detail KR ct=${ct} av="${av ?? 'none'}"`);
      if (d) {
        const entities = deepFind(d, o => typeof o.atvExternalVideoId === 'string');
        console.log(`  SUCCESS! ${entities.length} entities`);
        entities.slice(0, 3).forEach(e => {
          const arts = (e.artists ?? []).map(a => a.name).join(', ');
          console.log(`    #${e.chartEntryMetadata?.currentPosition} "${e.name}" — ${arts}`);
        });
        break;
      }
      await delay(150);
    }
  }

  console.log('\n=== Probe v15 complete ===');
}

main().catch(e => { console.error(e); process.exit(1); });
