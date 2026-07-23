/**
 * One-off diagnostic: checks whether kworb.net has per-country daily/weekly
 * ARTIST chart pages under an undocumented URL pattern (not linked from the
 * site index, but possibly still reachable the same way the song daily/weekly
 * pages are), before falling back to a different source for artist charts.
 * Safe to remove once the feature (if built) ships.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const REGIONS = ['global', 'us', 'kr'];
const PATTERNS = [
  region => `https://kworb.net/spotify/country/${region}_artist_daily.html`,
  region => `https://kworb.net/spotify/country/${region}_artists_daily.html`,
  region => `https://kworb.net/spotify/country/${region}_daily_artists.html`,
  region => `https://kworb.net/spotify/artist/${region}_daily.html`,
  region => `https://kworb.net/spotify/artists/${region}_daily.html`,
  region => `https://kworb.net/spotify/${region}_artists.html`,
];

async function main() {
  for (const region of REGIONS) {
    for (const pattern of PATTERNS) {
      const url = pattern(region);
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
        console.log(`${url} -> ${r.status}`);
      } catch (e) {
        console.log(`${url} -> ERROR ${e.message}`);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
