/**
 * One-off diagnostic: checks whether Spotify's own official charts.spotify.com
 * (Daily/Weekly Top Artists Global, and presumably per-country via region
 * selector) is fetchable -- either the page itself server-renders chart data,
 * or there's a backing API endpoint we can call directly. This would be the
 * most authoritative possible source, if reachable.
 * Safe to remove once the feature (if built) ships.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const pageRes = await fetch('https://charts.spotify.com/charts/view/artist-global-daily/latest', {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
  });
  const html = await pageRes.text();
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
  console.log(`found ${scriptSrcs.length} script tags`);

  // Fetch each JS chunk and grep for API-looking base URLs / fetch calls.
  const apiPatterns = new Set();
  for (const src of scriptSrcs) {
    try {
      const r = await fetch(src, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const js = await r.text();
      // Look for absolute URLs that look like API hosts (not the static asset CDN itself).
      const matches = js.match(/https?:\/\/[a-z0-9.-]*(api|charts-service|gateway|graphql)[a-z0-9.-]*\/[a-zA-Z0-9/_-]*/gi) || [];
      for (const m of matches) apiPatterns.add(m);
      // Also look for relative "/api/..." style path literals.
      const relMatches = js.match(/["'](\/api\/[a-zA-Z0-9/_-]+)["']/g) || [];
      for (const m of relMatches) apiPatterns.add(m);
    } catch {}
  }
  console.log(`\n=== candidate API patterns found across bundles (${apiPatterns.size}) ===`);
  console.log([...apiPatterns].slice(0, 40));
}

main().catch(e => { console.error(e); process.exit(1); });
