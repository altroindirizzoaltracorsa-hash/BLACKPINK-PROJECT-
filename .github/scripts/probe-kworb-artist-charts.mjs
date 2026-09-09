/**
 * One-off diagnostic: checks whether kworb.net has a genuine per-country
 * daily/weekly ARTIST rank chart (distinct from the song Top 200 pages we
 * already use), before building an artist-charts feature on top of it.
 * Safe to remove once the feature (if built) ships.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CANDIDATE_URLS = [
  'https://kworb.net/spotify/artists.html',
  'https://kworb.net/spotify/listeners.html',
  'https://kworb.net/spotify/country/global_artist_daily.html',
  'https://kworb.net/spotify/country/global_artists_daily.html',
  'https://kworb.net/spotify/artist/daily.html',
  'https://kworb.net/spotify/artists/global_daily.html',
];

async function main() {
  // First, fetch the Spotify section index page to see what's actually linked --
  // more reliable than guessing URL patterns blind.
  const indexRes = await fetch('https://kworb.net/spotify/', { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  console.log(`index page status=${indexRes.status}`);
  if (indexRes.ok) {
    const html = await indexRes.text();
    console.log(`index length=${html.length}`);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    const artistLinks = links.filter(l => /artist/i.test(l));
    console.log('links containing "artist":');
    console.log([...new Set(artistLinks)].slice(0, 30));
  }

  console.log('\n=== candidate URL probes ===');
  for (const url of CANDIDATE_URLS) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
      console.log(`${url} -> ${r.status}`);
      if (r.ok) {
        const html = await r.text();
        const theadMatch = html.match(/<thead>[\s\S]*?<\/thead>/);
        console.log(`  length=${html.length}, thead=${theadMatch ? theadMatch[0].slice(0, 300) : 'none'}`);
      }
    } catch (e) {
      console.log(`${url} -> ERROR ${e.message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
