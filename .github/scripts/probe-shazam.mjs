/**
 * One-off probe: verify Shazam's public web endpoints (same ones the
 * reverse-engineered ShazamIO Python library uses) are reachable and return
 * usable JSON, before building a real fetch script around them.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

async function probe(label, url) {
  console.log(`\n=== ${label} ===\n${url}`);
  try {
    const r = await fetch(url, { headers: HEADERS });
    console.log(`status=${r.status}`);
    const text = await r.text();
    console.log(`body (first 500 chars): ${text.slice(0, 500)}`);
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    return null;
  }
}

// 1. Locations (world + per-country playlist IDs for the official Shazam charts)
const locations = await probe('Locations (chart playlist IDs)', 'https://www.shazam.com/services/charts/locations');
const topPlaylistId = locations?.global?.top?.listid;
console.log(`\nGLOBAL top playlist id: ${topPlaylistId}`);
const krCountry = locations?.countries?.find(c => c.id === 'KR');
console.log(`KR country entry: ${JSON.stringify(krCountry)}`);

// 2. Top world tracks chart, using the playlist id from step 1
if (topPlaylistId) {
  await probe(
    'Top world tracks (chart)',
    `https://www.shazam.com/services/amapi/v1/catalog/us/playlists/${topPlaylistId}/tracks?limit=10&offset=0&l=en`,
  );
}

// 3. Search for a known BLACKPINK song to get its Shazam-internal track id
const search = await probe(
  'Search for "JUMP BLACKPINK"',
  'https://www.shazam.com/services/search/v3/en/us/web/search?query=JUMP%20BLACKPINK&numResults=5&offset=0&types=songs',
);
const firstHit = search?.tracks?.hits?.[0]?.track;
console.log(`\nFirst search hit: ${JSON.stringify(firstHit).slice(0, 300)}`);
const trackId = firstHit?.key;
console.log(`Resolved track id: ${trackId}`);

// 4. Listening counter (total Shazam count) for that track id
if (trackId) {
  await probe('Listening counter', `https://www.shazam.com/services/count/v2/web/track/${trackId}`);
}
