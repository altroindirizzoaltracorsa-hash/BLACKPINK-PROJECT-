import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const HOST = 'shazam-core.p.rapidapi.com';
const STATS_TTL = 6 * 3600; // 6-hour cache

function apiKey() {
  return process.env.RAPIDAPI_SHAZAM_KEY || '';
}

function shazamFetch(path) {
  const key = apiKey();
  if (!key) throw new Error('RAPIDAPI_SHAZAM_KEY not configured');
  return fetch(`https://${HOST}${path}`, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST },
  });
}

// Song registry. `searchTerm` overrides the default "{song} {artist}" search.
const SONGS = {
  blackpink: [
    { id: 'bp-jump',            song: 'JUMP',                     artist: 'BLACKPINK', section: 'DEADLINE' },
    { id: 'bp-go',              song: 'GO',                       artist: 'BLACKPINK', section: 'DEADLINE' },
    { id: 'bp-meandmy',         song: 'Me & My',                  artist: 'BLACKPINK', section: 'DEADLINE' },
    { id: 'bp-champion',        song: 'Champion',                 artist: 'BLACKPINK', section: 'DEADLINE' },
    { id: 'bp-fxxxboy',         song: 'Fxxxboy',                  artist: 'BLACKPINK', section: 'DEADLINE' },
    { id: 'bp-pinkvenom',       song: 'Pink Venom',               artist: 'BLACKPINK', section: 'BORN PINK' },
    { id: 'bp-shutdown',        song: 'Shut Down',                artist: 'BLACKPINK', section: 'BORN PINK' },
    { id: 'bp-typagirl',        song: 'Typa Girl',                artist: 'BLACKPINK', section: 'BORN PINK' },
    { id: 'bp-readyforlove',    song: 'Ready For Love',           artist: 'BLACKPINK', section: 'BORN PINK' },
    { id: 'bp-tally',           song: 'Tally',                    artist: 'BLACKPINK', section: 'BORN PINK' },
    { id: 'bp-hardtolove',      song: 'Hard To Love',             artist: 'BLACKPINK', section: 'BORN PINK' },
    { id: 'bp-yeahyeah',        song: 'Yeah Yeah Yeah',           artist: 'BLACKPINK', section: 'BORN PINK' },
    { id: 'bp-happiestgirl',    song: 'The Happiest Girl',        artist: 'BLACKPINK', section: 'BORN PINK' },
    { id: 'bp-hylt',            song: 'How You Like That',        artist: 'BLACKPINK', section: 'THE ALBUM' },
    { id: 'bp-icecream',        song: 'Ice Cream',                artist: 'BLACKPINK', searchTerm: 'Ice Cream BLACKPINK Selena Gomez', section: 'THE ALBUM' },
    { id: 'bp-lovesickgirls',   song: 'Lovesick Girls',           artist: 'BLACKPINK', section: 'THE ALBUM' },
    { id: 'bp-prettysavage',    song: 'Pretty Savage',            artist: 'BLACKPINK', section: 'THE ALBUM' },
    { id: 'bp-lovetohateme',    song: 'Love To Hate Me',          artist: 'BLACKPINK', section: 'THE ALBUM' },
    { id: 'bp-crazyover',       song: 'Crazy Over You',           artist: 'BLACKPINK', section: 'THE ALBUM' },
    { id: 'bp-betyouwanna',     song: 'Bet You Wanna',            artist: 'BLACKPINK', searchTerm: 'Bet You Wanna BLACKPINK Cardi B', section: 'THE ALBUM' },
    { id: 'bp-youneverknow',    song: 'You Never Know',           artist: 'BLACKPINK', section: 'THE ALBUM' },
    { id: 'bp-killthislove',    song: 'Kill This Love',           artist: 'BLACKPINK', section: 'KILL THIS LOVE - EP' },
    { id: 'bp-dkwtd',           song: "Don't Know What To Do",    artist: 'BLACKPINK', section: 'KILL THIS LOVE - EP' },
    { id: 'bp-kickit',          song: 'Kick It',                  artist: 'BLACKPINK', section: 'KILL THIS LOVE - EP' },
    { id: 'bp-hopnot',          song: 'Hope Not',                 artist: 'BLACKPINK', section: 'KILL THIS LOVE - EP' },
    { id: 'bp-dduremix',        song: 'DDU-DU DDU-DU Remix',      artist: 'BLACKPINK', searchTerm: 'DDU-DU DDU-DU Remix BLACKPINK', section: 'KILL THIS LOVE - EP' },
    { id: 'bp-ddududu',         song: 'DDU-DU DDU-DU',            artist: 'BLACKPINK', section: 'SQUARE UP' },
    { id: 'bp-foreveryoung',    song: 'Forever Young',            artist: 'BLACKPINK', section: 'SQUARE UP' },
    { id: 'bp-seeulaer',        song: 'See U Later',              artist: 'BLACKPINK', section: 'SQUARE UP' },
    { id: 'bp-really',          song: 'Really',                   artist: 'BLACKPINK', section: 'SQUARE UP' },
    { id: 'bp-playingwithfire', song: 'PLAYING WITH FIRE',        artist: 'BLACKPINK', section: 'SQUARE TWO' },
    { id: 'bp-stay',            song: 'STAY',                     artist: 'BLACKPINK', section: 'SQUARE TWO' },
    { id: 'bp-whistleacoustic', song: 'WHISTLE (Acoustic Ver.)',   artist: 'BLACKPINK', searchTerm: 'WHISTLE Acoustic BLACKPINK', section: 'SQUARE TWO' },
    { id: 'bp-whistle',         song: 'WHISTLE',                  artist: 'BLACKPINK', section: 'SQUARE ONE' },
    { id: 'bp-boombayah',       song: 'BOOMBAYAH',                artist: 'BLACKPINK', section: 'SQUARE ONE' },
    { id: 'bp-asifitsyourlast', song: "AS IF IT'S YOUR LAST",     artist: 'BLACKPINK', section: 'Others' },
    { id: 'bp-sourcandy',       song: 'Sour Candy',               artist: 'BLACKPINK', searchTerm: 'Sour Candy Lady Gaga BLACKPINK', section: 'Others' },
    { id: 'bp-thegirls',        song: 'THE GIRLS',                artist: 'BLACKPINK', searchTerm: 'THE GIRLS BLACKPINK THE GAME', section: 'Others' },
    { id: 'bp-kissandmakeup',   song: 'Kiss and Make Up',         artist: 'BLACKPINK', searchTerm: 'Kiss and Make Up Dua Lipa BLACKPINK', section: 'Others' },
  ],
  jisoo: [
    { id: 'ji-flower',        song: 'FLOWER',          artist: 'JISOO', section: 'ME' },
    { id: 'ji-alleyes',       song: 'All Eyes On Me',  artist: 'JISOO', section: 'ME' },
    { id: 'ji-eyesclosed',    song: 'EYES CLOSED',     artist: 'JISOO', searchTerm: 'EYES CLOSED JISOO ZAYN', section: 'Others' },
    { id: 'ji-earthquake',    song: 'earthquake',      artist: 'JISOO', section: 'AMORTAGE' },
    { id: 'ji-yourlove',      song: 'Your Love',       artist: 'JISOO', section: 'AMORTAGE' },
    { id: 'ji-hugsandkisses', song: 'Hugs & Kisses',   artist: 'JISOO', section: 'AMORTAGE' },
    { id: 'ji-tears',         song: 'TEARS',           artist: 'JISOO', section: 'AMORTAGE' },
  ],
  jennie: [
    { id: 'je-solo',    song: 'SOLO',     artist: 'JENNIE', section: "SOLO 'J'" },
    { id: 'je-youandme',song: 'You & Me', artist: 'JENNIE', section: "SOLO 'J'" },
    { id: 'je-mantra',  song: 'Mantra',   artist: 'JENNIE', section: "SOLO 'J'" },
  ],
};

