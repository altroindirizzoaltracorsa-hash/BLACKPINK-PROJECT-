// GET /api/youtube-catalog   — READ-ONLY. Admin-gated.
//
// Walks the uploads of the BLACKPINK channel AND each member's own channel and
// returns every video with its view count, its next 100M milestone and the gap
// to it. This is the id list the milestone board needs; nothing here writes.
//
// Why a channel walk rather than a pinned list of ids:
//   - /api/youtube-stats takes explicit ids, ten at a time. Fine for the five
//     tracked release videos on /vs.html, useless for a catalogue.
//   - A hand-written id list silently rots: a wrong id renders a confidently
//     wrong thumbnail and nobody notices, and a new release is invisible until
//     someone remembers to add it. The uploads playlist is the channel's own
//     answer to "what have you published", so it cannot drift from it.
//
// Why both the group channel and the solo ones: the members' older MVs live on
// the BLACKPINK channel (SOLO, LALISA, On The Ground) while the recent ones are
// on their own, so "the members' videos" and "the members' channels" are
// different sets and neither alone is complete. Every video carries the channel
// it was found on so the two can be told apart downstream.
//
// Quota: channels.list 1 + playlistItems.list 1 per 50 uploads + videos.list 1
// per 50 ids. A ~500-upload channel is ~21 units, five channels ~100 — against
// a 10,000/day free quota. ?max_pages caps the walk if a channel is huge.
//
// Params (all optional):
//   ?channels=<id|@handle>,…   override the configured set
//   ?min=<views>               drop anything below this (default 100,000,000)
//   ?max_pages=<n>             uploads pages per channel (default 12 = 600)
//   ?seed=<videoId>,…          resolve channels FROM these videos instead
//
// Env: YOUTUBE_API_KEY (required), ADMIN_SECRET / CRON_SECRET (auth).

const V3 = 'https://www.googleapis.com/youtube/v3';

// Channels to walk. Handles are resolved at call time and the response reports
// what each one resolved to — a handle that has been renamed shows up as a
// miss in `channels` rather than silently contributing nothing.
//
// SEED_VIDEOS is the more reliable half: these ids are already in the repo
// (api/youtube-stats.js RELEASE, .github/workflows/youtube-probe.yml), so they
// are known-good, and asking YouTube which channel a known-good video belongs
// to cannot be wrong the way a guessed handle can. Handles only have to cover
// what the seeds miss.
const SEED_VIDEOS = [
  'LzgE8ift2Uw', // JISOO teaser
  'h-7_04c_hVc', // LISA teaser
  'FyS5dAywkEo', // LISA MV
  'sf02ugzPFE4', // JISOO MV
  'Lufa9QAFFeY', // ROSÉ — new trick MV
  's466YCiHfKw', // the fifth tracked video
];
// Only the group channel. The members' channels all come from SEED_VIDEOS, and
// the first live run showed why guessing the rest is worse than useless:
// '@LISA' resolved to an unrelated one-upload channel called "Lisa", while the
// real LISA content sits on "LLOUD Official". '@roseanne_park' and '@jisoo'
// resolved to nothing at all, though both members were already found via seeds.
// A wrong handle does not fail loudly — it quietly adds a stranger's channel.
const HANDLES = ['@BLACKPINK'];

// ── what counts as a milestone-worthy video ────────────────────────────────
// The first live run returned 68 videos over 100M and most were not songs:
// Inkigayo and Coachella stages, official audio, BLACKPINK HOUSE episodes, and
// seven Shorts ("Bring your best dance moves and join the #PinkVenomChallenge").
// A board that leads with a challenge clip is not a milestone board.
//
// Shorts are detected by DURATION, not by title. Their titles are chatty
// sentences with nothing reliable in them, while the format has a hard length
// limit — a 60-second ceiling catches every one of them and cannot be fooled by
// wording.
export const iso8601Seconds = d => {
  const m = /^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(d || '');
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
};

