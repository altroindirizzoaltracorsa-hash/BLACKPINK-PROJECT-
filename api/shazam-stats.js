import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const HOST = 'shazam-core.p.rapidapi.com';
const APIDOJO_HOST = 'shazam.p.rapidapi.com';
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

function apidojoFetch(path) {
  const key = apiKey();
  if (!key) throw new Error('RAPIDAPI_SHAZAM_KEY not configured');
  return fetch(`https://${APIDOJO_HOST}${path}`, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': APIDOJO_HOST },
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
    { id: 'ji-earthquake',       song: 'earthquake',                  artist: 'JISOO', section: 'AMORTAGE' },
    { id: 'ji-earthquakeremix', song: 'earthquake (Sam Feldt Remix)', artist: 'JISOO', searchTerm: 'earthquake Sam Feldt Remix JISOO', section: 'AMORTAGE' },
    { id: 'ji-yourlove',        song: 'Your Love',                   artist: 'JISOO', section: 'AMORTAGE' },
    { id: 'ji-hugsandkisses',   song: 'Hugs & Kisses',              artist: 'JISOO', section: 'AMORTAGE' },
    { id: 'ji-tears',           song: 'TEARS',                       artist: 'JISOO', section: 'AMORTAGE' },
  ],
  jennie: [
    { id: 'je-solo',           song: 'SOLO',                  artist: 'JENNIE', section: "SOLO 'J'" },
    { id: 'je-youandme',       song: 'You & Me',              artist: 'JENNIE', section: "SOLO 'J'" },
    { id: 'je-intro',          song: 'Intro: Jane',           artist: 'JENNIE', searchTerm: 'Intro Jane JENNIE FKJ', section: 'RUBY' },
    { id: 'je-like',           song: 'like JENNIE',           artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-startawar',      song: 'start a war',           artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-handlebars',     song: 'Handlebars',            artist: 'JENNIE', searchTerm: 'Handlebars JENNIE Dua Lipa', section: 'RUBY' },
    { id: 'je-withtheie',      song: 'with the IE (way up)',  artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-extral',         song: 'ExtraL',                artist: 'JENNIE', searchTerm: 'ExtraL JENNIE Doechii', section: 'RUBY' },
    { id: 'je-mantra',         song: 'Mantra',                artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-lovehangover',   song: 'Love Hangover',         artist: 'JENNIE', searchTerm: 'Love Hangover JENNIE Dominic Fike', section: 'RUBY' },
    { id: 'je-zen',            song: 'ZEN',                   artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-damnright',      song: 'Damn Right',            artist: 'JENNIE', searchTerm: 'Damn Right JENNIE Childish Gambino Kali Uchis', section: 'RUBY' },
    { id: 'je-fts',            song: 'F.T.S.',                artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-filter',         song: 'Filter',                artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-seoulcity',      song: 'Seoul City',            artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-starlight',      song: 'Starlight',             artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-twin',           song: 'Twin',                  artist: 'JENNIE', section: 'RUBY' },
    { id: 'je-lessthanelover', song: 'Less Than a Lover',     artist: 'JENNIE', section: 'Singles' },
    { id: 'je-oneofthegirls', song: 'One of the Girls',      artist: 'JENNIE', searchTerm: 'One of the Girls The Weeknd JENNIE Lily Rose Depp', section: 'Singles' },
    { id: 'je-spot',          song: 'SPOT!',                 artist: 'JENNIE', searchTerm: 'SPOT ZICO JENNIE', section: 'Singles' },
    { id: 'je-slowmotion',    song: 'Slow Motion',           artist: 'JENNIE', searchTerm: 'Slow Motion JENNIE Matt Champion', section: 'Singles' },
    { id: 'je-dracula',       song: 'Dracula',               artist: 'JENNIE', searchTerm: 'Dracula Remix Tame Impala JENNIE', section: 'Singles' },
    { id: 'je-special',       song: 'Special',               artist: 'JENNIE', searchTerm: 'Special Lee Hi JENNIE', section: 'Singles' },
    { id: 'je-black',         song: 'BLACK',                 artist: 'JENNIE', searchTerm: 'BLACK G-Dragon JENNIE', section: 'Singles' },
  ],
  lisa: [
    { id: 'li-lalisa',      song: 'LALISA',               artist: 'LISA', section: 'LALISA' },
    { id: 'li-money',       song: 'MONEY',                artist: 'LISA', section: 'LALISA' },
    { id: 'li-sg',          song: 'SG',                   artist: 'LISA', searchTerm: 'SG LISA Ozuna DJ Snake', section: 'Singles' },
    { id: 'li-bornagain',   song: 'Born Again',           artist: 'LISA', searchTerm: 'Born Again LISA Doja Cat RAYE', section: 'ALTER EGO' },
    { id: 'li-rockstar',    song: 'ROCKSTAR',             artist: 'LISA', section: 'ALTER EGO' },
    { id: 'li-elastigirl',  song: 'Elastigirl',           artist: 'LISA', section: 'ALTER EGO' },
    { id: 'li-thunder',     song: 'Thunder',              artist: 'LISA', section: 'ALTER EGO' },
    { id: 'li-newwoman',    song: 'New Woman',            artist: 'LISA', searchTerm: 'New Woman LISA Rosalía', section: 'ALTER EGO' },
    { id: 'li-fxxxup',      song: 'Fxck Up The World',   artist: 'LISA', searchTerm: 'Fxck Up The World LISA Future', section: 'ALTER EGO' },
    { id: 'li-rapunzel',    song: 'Rapunzel',             artist: 'LISA', searchTerm: 'Rapunzel LISA Megan Thee Stallion', section: 'ALTER EGO' },
    { id: 'li-moonlit',     song: 'MOONLIT FLOOR',        artist: 'LISA', section: 'ALTER EGO' },
    { id: 'li-withyou',     song: "When I'm With You",   artist: 'LISA', searchTerm: "When I'm With You LISA Tyla", section: 'ALTER EGO' },
    { id: 'li-badgrrrl',    song: 'BADGRRRL',             artist: 'LISA', section: 'ALTER EGO' },
    { id: 'li-lifestyle',   song: 'Lifestyle',            artist: 'LISA', section: 'ALTER EGO' },
    { id: 'li-chill',       song: 'Chill',                artist: 'LISA', section: 'ALTER EGO' },
    { id: 'li-dream',       song: 'Dream',                artist: 'LISA', section: 'ALTER EGO' },
    { id: 'li-goals',       song: 'GOALS',                artist: 'LISA', searchTerm: 'GOALS LISA Anitta Rema', section: 'Singles' },
    { id: 'li-shoong',      song: 'Shoong!',              artist: 'LISA', searchTerm: 'Shoong TAEYANG LISA', section: 'Singles' },
    { id: 'li-priceless',   song: 'Priceless',            artist: 'LISA', searchTerm: 'Priceless Maroon 5 LISA', section: 'Singles' },
    { id: 'li-badangel',    song: 'Bad Angel',            artist: 'LISA', searchTerm: 'Bad Angel Anyma LISA', section: 'Singles' },
  ],
  rose: [
    { id: 'ro-ontheground',   song: 'On The Ground',      artist: 'ROSÉ', section: '-R-' },
    { id: 'ro-gone',          song: 'Gone',               artist: 'ROSÉ', section: '-R-' },
    { id: 'ro-number1girl',   song: 'Number One Girl',    artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-3am',           song: '3am',                artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-twoyears',      song: 'Two Years',          artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-toxictilend',   song: 'Toxic Till the End', artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-drinkorcoffee', song: 'Drinks or Coffee',   artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-apt',           song: 'APT.',               artist: 'ROSÉ', searchTerm: 'APT. ROSÉ Bruno Mars', section: 'rosie' },
    { id: 'ro-gameboy',       song: 'Gameboy',            artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-stayalittle',   song: 'Stay a Little Longer', artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-notthesame',    song: 'Not the Same',       artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-callitend',     song: 'Call It the End',    artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-toobadfor',     song: 'Too Bad for Us',     artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-danceallnight', song: 'Dance All Night',    artist: 'ROSÉ', section: 'rosie' },
    { id: 'ro-messy',         song: 'Messy',             artist: 'ROSÉ', section: 'Singles' },
    { id: 'ro-onmymind',      song: 'On My Mind',        artist: 'ROSÉ', searchTerm: 'On My Mind ROSÉ Alex Warren', section: 'Singles' },
    { id: 'ro-withoutyou',    song: 'Without You',       artist: 'ROSÉ', searchTerm: 'Without You G-Dragon ROSÉ', section: 'Singles' },
  ],
};

// Resolve a song to its Shazam internal ID. Permanently cached in Redis.
// Pipeline: apidojo search → Apple Music ID → Shazam Core v2 details → Shazam ID
async function resolveKey(song) {
  const cacheKey = `shazam:id:${song.id}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  // Step 1: apidojo search → Apple Music song ID
  const query = encodeURIComponent(song.searchTerm || `${song.song} ${song.artist}`);
  const r1 = await apidojoFetch(`/v2/search?term=${query}&locale=en-US&offset=0&limit=5`).catch(() => null);
  if (!r1?.ok) return null;
  const d1 = await r1.json().catch(() => null);
  const appleId = d1?.results?.songs?.data?.[0]?.id;
  if (!appleId) return null;

  // Step 2: Shazam Core v2 track details → Shazam internal ID
  const r2 = await shazamFetch(`/v2/tracks/details?track_id=${appleId}`).catch(() => null);
  if (!r2?.ok) return null;
  const d2 = await r2.json().catch(() => null);
  const shazamKey = d2?.data?.[0]?.id;
  if (!shazamKey) return null;

  await redis.set(cacheKey, shazamKey); // permanent — never expires
  return shazamKey;
}

// Shazam Core API has no chart endpoint — chart ranks not available.
async function fetchChartMap() {
  return new Map();
}

// Fetch numShazams via /v1/tracks/total-shazams.
async function fetchNumShazams(shazamKey) {
  const r = await shazamFetch(`/v1/tracks/total-shazams?track_id=${shazamKey}`);
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  // Response is either a plain number or { count: N } or { result: N }
  if (typeof data === 'number') return data;
  const n = data?.count ?? data?.result ?? data?.total ?? data?.shazams ?? null;
  return typeof n === 'number' ? n : null;
}

// Refresh stats for one page sequentially to avoid rate limits. Returns enriched song array.
async function refreshPage(page, chartMap) {
  const songs = SONGS[page];
  const enriched = [];
  for (const song of songs) {
    try {
      const shazamKey = await resolveKey(song);
      if (!shazamKey) { enriched.push({ ...song, numShazams: null, chartRank: null }); continue; }
      const numShazams = await fetchNumShazams(shazamKey).catch(() => null);
      const chartRank = chartMap.get(String(shazamKey)) ?? null;
      enriched.push({ ...song, numShazams, chartRank, shazamKey });
    } catch {
      enriched.push({ ...song, numShazams: null, chartRank: null });
    }
  }
  return enriched;
}

// Refresh all pages sequentially and store in Redis.
async function refreshAll() {
  const chartMap = await fetchChartMap();
  const results = {};
  for (const page of Object.keys(SONGS)) {
    const data = await refreshPage(page, chartMap);
    if (data.some(s => s.numShazams !== null)) {
      await redis.set(`shazam:stats:${page}`, data, { ex: STATS_TTL });
    }
    results[page] = data.filter(s => s.numShazams !== null).length;
  }
  return results;
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { page, cron, debug, flush } = req.query;

  // Flush cached keys so cron can re-run cleanly
  if (flush === '1') {
    const [idKeys, statKeys] = await Promise.all([
      redis.keys('shazam:id:*'),
      redis.keys('shazam:stats:*'),
    ]);
    const all = [...idKeys, ...statKeys];
    if (all.length) await redis.del(...all);
    return res.json({ flushed: all.length });
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
    const which = req.query.which ?? 'search';
    if (which === 'shazams') {
      const trackId = req.query.id ?? '40333609';
      const r = await probe(`/v1/tracks/total-shazams?track_id=${trackId}`);
      return res.json({ shazams: r });
    }
    if (which === 'details') {
      // 1315917630 = BOOMBAYAH Apple Music ID from apidojo search
      const trackId = req.query.id ?? '1315917630';
      const v1 = await probe(`/v1/tracks/details?track_id=${trackId}`);
      const v2 = await probe(`/v2/tracks/details?track_id=${trackId}`);
      return res.json({ v1, v2 });
    }
    if (which === 'search2') {
      const q = encodeURIComponent(req.query.q ?? 'BOOMBAYAH BLACKPINK');
      const r = await probe(`/v2/search/multi?search_type=SONGS&offset=0&query=${q}`);
      return res.json({ search2: r });
    }
    // Test apidojo search directly
    if (which === 'apidojo') {
      const q = encodeURIComponent(req.query.q ?? 'BOOMBAYAH BLACKPINK');
      const ak = apiKey();
      const ah = { 'x-rapidapi-key': ak, 'x-rapidapi-host': APIDOJO_HOST };
      try {
        const r = await fetch(`https://${APIDOJO_HOST}/v2/search?term=${q}&locale=en-US&offset=0&limit=5`, { headers: ah });
        const raw = await r.text();
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        const appleId = parsed?.results?.songs?.data?.[0]?.id;
        return res.json({ status: r.status, appleId, first: parsed?.results?.songs?.data?.[0] ?? parsed });
      } catch(e) { return res.json({ error: e.message }); }
    }
    // Show how many shazam:id:* keys are cached (without deleting)
    if (which === 'status') {
      const idKeys = await redis.keys('shazam:id:*');
      return res.json({ cachedIds: idKeys.length, keys: idKeys });
    }
    const q = encodeURIComponent(req.query.q ?? 'BOOMBAYAH BLACKPINK');
    const st = req.query.st ?? 'SONGS';
    const search = await probe(`/v1/search/multi?search_type=${st}&offset=0&query=${q}`);
    return res.json({ search, st });
  }

  // Cron / forced refresh — ?cron=1 for all pages, ?cron=1&page=X for one page
  if (cron === '1') {
    if (!apiKey()) return res.status(500).json({ error: 'RAPIDAPI_SHAZAM_KEY not configured' });
    try {
      if (page && SONGS[page]) {
        const chartMap = await fetchChartMap();
        const data = await refreshPage(page, chartMap);
        const populated = data.filter(s => s.numShazams !== null).length;
        if (populated > 0) {
          await redis.set(`shazam:stats:${page}`, data, { ex: STATS_TTL });
        }
        return res.json({ ok: true, updatedAt: new Date().toISOString(), [page]: data.length, populated, cached: populated > 0 });
      }
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