// Resolve a song to its Shazam track key. Keys are cached permanently in Redis
// so we only pay the search API cost once per song ever.
async function resolveKey(song) {
  const cacheKey = `shazam:id:${song.id}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const term = encodeURIComponent(song.searchTerm || `${song.song} ${song.artist}`);
  const r = await shazamFetch(`/search/multi?term=${term}&locale=en-US&offset=0&limit=5`);
  if (!r.ok) return null;
  const data = await r.json();
  // Shazam Core returns { tracks: { hits: [{ track: { key } }] } }
  const key = data?.tracks?.hits?.[0]?.track?.key;
  if (!key) return null;

  await redis.set(cacheKey, key); // permanent — never expires
  return key;
}

// Fetch global Shazam chart (top 200). Returns Map<key, rank>.
async function fetchChartMap() {
  try {
    const r = await shazamFetch('/charts/get-top-songs-in-country?country_code=US&locale=en-US&pageSize=200&startFrom=0&listId=ip-country-chart-US');
    if (!r.ok) return new Map();
    const data = await r.json();
    const tracks = data?.tracks ?? data?.chart?.tracks ?? [];
    return new Map(
      tracks
        .map((t, i) => [String(t?.key ?? t?.adamid ?? ''), i + 1])
        .filter(([k]) => k)
    );
  } catch {
    return new Map();
  }
}

// Fetch numShazams for a single track (returns plain integer text).
async function fetchNumShazams(shazamKey) {
  const r = await shazamFetch(`/songs/get-count?id=${shazamKey}`);
  if (!r.ok) return null;
  const text = await r.text();
  const n = parseInt(text, 10);
  return isNaN(n) ? null : n;
}

// Refresh stats for one page. Returns enriched song array.
async function refreshPage(page, chartMap) {
  const songs = SONGS[page];
  const results = await Promise.allSettled(
    songs.map(async song => {
      const shazamKey = await resolveKey(song);
      if (!shazamKey) return { ...song, numShazams: null, chartRank: null };
      const numShazams = await fetchNumShazams(shazamKey).catch(() => null);
      const chartRank = chartMap.get(String(shazamKey)) ?? null;
      return { ...song, numShazams, chartRank, shazamKey };
    })
  );
  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { ...songs[i], numShazams: null, chartRank: null }
  );
}

// Refresh all pages and store in Redis.
async function refreshAll() {
  const chartMap = await fetchChartMap();
  const [blackpink, jisoo, jennie] = await Promise.all([
    refreshPage('blackpink', chartMap),
    refreshPage('jisoo', chartMap),
    refreshPage('jennie', chartMap),
  ]);
  await Promise.all([
    redis.set('shazam:stats:blackpink', blackpink, { ex: STATS_TTL }),
    redis.set('shazam:stats:jisoo',     jisoo,     { ex: STATS_TTL }),
    redis.set('shazam:stats:jennie',    jennie,    { ex: STATS_TTL }),
  ]);
  return { blackpink: blackpink.length, jisoo: jisoo.length, jennie: jennie.length };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { page, cron, debug, flush } = req.query;

  // Flush all cached shazam:id:* keys (needed when switching APIs)
  if (flush === '1') {
    const keys = await redis.keys('shazam:id:*');
    if (keys.length) await redis.del(...keys);
    return res.json({ flushed: keys.length });
  }

  // Debug: probe known-working key + candidate search endpoints
  if (debug === '1') {
    if (!apiKey()) return res.status(500).json({ error: 'RAPIDAPI_SHAZAM_KEY not configured' });
    const k = apiKey();
    const h = { 'x-rapidapi-key': k, 'x-rapidapi-host': HOST, 'Content-Type': 'application/json' };
    const probe = async (path, asText = false) => {
      try {
        const r = await fetch(`https://${HOST}${path}`, { headers: h });
        const raw = await r.text().catch(() => '');
        let parsed = raw;
        if (!asText) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
        return { status: r.status, body: typeof parsed === 'string' ? parsed.slice(0, 300) : parsed };
      } catch(e) { return { error: e.message }; }
    };
    const [search, countTest, chartUS, chartKR] = await Promise.all([
      probe('/search/multi?term=BOOMBAYAH+BLACKPINK&locale=en-US&offset=0&limit=3'),
      probe('/songs/get-count?id=40333609', true),
      probe('/charts/get-top-songs-in-country?country_code=US&locale=en-US&pageSize=5&startFrom=0&listId=ip-country-chart-US'),
      probe('/charts/get-top-songs-in-country?country_code=KR&locale=en-US&pageSize=5&startFrom=0&listId=ip-country-chart-KR'),
    ]);
    return res.json({ search, countTest, chartUS, chartKR });
  }

  // Cron / forced refresh path
  if (cron === '1') {
    if (!apiKey()) return res.status(500).json({ error: 'RAPIDAPI_SHAZAM_KEY not configured' });
    try {
      const counts = await refreshAll();
      return res.json({ ok: true, updatedAt: new Date().toISOString(), ...counts });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Per-page read path
  if (!page || !SONGS[page]) return res.status(400).json({ error: 'invalid page' });

  const cached = await redis.get(`shazam:stats:${page}`);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
    return res.json(cached);
  }

  // Cache miss — warm just this page on demand
  if (!apiKey()) return res.status(503).json({ error: 'RAPIDAPI_SHAZAM_KEY not configured' });
  try {
    const chartMap = await fetchChartMap();
    const data = await refreshPage(page, chartMap);
    await redis.set(`shazam:stats:${page}`, data, { ex: STATS_TTL });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
