const LASTFM_KEY = '666b8ef2f3cc360fbc20df275fba2981';

const TRACKS = {
  jump:     { spotify: '5H1sKFMzDeMtXwND3V6hRY', artist: 'BLACKPINK', track: 'JUMP',          album: 'DEADLINE' },
  shutdown: { spotify: '6tCd8bPvYnceDG7W9M1RMk', artist: 'BLACKPINK', track: 'Shut Down',     album: 'BORN PINK' },
  ddududu:  { spotify: '69BIczdH6QMnFx7dsSssN8', artist: 'BLACKPINK', track: 'DDU-DU DDU-DU', album: 'SQUARE UP' },
};

export default async function handler(req, res) {
  const info = TRACKS[req.query.id];
  if (!info) return res.status(400).json({ error: 'Unknown track' });

  // 1. Spotify oEmbed (most accurate — returns exact single cover)
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${info.spotify}`);
    const d = await r.json();
    if (d.thumbnail_url) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).json({ url: d.thumbnail_url });
    }
  } catch(e) {}

  // 2. Last.fm track.getInfo
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&artist=${encodeURIComponent(info.artist)}&track=${encodeURIComponent(info.track)}&api_key=${LASTFM_KEY}&format=json`;
    const r = await fetch(url);
    const d = await r.json();
    const imgs = d?.track?.album?.image || [];
    const src = imgs.find(i => i.size === 'extralarge')?.[`#text`] || '';
    if (src && !src.includes('2a96cbd8b46e442fc41c2b86b821562f')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).json({ url: src });
    }
  } catch(e) {}

  // 3. iTunes Search
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent('BLACKPINK ' + info.track)}&entity=song&limit=10`);
    const d = await r.json();
    const item = d.results?.find(x => x.artistName?.toLowerCase().includes('blackpink'));
    if (item?.artworkUrl100) {
      const src = item.artworkUrl100.replace('100x100bb.jpg', '600x600bb.jpg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).json({ url: src });
    }
  } catch(e) {}

  res.status(404).json({ error: 'No artwork found' });
}