const KIND_RULES = [
  // Order matters: a title can match more than one rule and the first wins.
  ['live',        /inkigayo|live at |live from |special stage|music bank|music core|the show|countdown|awards\)|live performance video/i],
  ['audio',       /\(official audio\)|\(audio\)/i],
  ['lyric',       /lyric video/i],
  ['performance', /dance practice|dance performance|performance video|choreography|dance video/i],
  ['mv',          /\bm\/v\b|\bmv\b|official music video|official video|\bm,\/v\b/i],
  ['variety',     /house.*ep\.|ep\.\d|blackpink house/i],
];

export function classify(title, durationSec) {
  if (durationSec !== null && durationSec <= 60) return 'short';
  for (const [kind, re] of KIND_RULES) if (re.test(title)) return kind;
  return 'other';
}

// Kept on the board by default. The fandom genuinely celebrates the dance
// practice and performance videos — MONEY's performance video is one of the
// biggest things on the BLACKPINK channel — so they count alongside the MVs,
// while stages, audio, lyric videos, Shorts and variety do not.
const DEFAULT_KINDS = ['mv', 'performance'];

const STEP = 100e6;                       // the public milestone ladder
const nextMilestone = v => Math.ceil((v + 1) / STEP) * STEP;

const authed = req => {
  const cronSecret = process.env.CRON_SECRET, adminSecret = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-secret'] || req.query.key;
  return (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`)
      || (adminSecret && given === adminSecret);
};

async function api(path, params, key) {
  const qs = new URLSearchParams({ ...params, key }).toString();
  const r = await fetch(`${V3}/${path}?${qs}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.message || `HTTP ${r.status}`;
    throw new Error(`${path}: ${reason}`);
  }
  return body;
}

// → [{ id, title, uploads }] for whatever we could resolve, plus the misses.
async function resolveChannels({ explicit, seeds }, key) {
  const found = new Map(), missed = [];

  const take = items => {
    for (const c of items || []) {
      if (c.id && !found.has(c.id)) {
        found.set(c.id, {
          id: c.id,
          title: c.snippet?.title || '',
          uploads: c.contentDetails?.relatedPlaylists?.uploads || null,
        });
      }
    }
  };

  if (explicit.length) {
    const ids = explicit.filter(x => !x.startsWith('@'));
    const handles = explicit.filter(x => x.startsWith('@'));
    if (ids.length) take((await api('channels', { part: 'snippet,contentDetails', id: ids.join(','), maxResults: '50' }, key)).items);
    for (const h of handles) {
      try {
        const r = await api('channels', { part: 'snippet,contentDetails', forHandle: h }, key);
        if (r.items?.length) take(r.items); else missed.push(h);
      } catch { missed.push(h); }
    }
    return { found: [...found.values()], missed };
  }

  // Seeds first: a known-good video id names its channel without guesswork.
  if (seeds.length) {
    const vids = await api('videos', { part: 'snippet', id: seeds.join(','), maxResults: '50' }, key);
    const chIds = [...new Set((vids.items || []).map(v => v.snippet?.channelId).filter(Boolean))];
    if (chIds.length) take((await api('channels', { part: 'snippet,contentDetails', id: chIds.join(','), maxResults: '50' }, key)).items);
  }
  // Then handles, for the channels no seed video covered.
  for (const h of HANDLES) {
    try {
      const r = await api('channels', { part: 'snippet,contentDetails', forHandle: h }, key);
      if (r.items?.length) take(r.items); else missed.push(h);
    } catch { missed.push(h); }
  }
  return { found: [...found.values()], missed };
}

async function uploadIds(playlistId, maxPages, key) {
  const ids = [];
  let page;
  for (let i = 0; i < maxPages; i++) {
    const r = await api('playlistItems', {
      part: 'contentDetails', playlistId, maxResults: '50',
      ...(page ? { pageToken: page } : {}),
    }, key);
    for (const it of r.items || []) {
      const id = it.contentDetails?.videoId;
      if (id) ids.push(id);
    }
    page = r.nextPageToken;
    if (!page) break;
  }
  return ids;
}

