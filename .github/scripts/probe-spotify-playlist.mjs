/**
 * One-off diagnostic: checks whether we can fetch a specific Spotify playlist
 * (e.g. an editorial "New Music Videos" playlist) via the official Client
 * Credentials OAuth flow + public Web API -- no scraping needed if this works.
 * Safe to remove once the feature (if built) ships.
 */

const PLAYLIST_ID = process.env.PLAYLIST_ID || '37i9dQZEVXbBp04WrWQudL';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID_2 || process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET_2 || process.env.SPOTIFY_CLIENT_SECRET;

const TRACKED_ARTISTS = {
  '41MozSoPIsD1dJM0CLPjZF': 'BLACKPINK',
  '6UZ0ba50XreR4TM8u322gs': 'JISOO',
  '250b0Wlc5Vk0CoUsaCY84M': 'JENNIE',
  '3eVa5w3URK5duf6eyVDbu9': 'ROSÉ',
  '5L1lO4eRHmJ7a0Q6csE5cT': 'LISA',
};

async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`No access_token: ${JSON.stringify(d)}`);
  return d.access_token;
}

async function main() {
  const token = await getToken();
  console.log('Got client-credentials token OK');

  // Playlist metadata (name, description, owner, track count)
  const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}?fields=name,description,owner.display_name,followers.total,tracks.total`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`\nplaylist metadata: status=${metaRes.status}`);
  const meta = await metaRes.json();
  console.log(JSON.stringify(meta, null, 2));

  // Full track list, with position preserved by API order.
  const tracksRes = await fetch(
    `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks?fields=items(track(id,name,artists(id,name),album(images)))&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log(`\nplaylist tracks: status=${tracksRes.status}`);
  const tracksData = await tracksRes.json();
  const items = tracksData.items || [];
  console.log(`total items returned: ${items.length}`);

  console.log('\n=== first 5 tracks (raw, to see whether these are actual music videos) ===');
  for (const item of items.slice(0, 5)) {
    const t = item.track;
    if (!t) continue;
    console.log(`  ${t.id} | ${t.name} | ${(t.artists || []).map(a => a.name).join(', ')}`);
  }

  console.log('\n=== BLACKPINK/member matches (with position = index in playlist) ===');
  let found = 0;
  items.forEach((item, idx) => {
    const t = item.track;
    if (!t || !t.artists) return;
    const match = t.artists.find(a => TRACKED_ARTISTS[a.id]);
    if (match) {
      found++;
      console.log(`  #${idx + 1}: ${t.name} — ${TRACKED_ARTISTS[match.id]} (track id ${t.id})`);
    }
  });
  if (!found) console.log('  none found in this playlist right now');
}

main().catch(e => { console.error(e); process.exit(1); });
