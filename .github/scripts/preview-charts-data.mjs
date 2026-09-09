/**
 * One-off: pulls real chart data from Supabase (Daily Songs, Weekly Songs,
 * Daily Artists, Weekly Albums) so it can be used to build/preview the new
 * Charts feature with real numbers before the actual API endpoint ships.
 * Safe to remove once the Charts feature is built.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); process.exit(1); }

  // Latest date with track data
  const latestRows = await sb('/track_daily_stats?select=date&order=date.desc&limit=1');
  const latestDate = latestRows[0]?.date;
  if (!latestDate) { console.error('No track_daily_stats rows found'); process.exit(1); }

  // Trailing 7 days (inclusive) for weekly sums
  const d = new Date(latestDate + 'T00:00:00Z');
  const weekStart = new Date(d.getTime() - 6 * 86400000).toISOString().slice(0, 10);

  const artists = await sb('/tracked_artists?select=spotify_artist_id,name&active=eq.true');
  const artistNameById = Object.fromEntries(artists.map(a => [a.spotify_artist_id, a.name]));

  // --- Daily Songs: latest date, all tracks, sorted by daily_delta desc ---
  const dailyStats = await sb(`/track_daily_stats?date=eq.${latestDate}&select=track_ref,streams,daily_delta&order=daily_delta.desc.nullslast&limit=15`);
  const trackIds = dailyStats.map(r => r.track_ref);
  const tracksById = {};
  if (trackIds.length) {
    const tracks = await sb(`/artist_tracks?id=in.(${trackIds.join(',')})&select=id,artist_id,name,album,album_art_url`);
    for (const t of tracks) tracksById[t.id] = t;
  }
  const dailySongs = dailyStats.map(r => {
    const t = tracksById[r.track_ref] || {};
    return { name: t.name, artist: artistNameById[t.artist_id], album: t.album, streams: r.streams, delta: r.daily_delta };
  });

  // --- Weekly Songs: sum daily_delta over trailing 7 days per track ---
  const weekRows = await sb(`/track_daily_stats?date=gte.${weekStart}&date=lte.${latestDate}&select=track_ref,daily_delta`);
  const weeklyByTrack = {};
  for (const r of weekRows) {
    if (r.daily_delta == null) continue;
    weeklyByTrack[r.track_ref] = (weeklyByTrack[r.track_ref] || 0) + r.daily_delta;
  }
  const weeklyTrackIds = Object.keys(weeklyByTrack).map(Number).sort((a, b) => weeklyByTrack[b] - weeklyByTrack[a]).slice(0, 15);
  const weeklyTracks = weeklyTrackIds.length ? await sb(`/artist_tracks?id=in.(${weeklyTrackIds.join(',')})&select=id,artist_id,name,album`) : [];
  const weeklyTracksById = Object.fromEntries(weeklyTracks.map(t => [t.id, t]));
  const weeklySongs = weeklyTrackIds.map(id => {
    const t = weeklyTracksById[id] || {};
    return { name: t.name, artist: artistNameById[t.artist_id], album: t.album, weeklyStreams: weeklyByTrack[id] };
  });

  // --- Daily Artists: latest date, artist_daily_stats sorted by daily_delta desc ---
  const dailyArtistStats = await sb(`/artist_daily_stats?date=eq.${latestDate}&select=artist_id,total_streams,daily_delta&order=daily_delta.desc.nullslast`);
  const dailyArtists = dailyArtistStats.map(r => ({ name: artistNameById[r.artist_id], total: r.total_streams, delta: r.daily_delta }));

  // --- Weekly Artists: sum daily_delta over trailing 7 days per artist ---
  const weekArtistRows = await sb(`/artist_daily_stats?date=gte.${weekStart}&date=lte.${latestDate}&select=artist_id,daily_delta`);
  const weeklyByArtist = {};
  for (const r of weekArtistRows) {
    if (r.daily_delta == null) continue;
    weeklyByArtist[r.artist_id] = (weeklyByArtist[r.artist_id] || 0) + r.daily_delta;
  }
  const weeklyArtists = Object.entries(weeklyByArtist)
    .sort((a, b) => b[1] - a[1])
    .map(([id, sum]) => ({ name: artistNameById[id], weeklyStreams: sum }));

  // --- Weekly Albums: group all-artists tracks by album, sum weekly deltas ---
  const allTrackIds = Object.keys(weeklyByTrack).map(Number);
  const allTracksMeta = allTrackIds.length ? await sb(`/artist_tracks?id=in.(${allTrackIds.join(',')})&select=id,artist_id,name,album,album_art_url`) : [];
  const albumSums = {};
  for (const t of allTracksMeta) {
    if (!t.album) continue;
    const key = `${t.artist_id}::${t.album}`;
    if (!albumSums[key]) albumSums[key] = { artist: artistNameById[t.artist_id], album: t.album, art: t.album_art_url, weeklyStreams: 0 };
    albumSums[key].weeklyStreams += weeklyByTrack[t.id] || 0;
  }
  const weeklyAlbums = Object.values(albumSums).sort((a, b) => b.weeklyStreams - a.weeklyStreams).slice(0, 10);

  console.log(JSON.stringify({
    latestDate, weekStart,
    dailySongs, weeklySongs, dailyArtists, weeklyArtists, weeklyAlbums,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