async function statsFor(ids, key) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await api('videos', {
      part: 'statistics,snippet,contentDetails',
      id: ids.slice(i, i + 50).join(','), maxResults: '50',
    }, key);
    out.push(...(r.items || []));
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(200).json({ error: 'not-configured', videos: [] });

  const explicit = String(req.query.channels || '').split(',').map(s => s.trim()).filter(Boolean);
  const seeds = String(req.query.seed || '').split(',').map(s => s.trim()).filter(Boolean);
  const min = Math.max(0, parseInt(req.query.min ?? '100000000', 10) || 0);
  const maxPages = Math.min(40, Math.max(1, parseInt(req.query.max_pages ?? '12', 10) || 12));
  // ?kinds=all keeps everything; ?kinds=mv,live picks explicitly.
  const kindsParam = String(req.query.kinds || '').trim();
  const keepAll = kindsParam === 'all';
  const kinds = kindsParam && !keepAll
    ? kindsParam.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_KINDS;

  try {
    const { found, missed } = await resolveChannels(
      { explicit, seeds: seeds.length ? seeds : SEED_VIDEOS }, key);

    // A video can be reached from more than one channel: the artist channel and
    // its VEVO mirror publish the same id, so the first run listed SaWaDiKa,
    // Mantra, like JENNIE and ExtraL twice each. Dedup by video id, preferring
    // the channel a human would name — "JENNIE" over "JennieRubyJaneVEVO".
    const seen = new Map();
    const dropped = {};                 // kind → how many were filtered out
    const prefer = (a, b) => {
      const vevo = t => /vevo$/i.test(t || '');
      if (vevo(a.channel) !== vevo(b.channel)) return vevo(a.channel) ? b : a;
      return a;                         // stable: first channel walked wins
    };

    const videos = [];
    const channels = [];
    for (const ch of found) {
      if (!ch.uploads) { channels.push({ ...ch, videos: 0, note: 'no uploads playlist' }); continue; }
      const ids = await uploadIds(ch.uploads, maxPages, key);
      const items = await statsFor(ids, key);
      let kept = 0;
      for (const it of items) {
        const views = Number(it.statistics?.viewCount);
        if (!Number.isFinite(views) || views < min) continue;
        const title = it.snippet?.title || '';
        const durationSec = iso8601Seconds(it.contentDetails?.duration);
        const kind = classify(title, durationSec);
        if (!keepAll && !kinds.includes(kind)) { dropped[kind] = (dropped[kind] || 0) + 1; continue; }
        kept++;
        const next = nextMilestone(views);
        const row = {
          id: it.id,
          title,
          kind,
          channel: ch.title,
          channelId: ch.id,
          publishedAt: it.snippet?.publishedAt || null,
          duration: it.contentDetails?.duration || null,
          durationSec,
          views,
          next,
          gap: next - views,
        };
        const prev = seen.get(it.id);
        if (prev) { seen.set(it.id, prefer(prev, row)); continue; }
        seen.set(it.id, row);
      }
      channels.push({
        id: ch.id, title: ch.title, uploads: ids.length, videos: kept,
        // 600 uploads from a 12-page cap is not "600 uploads", it is "we
        // stopped looking". Say so rather than reporting a truncated walk as
        // a complete one.
        truncated: ids.length >= maxPages * 50 || undefined,
      });
    }
    videos.push(...seen.values());

    // Smallest gap first. NOT the board's order — "soonest" needs a daily rate,
    // which this endpoint cannot know from one reading. It is only the useful
    // order for eyeballing a single call.
    videos.sort((a, b) => a.gap - b.gap);

    return res.status(200).json({
      ts: Date.now(), min, maxPages,
      kinds: keepAll ? 'all' : kinds, dropped,
      channels, unresolved: missed,
      count: videos.length, videos,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
