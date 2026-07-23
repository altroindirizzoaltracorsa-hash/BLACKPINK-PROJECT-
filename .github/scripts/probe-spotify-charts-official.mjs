/**
 * One-off diagnostic: checks whether Spotify's own official charts.spotify.com
 * (Daily/Weekly Top Artists Global, and presumably per-country via region
 * selector) is fetchable -- either the page itself server-renders chart data,
 * or there's a backing API endpoint we can call directly. This would be the
 * most authoritative possible source, if reachable.
 * Safe to remove once the feature (if built) ships.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const URLS = [
  'https://charts.spotify.com/charts/view/artist-global-daily/latest',
  'https://charts.spotify.com/charts/view/artist-global-weekly/latest',
];

async function main() {
  for (const url of URLS) {
    console.log(`\n=== ${url} ===`);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
      console.log(`status=${r.status}`);
      const html = await r.text();
      console.log(`length=${html.length}`);
      console.log(html.slice(0, 1500));

      // Look for embedded JSON/state blobs, and for BLACKPINK/member names.
      const hasBlackpink = html.includes('BLACKPINK');
      console.log(`\ncontains "BLACKPINK": ${hasBlackpink}`);
      const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
      console.log(`script srcs (first 10): ${JSON.stringify(scriptSrcs.slice(0, 10))}`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  // Try common API path guesses for the backing data.
  console.log('\n=== API path guesses ===');
  const apiGuesses = [
    'https://charts.spotify.com/api/v2/charts/artist-global-daily/latest',
    'https://charts.spotify.com/api/charts/artist-global-daily/latest',
    'https://charts.spotify.com/api/graphql',
  ];
  for (const url of apiGuesses) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,*/*' } });
      console.log(`${url} -> ${r.status}`);
    } catch (e) {
      console.log(`${url} -> ERROR ${e.message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
