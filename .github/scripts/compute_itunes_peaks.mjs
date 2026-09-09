/**
 * compute_itunes_peaks.mjs
 *
 * Reads all data/itunes-chart-positions-YYYY-MM-DD.json files and
 * computes per-country peak positions and days-on-chart for each song.
 *
 * Output: data/itunes-chart-peaks.json
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR  = join(REPO_ROOT, 'data');

function main() {
  const files = readdirSync(DATA_DIR)
    .filter(f => /^itunes-chart-positions-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  console.log(`Processing ${files.length} dated files…`);

  // byCountry[cc][appleId] = { bestPosition, daysOnChart, firstSeen, lastSeen, name, artists, member, artworkUrl, url }
  const byCountry = {};

  for (const file of files) {
    const date = file.slice('itunes-chart-positions-'.length, -'.json'.length);
    let data;
    try {
      data = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
    } catch (e) {
      console.error(`  Skipping ${file}: ${e.message}`);
      continue;
    }

    for (const [cc, region] of Object.entries(data.regions ?? {})) {
      if (!byCountry[cc]) byCountry[cc] = {};
      for (const hit of (region.hits ?? [])) {
        const id = hit.appleId ?? `${hit.name}__${hit.artists}`;
        if (!byCountry[cc][id]) {
          byCountry[cc][id] = {
            bestPosition: hit.position,
            daysOnChart:  1,
            firstSeen:    date,
            lastSeen:     date,
            name:         hit.name,
            artists:      hit.artists,
            member:       hit.member,
            artworkUrl:   hit.artworkUrl,
            url:          hit.url,
          };
        } else {
          const p = byCountry[cc][id];
          if (hit.position < p.bestPosition) p.bestPosition = hit.position;
          p.daysOnChart++;
          if (date < p.firstSeen) p.firstSeen = date;
          if (date > p.lastSeen)  p.lastSeen  = date;
          if (hit.artworkUrl) p.artworkUrl = hit.artworkUrl;
          if (hit.url)        p.url        = hit.url;
        }
      }
    }
  }

  const output = { generatedAt: new Date().toISOString(), filesProcessed: files.length, byCountry };
  const outPath = join(DATA_DIR, 'itunes-chart-peaks.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);

  let total = 0;
  for (const [cc, songs] of Object.entries(byCountry)) {
    const n = Object.keys(songs).length;
    if (n) { console.log(`  [${cc}] ${n} song(s) tracked`); total += n; }
  }
  console.log(`Total: ${total} song×country entries`);
}

main();
