import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

const redis = Redis.fromEnv();
const LASTFM_KEY = '666b8ef2f3cc360fbc20df275fba2981';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LIBREFM_BASE = 'https://libre.fm/2.0/';
const LB_BASE     = 'https://api.listenbrainz.org/1/';
const LB_KEY = 'bu_leaderboard_v1';
// Per-Last.fm-account cache of the figures that only move when the account
// scrobbles, so an idle account costs one request instead of eighteen. Its own
// key, NOT a field on the entries in LB_KEY: that key is 235 KB and every
// visitor downloads it through /api/leaderboard, so a ~40 KB cache hung off it
// would be paid for by every reader of the site. Here it is two Redis commands
// per cron run and nobody else ever reads it.
const LFM_CACHE_KEY = 'bu_lfm_cache_v1';
// Where the next run starts walking the board. See the rotation note in the
// handler: the point is that a run which cannot finish must not fail the same
// people every time.
const SCROBBLE_CURSOR_KEY = 'bu_scrobble_cursor_v1';
const GOAL_HISTORY_KEY = 'bu_goal_history_v1';
const GOAL_PRIMARY   = 15000;
const GOAL_SECONDARY = 20000;

// Community daily goal = JUMP + Shut Down + DDU-DU DDU-DU + GO (Less Than a Lover
// is intentionally excluded), summed across all board entries for the current day,
// de-duplicating linked-account secondary keys. Same formula the client
// (computeDailyCommunityTotal) and the POST record-goal path use, so all three agree.
function communityGoalTotal(users, todayDDMM) {
  const secondaryKeys = new Set();
  for (const [k, d] of Object.entries(users || {})) {
    if (Array.isArray(d.linkedAccounts)) {
      for (const a of d.linkedAccounts) {
        const ak = (a.username || '').toLowerCase();
        if (ak && ak !== k) secondaryKeys.add(ak);
      }
    }
  }
  return Object.entries(users || {}).reduce((sum, [k, d]) => {
    if (secondaryKeys.has(k.toLowerCase())) return sum;
    const s = d.scores || {};
    if (s.daily_date !== todayDDMM) return sum;
    // Whole campaign incl. the Fallen Angel EP — matches computeDailyCommunityTotal
    // (client) and the record-goal path in leaderboard.js so all three agree.
    return sum + (s.daily_jump || 0) + (s.daily_shutdown || 0) + (s.daily_ddududu || 0) + (s.daily_go || 0)
      + (s.daily_ltal || 0) + (s.daily_fallenangel || 0) + (s.daily_heaven || 0) + (s.daily_sawadika || 0) + (s.daily_click || 0) + (s.daily_newtrick || 0) + (s.daily_v12 || 0) + (s.daily_cobra || 0) + (s.daily_tarantino || 0) + (s.daily_cutuoff || 0) + (s.daily_sweat || 0) + (s.daily_addicted || 0) + (s.daily_sth || 0);
  }, 0);
}

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const TRACKS = [
  { id: 'jump',     artist: 'BLACKPINK', track: 'JUMP' },
  { id: 'shutdown', artist: 'BLACKPINK', track: 'Shut Down' },
  { id: 'ddududu',  artist: 'BLACKPINK', track: 'DDU-DU DDU-DU' },
  { id: 'ltal',     artist: 'Jennie',    track: 'Less Than a Lover' },
  { id: 'go',       artist: 'BLACKPINK', track: 'GO' },
  // LISA solo single (2026). Matched by name+artist like the others; counts toward
  // the campaign *_all sums + community goal and drives its own SAWADIKA board.
  { id: 'sawadika', artist: 'LISA',      track: 'SaWaDiKa' },
  // JISOO solo single (2026). Matched by name+artist like the others; counts toward
  // the campaign *_all sums + community goal and drives its own CLICK board.
  { id: 'click',    artist: 'JISOO',     track: 'CLICK' },
  // Fallen Angel EP (JENNIE) — grouped under the "Fallen Angel EP" leaderboard tab.
  // Tracked for their own per-track boards only; deliberately kept OUT of the
  // campaign *_all ranking sums and the durable user_daily_counts columns (those
  // stay campaign-scoped; EP history is a follow-up once the columns are migrated).
  { id: 'fallenangel', artist: 'Jennie', track: 'Fallen Angel' },
  { id: 'heaven',      artist: 'Jennie', track: 'Heaven' },
  // ROSÉ solo single (2026-09-17). Matched by name+artist like the others; counts
  // toward the campaign *_all sums + community goal and drives its own NEW TRICK
  // board. No plays exist until release, so it contributes 0 until then.
  { id: 'newtrick',    artist: 'ROSÉ',   track: 'new trick' },
  // PRESS PLAY EP (LISA, 2026-10-23) — grouped under the "Press Play EP"
  // leaderboard tab. SaWaDiKa is track 1 of this EP and is NOT repeated here: it
  // shipped as a single in September, so it keeps the id, the history and the
  // campaign scope it already had, and only moves under the EP tab in the UI.
  // The rest follow the Fallen Angel EP's treatment exactly — their own per-track
  // boards and the community total, but kept OUT of the campaign *_all ranking
  // sums and out of the durable user_daily_counts columns, which stay
  // campaign-scoped.
  { id: 'v12',        artist: 'LISA',   track: 'V12' },
  { id: 'cobra',      artist: 'LISA',   track: 'Cobra' },
  { id: 'tarantino',  artist: 'LISA',   track: 'Tarantino' },
  { id: 'cutuoff',    artist: 'LISA',   track: 'Cut U Off' },
  { id: 'sweat',      artist: 'LISA',   track: 'Sweat' },
  { id: 'addicted',   artist: 'JISOO',  track: 'ADDICTED' },
  // JENNIE for the Netflix film "Steps" (2026-11-06). THE FULL TITLE, SUFFIX
  // AND ALL. This list feeds two matchers with different tolerances:
  // trackKey() (the week's scrobbles) strips (...) and so takes either
  // spelling, but fetchTrackPlays -> track.getInfo is an EXACT string lookup
  // and takes only the one fans actually scrobble. It shipped bare, and that
  // second path answered userplaycount=None against two accounts carrying 43
  // and 25 plays of it — Last.fm keeps the spellings as separate tracks and
  // autocorrect does not bridge them, so the all-time figure read 0 while
  // today and this week read correctly.
  // Must stay byte-identical to index.html's TRACKS entry; the two copies
  // feed the same Last.fm call from different surfaces and
  // test_track_titles_match.mjs fails if they drift.
  { id: 'sth',        artist: 'Jennie', track: 'Someone to Hold (from the Netflix Film "Steps")' },
];

// Less Than a Lover leaves the campaign at the reset cutoff. Per-track ltal values
// are still stored (each fan's profile keeps them), but the *_all ranking sums drop
// ltal from that moment so it no longer affects leaderboard placement.
const LTAL_STOP_MS = Date.UTC(2026, 7, 17, 0, 0, 0); // 2026-08-17 00:00 UTC = 2 AM Rome
const ltalInRank = () => Date.now() < LTAL_STOP_MS;

// ── Italy 2am reset (same logic as client) ────────────────────
// Day boundary = 00:00 UTC — Spotify's own rollover, and the same boundary
// index.html buckets scores against. It was computed as 2 AM Rome, which equals
// 00:00 UTC only on summer time; when DST ended on 2026-10-25 it slid to 01:00
// UTC and stopped matching. No hour or city is named here — the reset is
// formatted in the reader's local clock where it is displayed.
function getDayBounds() {
  const n = new Date();
  const dayStart = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  return { from: Math.floor(dayStart / 1000), to: Math.floor((dayStart.getTime() + 86400000) / 1000) };
}
function getWeekBounds() {
  const { from: dayFrom } = getDayBounds();
  const dayFromDate = new Date(dayFrom * 1000);
  const dow = dayFromDate.getUTCDay();
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const weekStart = new Date(dayFromDate.getTime() - daysToMon * 86400000);
  return { from: Math.floor(weekStart / 1000), to: Math.floor((weekStart.getTime() + 7 * 86400000) / 1000) };
}
function ddmm(date) {
  return `${String(date.getUTCDate()).padStart(2,'0')}/${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}
function dayKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fullDateLabel(date) {
  return `${String(date.getUTCDate()).padStart(2,'0')}/${String(date.getUTCMonth()+1).padStart(2,'0')}/${date.getUTCFullYear()}`;
}

// ── Past-leaderboard archive ───────────────────────────────────
async function archivePeriod(sb, period, periodKey, label, users) {
  if (!sb || !periodKey || !Object.keys(users).length) return;
  await sb.from('leaderboard_archive').upsert(
    { period, period_key: periodKey, label, users, archived_at: new Date().toISOString() },
    { onConflict: 'period,period_key' }
  );
}

// ── Daily badge tiers ─────────────────────────────────────────
const TIER_ICONS = ['🩷','💓','💗','💖','💝','⚡','🌟','👑','🔥','✨'];
function makeDailyTiers(base, shortName) {
  return TIER_ICONS.map((icon, i) => ({ min: base * (i + 1), mult: i + 1, label: `${shortName} ×${i + 1}`, icon }));
}
const DAILY_TIERS = {
  jump:     makeDailyTiers(80, 'JUMP'),
  shutdown: makeDailyTiers(36, 'SHUT DOWN'),
  ddududu:  makeDailyTiers(20, 'DDU-DU'),
  ltal:     makeDailyTiers(30, 'LESS THAN A LOVER'),
  go:       makeDailyTiers(30, 'GO'),
};
function getDailyBadge(trackId, count) {
  const tiers = DAILY_TIERS[trackId] || [];
  let badge = null;
  for (const t of tiers) { if (count >= t.min) badge = t; }
  return badge;
}
function buildTodayStamps(todayCounts) {
  const stamps = {};
  for (const t of TRACKS) {
    const count = todayCounts[t.id] || 0;
    const badge = getDailyBadge(t.id, count);
    if (badge) stamps[t.id] = { mult: badge.mult, icon: badge.icon, label: badge.label, count };
  }
  return stamps;
}

async function persistStamp(sb, username, todayKey, stamps) {
  if (!sb || !Object.keys(stamps).length) return;
  const { data } = await sb.from('user_stamps').select('stamps')
    .eq('lfm_username', username).eq('day_key', todayKey).maybeSingle();
  const merged = data?.stamps || {};
  for (const [id, s] of Object.entries(stamps)) {
    if (!merged[id] || s.mult >= merged[id].mult) merged[id] = s;
  }
  await sb.from('user_stamps').upsert(
    { lfm_username: username, day_key: todayKey, stamps: merged, updated_at: new Date().toISOString() },
    { onConflict: 'lfm_username,day_key' }
  );
}

// ── Last.fm helpers ───────────────────────────────────────────
const LASTFM_RETRYABLE_ERRORS = new Set([8, 11, 16]);
// 29 = Rate Limit Exceeded, kept SEPARATE from the three above because it needs
// a different answer. An 8/11/16 is this one request's bad luck, so sleeping on
// it privately is right. A 29 is the KEY being over budget: every other request
// in flight is about to get one too, so the whole run has to slow down.
const LASTFM_RATE_LIMIT_ERROR = 29;

// WHY THERE IS A RATE GATE HERE AT ALL — the scrobble outage of early November
// 2026, reported as "no están contando mis reproducciones desde hace días".
//
// refreshUser fired 18 Last.fm calls per account inside one Promise.all, three
// accounts at a time, with no pacing: ~54 requests in flight and ~70/s
// sustained against a documented ceiling (ToS 4.4) of an average of 5/s. So
// the key was exhausted a few seconds into every run, and because the board is
// walked in a fixed order (Object.values of the stored object), it was always
// the SAME users who got served and always the same ones who did not:
//
//   run of 2026-11-03 10:08 UTC   refreshed  46 · failed 155 (152 of them a 29)
//   run of 2026-11-02 20:31 UTC   refreshed  88 · failed 112 ( 99 of them a 29)
//
// and the 46 were a strict subset of the 88 — a prefix, not a scatter, which is
// what a drained bucket looks like and what a flaky API does not. Everyone past
// the cut-off kept their last-known numbers (refreshUser throws, the caller
// keeps the old entry), so the board looked populated and healthy while three
// quarters of it was frozen.
//
// ONE key serves this cron, /api/lastfm (every visitor), /api/artwork and
// /api/control-ranking, so the cron never has the whole budget to itself and
// has to run under the ceiling rather than at it.
//
// A single shared slot clock, so the pacing holds however many callers a
// Promise.all launches at once: each request claims the next free instant and
// sleeps until it. Per function instance, which is the scope of one cron run.
const LFM_RATE_PER_SEC = Number(process.env.LASTFM_RATE_PER_SEC || 4);
let lfmNextSlot = 0;
let lfmCalls = 0;
async function lfmSlot() {
  lfmCalls++;
  const now = Date.now();
  const at  = Math.max(now, lfmNextSlot);
  lfmNextSlot = at + 1000 / LFM_RATE_PER_SEC;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
}
// A 29 is the key's budget, not this request's, so the back-off goes on the
// SHARED clock. Sleeping privately would leave the other callers queued behind
// an unchanged clock, and they would all resume hammering in unison.
function lfmPenalty(ms) { lfmNextSlot = Math.max(lfmNextSlot, Date.now() + ms); }

async function lfmFetch(params, attempt = 0) {
  const url = LASTFM_BASE + '?' + new URLSearchParams({ ...params, api_key: LASTFM_KEY, format: 'json' });
  let data;
  await lfmSlot();
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Last.fm HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    if (attempt < 2) {
      await new Promise(res => setTimeout(res, 500 * 3 ** attempt));
      return lfmFetch(params, attempt + 1);
    }
    throw e;
  }
  if (data?.error) {
    if (data.error === LASTFM_RATE_LIMIT_ERROR && attempt < 3) {
      // Seconds, not the 500ms the others get: a rate limit that has already
      // tripped does not clear in half a second. The recursion's own lfmSlot()
      // is what performs the wait, so this both backs THIS request off and
      // holds everyone else.
      lfmPenalty(2000 * 2 ** attempt);
      return lfmFetch(params, attempt + 1);
    }
    if (LASTFM_RETRYABLE_ERRORS.has(data.error) && attempt < 2) {
      await new Promise(res => setTimeout(res, 500 * 3 ** attempt));
      return lfmFetch(params, attempt + 1);
    }
    throw new Error(`Last.fm error ${data.error}: ${data.message || ''}`);
  }
  return data;
}

// Libre.fm implements the same AudioScrobbler 2.0 API as Last.fm (no api_key).
async function librefmFetch(params) {
  const url = LIBREFM_BASE + '?' + new URLSearchParams({ ...params, format: 'json' });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Libre.fm HTTP ${r.status}`);
  const data = await r.json();
  if (data?.error) throw new Error(`Libre.fm error ${data.error}: ${data.message || ''}`);
  return data;
}

async function fetchTrackPlays(username, artist, track, fetchFn = lfmFetch) {
  const d = await fetchFn({ method: 'track.getInfo', artist, track, username });
  return parseInt(d?.track?.userplaycount || '0', 10);
}

async function fetchArtistPlays(username, artist, fetchFn = lfmFetch) {
  const d = await fetchFn({ method: 'artist.getInfo', artist, username });
  return parseInt(d?.artist?.stats?.userplaycount || '0', 10);
}

// The account's whole-library scrobble count. One cheap call that answers the
// only question worth asking before the expensive ones: has this account
// recorded ANY play since we last looked? If it has not, none of the 16
// per-track all-time totals can have moved, and the week's scrobble list cannot
// have gained a row either — so 17 of the 18 requests are re-reading numbers we
// already hold.
//
// null means "could not tell" (missing or unparseable — Libre.fm does not
// always answer with a playcount), which falls through to the full refresh.
// Never 0 for that case: 0 is a real answer from a brand-new account and would
// match a cached 0 forever.
async function fetchUserPlaycount(username, fetchFn = lfmFetch) {
  const d  = await fetchFn({ method: 'user.getInfo', user: username });
  const pc = parseInt(d?.user?.playcount, 10);
  return Number.isFinite(pc) ? pc : null;
}

async function fetchRecentScrobbles(username, from, to, maxPages = 50, fetchFn = lfmFetch) {
  const results = [];
  let page = 1;
  while (true) {
    const d = await fetchFn({ method: 'user.getRecentTracks', user: username, from, to, limit: 200, page });
    const tracks = d?.recenttracks?.tracks || d?.recenttracks?.track || [];
    const arr = Array.isArray(tracks) ? tracks : [tracks];
    results.push(...arr.filter(t => t['@attr']?.nowplaying !== 'true'));
    const total = parseInt(d?.recenttracks?.['@attr']?.totalPages || '1');
    if (page >= total || page >= maxPages) break;
    page++;
  }
  return results;
}

// Title key for campaign matching: drop (feat…)/[remix] parentheticals, then all
// spacing + punctuation, so a stylized or re-spaced scrobble still matches the
// campaign entry — "SaWaDiKa" / "Sa Wa Di Ka" / "SaWaDiKa (Thai Ver.)" all → key
// "sawadika". Still a FULL-title match (not a prefix), so "GO" never catches
// "Good". Mirrors the extension ingest matcher so every source counts alike.
function trackKey(s) {
  return String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
}
// Accent-insensitive artist compare — ROSÉ scrobbles as "Rosé" or "Rose", so a
// plain includes('rosé') drops every non-accented play (new trick is ROSÉ's only
// track, so it was the only one affected). Strip diacritics on both sides.
const deAccent = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function trackMatches(name, artist, t) {
  return trackKey(name) === trackKey(t.track) && deAccent(artist).includes(deAccent(t.artist));
}

function countByTrack(scrobbles) {
  const counts = {};
  for (const t of TRACKS) counts[t.id] = 0;
  for (const s of scrobbles) {
    const name   = (s.name || '').toLowerCase();
    const artist = (s.artist?.['#text'] || s.artist || '').toLowerCase();
    for (const t of TRACKS) {
      if (trackMatches(name, artist, t)) { counts[t.id]++; break; }
    }
  }
  return counts;
}

// ── ListenBrainz helpers ──────────────────────────────────────
async function lbFetch(path, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r = await fetch(LB_BASE + path + qs, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`ListenBrainz HTTP ${r.status}`);
  return r.json();
}

async function fetchLbTrackCounts(username) {
  const counts = {}; for (const t of TRACKS) counts[t.id] = 0;
  const d = await lbFetch(`stats/user/${encodeURIComponent(username)}/recordings`, { count: 100, range: 'all_time' });
  for (const rec of d?.payload?.recordings || []) {
    const name   = (rec.track_name  || '').toLowerCase().trim();
    const artist = (rec.artist_name || '').toLowerCase();
    for (const t of TRACKS) {
      if (trackMatches(name, artist, t)) { counts[t.id] += rec.listen_count || 0; break; }
    }
  }
  return counts;
}

async function fetchLbArtistPlays(username) {
  try {
    const d = await lbFetch(`stats/user/${encodeURIComponent(username)}/artists`, { count: 100, range: 'all_time' });
    const bp = (d?.payload?.artists || []).find(a => (a.artist_name || '').toLowerCase().includes('blackpink'));
    return bp?.listen_count || 0;
  } catch { return 0; }
}

async function fetchLbRecentListens(username, from, to) {
  const results = [];
  let maxTs = to;
  for (let page = 0; page < 50; page++) {
    const d = await lbFetch(`user/${encodeURIComponent(username)}/listens`, { min_ts: from, max_ts: maxTs, count: 100 });
    const listens = d?.payload?.listens || [];
    if (!listens.length) break;
    results.push(...listens);
    if (listens.length < 100) break;
    maxTs = listens[listens.length - 1].listened_at - 1;
    if (maxTs < from) break;
  }
  return results;
}

function countLbByTrack(listens) {
  const counts = {}; for (const t of TRACKS) counts[t.id] = 0;
  for (const l of listens) {
    const name   = (l.track_metadata?.track_name  || '').toLowerCase().trim();
    const artist = (l.track_metadata?.artist_name || '').toLowerCase();
    for (const t of TRACKS) {
      if (trackMatches(name, artist, t)) { counts[t.id]++; break; }
    }
  }
  return counts;
}

// ── Extension (blinksunited-direct) plays ─────────────────────
// Self-reported plays the SessionBox extension posted to /api/ingest-scrobble,
// stored in extension_scrobbles keyed by app_user_id. These are ADDED on top of
// Last.fm/Libre/ListenBrainz counts. They don't double-count in the normal
// many->one setup because those plays are sent to blinksunited precisely because
// Last.fm filters them out — they are not also on the linked Last.fm account.
async function extensionCountsForUsers(sb, appUserIds, dayFrom, dayTo, weekFrom, weekTo) {
  // Includes the Fallen Angel EP ids so the extension's per-song plays fold into
  // overall_fallenangel / overall_heaven (the EP boards). They're excluded from
  // campaignTotal / *_all above, so this never inflates the campaign totals.
  const empty = () => ({ jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0, sawadika: 0, click: 0, fallenangel: 0, heaven: 0, newtrick: 0, v12: 0, cobra: 0, tarantino: 0, cutuoff: 0, sweat: 0, addicted: 0, sth: 0 });
  const out = { total: empty(), week: empty(), today: empty() };
  if (!sb || !appUserIds || !appUserIds.length) return out;
  // Counted in the database (see supabase/extension_counts_fn.sql) so it scales
  // to unlimited rows — no per-query 1000-row cap, no fetching every play.
  const dayISO  = new Date(dayFrom  * 1000).toISOString();
  const weekISO = new Date(weekFrom * 1000).toISOString();
  for (const uid of appUserIds) {
    const { data, error } = await sb.rpc('extension_counts', { uid, day_from: dayISO, week_from: weekISO });
    if (error || !data) continue;
    for (const r of data) {
      const id = r.track_id;
      if (!(id in out.total)) continue;
      out.total[id] += Number(r.total) || 0;
      out.week[id]  += Number(r.week)  || 0;
      out.today[id] += Number(r.today) || 0;
    }
  }
  return out;
}

// ── Refresh one user's scores ─────────────────────────────────
// linkedMap: Map(source_username.toLowerCase() -> app_user_id), used to attach
// this profile's extension_scrobbles rows to the right account.
async function refreshUser(entry, sb, linkedMap, nameInfo, lfmCache = null) {
  const linkedAccounts = entry.linkedAccounts || [{ type: 'lastfm', username: entry.username }];

  // Resolve the stable owner id. It's often missing on the in-Redis entry — a
  // legacy row, or one written before appUserId was carried across refreshes — so
  // recover it from the verified linked_accounts map: any of this profile's
  // scrobbler handles points back to the same owner. Keeping this populated is
  // what stops the self-heal from re-seeding an ALREADY-PRESENT owner under their
  // raw Last.fm handle — the bug that flipped display names (colxrzone <-> the
  // eilan3502 handle), wiped chosen names, and bounced rows off the finalized
  // board. It also hardens the dedup: two DIFFERENT signed-in owners who happen to
  // share a scrobbler handle now both carry an id, so they're never merged.
  let appUserId = entry.appUserId || null;
  if (!appUserId && linkedMap) {
    for (const a of linkedAccounts) {
      const uid = linkedMap.get((a.username || '').toLowerCase());
      if (uid) { appUserId = uid; break; }
    }
  }

  // Display name, reconciled against the auth profile so the row shows exactly what
  // the badges page shows the owner:
  //  1. Owner set a display name  -> use it (authoritative; fixes handle-named rows,
  //     e.g. the eilan3502 handle back to colxrzone).
  //  2. No display name, and the stored name is EXACTLY the owner's OAuth real name
  //     -> that's a row an earlier bug mislabeled; revert to the primary scrobbler
  //     handle, which is what the badges page renders for a name-less owner. Only
  //     when the auth list came back complete, so a partial fetch can't demote
  //     anyone, and only on that exact-match signature, so a genuinely-chosen name
  //     is never touched.
  let displayName = entry.displayName || entry.username;
  if (appUserId && nameInfo) {
    const chosen = nameInfo.chosen.get(appUserId);
    if (chosen) {
      displayName = chosen;
    } else if (nameInfo.complete) {
      // Owner set no display name → canonical is the primary scrobbler handle,
      // exactly what the badges page renders for a name-less fan. Revert any stray
      // label back to it: an OAuth real name, OR a "blinkN" that an earlier build
      // wrongly auto-assigned to an existing user. Guarded by `complete`, so a
      // partial auth fetch can never demote anyone, and a genuinely-chosen name is
      // protected above (it lands in `chosen`).
      const primary = linkedAccounts.find(a => a.type === 'lastfm' || a.type === 'librefm')
        || linkedAccounts.find(a => a.type === 'listenbrainz')
        || linkedAccounts[0];
      if (primary && primary.username && displayName.toLowerCase() !== primary.username.toLowerCase()) {
        displayName = primary.username;
      }
    }
  }

  const { from: dayFrom, to: dayTo }   = getDayBounds();
  const { from: weekFrom, to: weekTo } = getWeekBounds();
  // Which day and week the per-account cache's day/week counts belong to. UTC,
  // like every other boundary in this repo. A cached count is only reusable
  // while its window is still the current one — a scrobble can fall OUT of a
  // window without any new one arriving, which no playcount change would show.
  const dayWindowKey  = dayKey(dayFrom);
  const weekWindowKey = dayKey(weekFrom);

  const totalPlays  = { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0, sawadika: 0, click: 0, fallenangel: 0, heaven: 0, newtrick: 0, v12: 0, cobra: 0, tarantino: 0, cutuoff: 0, sweat: 0, addicted: 0, sth: 0 };
  let artistPlays   = 0;
  const todayCounts = { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0, sawadika: 0, click: 0, fallenangel: 0, heaven: 0, newtrick: 0, v12: 0, cobra: 0, tarantino: 0, cutuoff: 0, sweat: 0, addicted: 0, sth: 0 };
  const weekCounts  = { jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0, sawadika: 0, click: 0, fallenangel: 0, heaven: 0, newtrick: 0, v12: 0, cobra: 0, tarantino: 0, cutuoff: 0, sweat: 0, addicted: 0, sth: 0 };
  let lastScrobbleAt = entry.lastScrobbleAt || null;
  // Per-scrobbler split of TODAY's counts, for the personal history calendar. Each
  // key is a human label ("Last.fm · Alice9629", "BU Extension", "Musicat / Stats.fm")
  // → {jump,shutdown,ddududu,ltal,go}. Frozen into the day's row at the 2am reset.
  const todayBySource = {};
  const srcZero = () => ({ jump: 0, shutdown: 0, ddududu: 0, ltal: 0, go: 0 });

  // Primary Last.fm account (first one, for stamps)
  const lfmAccount = linkedAccounts.find(a => a.type === 'lastfm');

  for (const acct of linkedAccounts) {
    if (acct.type === 'lastfm' || acct.type === 'librefm') {
      const u = acct.username;
      const fetchFn = acct.type === 'librefm' ? librefmFetch : lfmFetch;
      // ── HOW MANY REQUESTS THIS ACCOUNT COSTS ────────────────────────────
      //
      // One, when nothing has changed — which for most accounts is most hours.
      // This replaced a flat 18 per account per run (a hand-written
      // Promise.all of artist.getInfo + one track.getInfo per campaign track +
      // the week's scrobbles), 3 accounts at a time with no pacing, which is
      // what exhausted the shared Last.fm key and froze three quarters of the
      // board for days. See the rate-gate note above lfmFetch.
      //
      // The whole-library playcount is the gate. If it has not moved since the
      // last run then this account has recorded no play of anything, so:
      //   · the 16 per-track all-time totals cannot have changed, and
      //   · the week's scrobble list cannot have gained a row.
      // The day and week COUNTS can still change without a new scrobble, by one
      // falling out of the window, so they are only reused while the windows
      // themselves are unchanged. Three cases, 1 / ~2 / ~18 requests:
      const ukey   = u.toLowerCase();
      const cached = lfmCache ? lfmCache[ukey] : null;
      const pc     = await fetchUserPlaycount(u, fetchFn);
      // A cache entry has to cover every track counted TODAY. Without this a
      // release added to TRACKS after the entry was written would be served
      // from it as a silent zero for everyone, every run, until they happened
      // to scrobble something — exactly the failure the auto-discovery note in
      // CLAUDE.md describes on the Spotify side.
      const covered = !!cached && !!cached.t && !!cached.d && !!cached.w
        && TRACKS.every(t => Number.isFinite(cached.t[t.id]));
      const idle    = pc !== null && covered && cached.pc === pc;
      const sameWin = idle && cached.dk === dayWindowKey && cached.wk === weekWindowKey;

      let ap, allTime, dayBy, weekBy, newestBp = null;
      if (sameWin) {
        // Nothing scrobbled, windows unchanged: every figure this account
        // contributes is one we already hold. Cost: the gate call alone.
        ap = cached.ap; allTime = cached.t; dayBy = cached.d; weekBy = cached.w;
      } else {
        if (idle) {
          // Nothing scrobbled, but the day (or week) has rolled over, so the
          // windowed counts must be re-derived. The all-time totals still cannot
          // have moved. Cost: the gate call + the week fetch.
          ap = cached.ap; allTime = cached.t;
        } else {
          // Either it scrobbled, or we could not tell. Full read.
          const [apV, perTrack] = await Promise.all([
            fetchArtistPlays(u, 'BLACKPINK', fetchFn),
            // Driven off TRACKS rather than a second hand-written list. The
            // Promise.all this replaces had to be edited in lockstep with
            // TRACKS on every release — six parallel lists for one fact, which
            // is the kind of pair that drifts silently.
            Promise.all(TRACKS.map(t => fetchTrackPlays(u, t.artist, t.track, fetchFn))),
          ]);
          ap = apV;
          allTime = Object.fromEntries(TRACKS.map((t, i) => [t.id, perTrack[i]]));
        }
        // Single fetch spanning the whole week through today -- Last.fm/Libre.fm
        // return scrobbles newest-first, so today's counts, the weekly counts,
        // and the most recent BLACKPINK scrobble can all be derived from one
        // paginated range instead of re-fetching/re-paginating once per day.
        const weekSc  = await fetchRecentScrobbles(u, weekFrom, dayTo, 50, fetchFn);
        const todaySc = weekSc.filter(s => {
          const ts = parseInt(s.date?.uts || '0', 10);
          return ts >= dayFrom && ts < dayTo;
        });
        dayBy  = countByTrack(todaySc);
        weekBy = countByTrack(weekSc);
        // "blackpink" alone misses activity on Jennie's solo campaign track
        // (Less Than a Lover), which would otherwise wrongly flag an actively-
        // streaming fan as inactive just because their recent plays are all solo.
        const bpEntry = weekSc.find(s => {
          const a = (s.artist?.['#text'] || '').toLowerCase();
          return (a.includes('blackpink') || a.includes('jennie')) && s.date?.uts;
        });
        if (bpEntry) newestBp = new Date(parseInt(bpEntry.date.uts) * 1000).toISOString();
      }

      // Only cache a reading we can gate on later. pc === null means the gate
      // question is unanswerable for this account, and an entry we can never
      // trust is worse than none.
      if (pc !== null && lfmCache) {
        lfmCache[ukey] = { pc, ap, t: allTime, dk: dayWindowKey, wk: weekWindowKey, d: dayBy, w: weekBy };
      }

      artistPlays += ap;
      for (const t of TRACKS) {
        totalPlays[t.id]  += allTime[t.id] || 0;
        todayCounts[t.id] += dayBy[t.id]   || 0;
        weekCounts[t.id]  += weekBy[t.id]  || 0;
      }
      todayBySource[`${acct.type === 'librefm' ? 'Libre.fm' : 'Last.fm'} · ${u}`] = {
        jump: dayBy.jump || 0, shutdown: dayBy.shutdown || 0, ddududu: dayBy.ddududu || 0,
        ltal: dayBy.ltal || 0, go: dayBy.go || 0,
      };
      // lastScrobbleAt only ever climbs, so an idle account needs no update:
      // entry.lastScrobbleAt already carries its newest play.
      if (newestBp && (!lastScrobbleAt || newestBp > lastScrobbleAt)) lastScrobbleAt = newestBp;
    } else if (acct.type === 'listenbrainz') {
      const u = acct.username;
      try {
        // Same single-fetch-for-the-week approach as the Last.fm branch above.
        const [lbTotals, lbAp, weekListens] = await Promise.all([
          fetchLbTrackCounts(u),
          fetchLbArtistPlays(u),
          fetchLbRecentListens(u, weekFrom, dayTo),
        ]);
        artistPlays         += lbAp;
        totalPlays.jump     += lbTotals.jump     || 0;
        totalPlays.shutdown += lbTotals.shutdown || 0;
        totalPlays.ddududu  += lbTotals.ddududu  || 0;
        totalPlays.ltal     += lbTotals.ltal     || 0;
        totalPlays.go       += lbTotals.go       || 0;
        totalPlays.sawadika += lbTotals.sawadika || 0;
        totalPlays.click    += lbTotals.click    || 0;
        totalPlays.fallenangel += lbTotals.fallenangel || 0;
        totalPlays.heaven      += lbTotals.heaven      || 0;
        totalPlays.newtrick    += lbTotals.newtrick    || 0;
        totalPlays.v12    += lbTotals.v12    || 0;
        totalPlays.cobra    += lbTotals.cobra    || 0;
        totalPlays.tarantino    += lbTotals.tarantino    || 0;
        totalPlays.cutuoff    += lbTotals.cutuoff    || 0;
        totalPlays.sweat    += lbTotals.sweat    || 0;
        totalPlays.addicted += lbTotals.addicted || 0;
        totalPlays.sth      += lbTotals.sth      || 0;

        const todayListens = weekListens.filter(l => l.listened_at >= dayFrom && l.listened_at < dayTo);
        const lbTodayCounts = countLbByTrack(todayListens);
        todayCounts.jump     += lbTodayCounts.jump     || 0;
        todayCounts.shutdown += lbTodayCounts.shutdown || 0;
        todayCounts.ddududu  += lbTodayCounts.ddududu  || 0;
        todayCounts.ltal     += lbTodayCounts.ltal     || 0;
        todayCounts.go       += lbTodayCounts.go       || 0;
        todayCounts.sawadika += lbTodayCounts.sawadika || 0;
        todayCounts.click    += lbTodayCounts.click    || 0;
        todayCounts.fallenangel += lbTodayCounts.fallenangel || 0;
        todayCounts.heaven      += lbTodayCounts.heaven      || 0;
        todayCounts.newtrick    += lbTodayCounts.newtrick    || 0;
        todayCounts.v12    += lbTodayCounts.v12    || 0;
        todayCounts.cobra    += lbTodayCounts.cobra    || 0;
        todayCounts.tarantino    += lbTodayCounts.tarantino    || 0;
        todayCounts.cutuoff    += lbTodayCounts.cutuoff    || 0;
        todayCounts.sweat    += lbTodayCounts.sweat    || 0;
        todayCounts.addicted += lbTodayCounts.addicted || 0;
        todayCounts.sth      += lbTodayCounts.sth      || 0;
        todayBySource[`ListenBrainz · ${u}`] = {
          jump: lbTodayCounts.jump || 0, shutdown: lbTodayCounts.shutdown || 0, ddududu: lbTodayCounts.ddududu || 0, ltal: lbTodayCounts.ltal || 0, go: lbTodayCounts.go || 0,
        };

        const lbWeekCounts = countLbByTrack(weekListens);
        weekCounts.jump     += lbWeekCounts.jump     || 0;
        weekCounts.shutdown += lbWeekCounts.shutdown || 0;
        weekCounts.ddududu  += lbWeekCounts.ddududu  || 0;
        weekCounts.ltal     += lbWeekCounts.ltal     || 0;
        weekCounts.go       += lbWeekCounts.go       || 0;
        weekCounts.sawadika += lbWeekCounts.sawadika || 0;
        weekCounts.click    += lbWeekCounts.click    || 0;
        weekCounts.fallenangel += lbWeekCounts.fallenangel || 0;
        weekCounts.heaven      += lbWeekCounts.heaven      || 0;
        weekCounts.newtrick    += lbWeekCounts.newtrick    || 0;
        weekCounts.v12    += lbWeekCounts.v12    || 0;
        weekCounts.cobra    += lbWeekCounts.cobra    || 0;
        weekCounts.tarantino    += lbWeekCounts.tarantino    || 0;
        weekCounts.cutuoff    += lbWeekCounts.cutuoff    || 0;
        weekCounts.sweat    += lbWeekCounts.sweat    || 0;
        weekCounts.addicted += lbWeekCounts.addicted || 0;
        weekCounts.sth      += lbWeekCounts.sth      || 0;

        // ListenBrainz never fed lastScrobbleAt before -- a fan scrobbling only
        // through LB (e.g. after moving off Last.fm) would drift towards a
        // false "inactive" label as the Last.fm-only timestamp above went stale.
        try {
          const latest = await lbFetch(`user/${encodeURIComponent(u)}/listens`, { count: 1 });
          const la = latest?.payload?.listens?.[0]?.listened_at;
          if (la) {
            const ts = new Date(la * 1000).toISOString();
            if (!lastScrobbleAt || ts > lastScrobbleAt) lastScrobbleAt = ts;
          }
        } catch {}
      } catch (e) {
        console.warn(`LB fetch failed for ${u}:`, e.message);
      }
    }
    // Musicat / Stats.fm are NOT scraped here — see the providerScores block below.
  }

  // Add this profile's extension (blinksunited-direct) plays on top.
  if (linkedMap) {
    const appUserIds = new Set();
    for (const acct of linkedAccounts) {
      const uid = linkedMap.get((acct.username || '').toLowerCase());
      if (uid) appUserIds.add(uid);
    }
    if (appUserIds.size) {
      try {
        const ext = await extensionCountsForUsers(sb, [...appUserIds], dayFrom, dayTo, weekFrom, weekTo);
        const extToday = srcZero();
        for (const t of TRACKS) {
          totalPlays[t.id]  += ext.total[t.id]  || 0;
          weekCounts[t.id]  += ext.week[t.id]   || 0;
          todayCounts[t.id] += ext.today[t.id]  || 0;
          extToday[t.id]     = ext.today[t.id]  || 0;
        }
        if (Object.values(extToday).some(v => v > 0)) todayBySource['BU Extension'] = extToday;
      } catch (e) { console.warn('extension counts failed:', e.message); }
    }
  }

  // Musicat / Stats.fm: reuse the breakdown the badges page submitted, rather than
  // scraping those providers here. They throttle the hourly ~40-profile burst and
  // drop the heaviest accounts (e.g. a 250k-play Stats.fm), so scraping silently
  // lost their streams. The client fetched them successfully one-at-a-time, so we
  // trust that number. Overall totals always apply; the provider "today" only
  // applies while it's still the day the client captured it — these providers
  // expose no per-day history to re-derive it, so on a later day it's simply 0
  // until the fan opens their badges again (same freshness as their own profile).
  const provScores = entry.providerScores;
  if (provScores && provScores.overall) {
    const provTodayFresh = provScores.dailyDate === ddmm(new Date(dayFrom * 1000));
    const provToday = srcZero();
    for (const t of TRACKS) {
      totalPlays[t.id] += provScores.overall[t.id] || 0;
      if (provTodayFresh) {
        const n = provScores.today?.[t.id] || 0;
        todayCounts[t.id] += n;
        weekCounts[t.id]  += n;
        provToday[t.id]    = n;
      }
    }
    if (provTodayFresh) {
      // Prefer the client's per-account split (Musicat and Stats.fm kept SEPARATE,
      // one row each, matching the badges breakdown). Fall back to a single combined
      // row for older submits that didn't carry the breakdown.
      const bd = Array.isArray(provScores.breakdown) ? provScores.breakdown : null;
      if (bd && bd.length) {
        for (const b of bd) {
          const c = b.today || {};
          if (!Object.values(c).some(v => v > 0)) continue;
          const label = `${b.source === 'statsfm' ? 'Stats.fm' : 'Musicat'} · ${b.username || ''}`.trim();
          todayBySource[label] = { jump: c.jump||0, shutdown: c.shutdown||0, ddududu: c.ddududu||0, ltal: c.ltal||0, go: c.go||0 };
        }
      } else if (Object.values(provToday).some(v => v > 0)) {
        todayBySource['Musicat / Stats.fm'] = provToday;
      }
    }
  }

  const todayLabel     = ddmm(new Date(dayFrom * 1000));
  const weekStartLabel = ddmm(new Date(weekFrom * 1000));

  // ── Registered-value floor (the "the site had my streams then deleted them" fix) ──
  // A recompute must NEVER lower a count already registered for the current day or
  // week. Last.fm, ListenBrainz and especially the Stats.fm/Musicat slice can
  // transiently come back smaller than a moment ago; without this the hourly cron
  // overwrites a higher registered value (e.g. a live 1039) with a lower one (920).
  // Counts only ever climb until the 2am-Rome reset. OVERALL is intentionally left
  // un-floored so disconnecting a scrobbler can still legitimately reduce it.
  const _prev = entry.scores || {};
  if (_prev.daily_date === todayLabel) {
    for (const t of TRACKS) todayCounts[t.id] = Math.max(todayCounts[t.id] || 0, _prev[`daily_${t.id}`] || 0);
  }
  if (_prev.weekly_start === weekStartLabel) {
    for (const t of TRACKS) weekCounts[t.id] = Math.max(weekCounts[t.id] || 0, _prev[`weekly_${t.id}`] || 0);
  }

  // Keep Stamp Archive fresh (keyed by primary Last.fm username), using the
  // floored counts so a stamp/day-count can't regress either.
  if (lfmAccount) {
    try {
      await persistStamp(sb, lfmAccount.username, dayKey(dayFrom), buildTodayStamps(todayCounts));
    } catch {}
  }

  // Whole campaign incl. the Fallen Angel EP (LTAL + Fallen Angel + Heaven) so a
  // new release lifts the board. Mirrors CAMPAIGN_TOTAL_IDS / rankTids on the client
  // + leaderboard.js. (Per-track EP boards stay separate via overall_fallenangel/heaven.)
  const campaignTotal  = totalPlays.jump + totalPlays.shutdown + totalPlays.ddududu + totalPlays.ltal + totalPlays.go + totalPlays.sawadika + totalPlays.click + totalPlays.fallenangel + totalPlays.heaven + totalPlays.newtrick + totalPlays.v12 + totalPlays.cobra + totalPlays.tarantino + totalPlays.cutuoff + totalPlays.sweat + totalPlays.addicted + totalPlays.sth;

  return {
    username:      displayName,
    displayName,
    linkedAccounts,
    avatar:        entry.avatar,
    // Carry the signed-in owner id across refreshes. It was being dropped here
    // (the return replaced the whole entry), which both defeated the "never merge
    // two different owners" dedup guard AND left us without a stable per-user key
    // for the daily-counts archive below. Resolved above (entry value, or
    // recovered from linked_accounts) so it stays populated.
    appUserId:     appUserId || null,
    updatedAt:     new Date().toISOString(),
    lastScrobbleAt,
    // Carry the badges-page Musicat/Stats.fm breakdown forward across refreshes so
    // it survives until the fan's next visit refreshes it.
    providerScores: entry.providerScores || null,
    // Per-scrobbler split of today's counts, for the personal history calendar.
    todayBySource,
    scores: {
      overall_all:      campaignTotal,
      overall_jump:     totalPlays.jump,
      overall_shutdown: totalPlays.shutdown,
      overall_ddududu:  totalPlays.ddududu,
      overall_ltal:     totalPlays.ltal,
      overall_go:       totalPlays.go,
      overall_sawadika: totalPlays.sawadika,
      overall_click:    totalPlays.click,
      overall_fallenangel: totalPlays.fallenangel,
      overall_heaven:      totalPlays.heaven,
      overall_newtrick:    totalPlays.newtrick,
      overall_v12:    totalPlays.v12,
      overall_cobra:    totalPlays.cobra,
      overall_tarantino:    totalPlays.tarantino,
      overall_cutuoff:    totalPlays.cutuoff,
      overall_sweat:    totalPlays.sweat,
      overall_addicted: totalPlays.addicted,
      overall_sth:      totalPlays.sth,
      overall_artist:   artistPlays,
      daily_all:        (todayCounts.jump || 0) + (todayCounts.shutdown || 0) + (todayCounts.ddududu || 0) + (todayCounts.ltal || 0) + (todayCounts.go || 0) + (todayCounts.sawadika || 0) + (todayCounts.click || 0) + (todayCounts.fallenangel || 0) + (todayCounts.heaven || 0) + (todayCounts.newtrick || 0) + (todayCounts.v12 || 0) + (todayCounts.cobra || 0) + (todayCounts.tarantino || 0) + (todayCounts.cutuoff || 0) + (todayCounts.sweat || 0) + (todayCounts.addicted || 0) + (todayCounts.sth || 0),
      daily_jump:       todayCounts.jump     || 0,
      daily_shutdown:   todayCounts.shutdown || 0,
      daily_ddududu:    todayCounts.ddududu  || 0,
      daily_ltal:       todayCounts.ltal     || 0,
      daily_go:         todayCounts.go       || 0,
      daily_sawadika:   todayCounts.sawadika || 0,
      daily_click:      todayCounts.click    || 0,
      daily_fallenangel: todayCounts.fallenangel || 0,
      daily_heaven:      todayCounts.heaven      || 0,
      daily_newtrick:    todayCounts.newtrick    || 0,
      daily_v12:    todayCounts.v12    || 0,
      daily_cobra:    todayCounts.cobra    || 0,
      daily_tarantino:    todayCounts.tarantino    || 0,
      daily_cutuoff:    todayCounts.cutuoff    || 0,
      daily_sweat:    todayCounts.sweat    || 0,
      daily_addicted: todayCounts.addicted || 0,
      daily_sth:      todayCounts.sth      || 0,
      daily_date:       todayLabel,
      weekly_all:       (weekCounts.jump || 0) + (weekCounts.shutdown || 0) + (weekCounts.ddududu || 0) + (weekCounts.ltal || 0) + (weekCounts.go || 0) + (weekCounts.sawadika || 0) + (weekCounts.click || 0) + (weekCounts.fallenangel || 0) + (weekCounts.heaven || 0) + (weekCounts.newtrick || 0) + (weekCounts.v12 || 0) + (weekCounts.cobra || 0) + (weekCounts.tarantino || 0) + (weekCounts.cutuoff || 0) + (weekCounts.sweat || 0) + (weekCounts.addicted || 0) + (weekCounts.sth || 0),
      weekly_jump:      weekCounts.jump     || 0,
      weekly_shutdown:  weekCounts.shutdown || 0,
      weekly_ddududu:   weekCounts.ddududu  || 0,
      weekly_ltal:      weekCounts.ltal     || 0,
      weekly_go:        weekCounts.go       || 0,
      weekly_sawadika:  weekCounts.sawadika || 0,
      weekly_click:     weekCounts.click    || 0,
      weekly_fallenangel: weekCounts.fallenangel || 0,
      weekly_heaven:      weekCounts.heaven      || 0,
      weekly_newtrick:    weekCounts.newtrick    || 0,
      weekly_v12:    weekCounts.v12    || 0,
      weekly_cobra:    weekCounts.cobra    || 0,
      weekly_tarantino:    weekCounts.tarantino    || 0,
      weekly_cutuoff:    weekCounts.cutuoff    || 0,
      weekly_sweat:    weekCounts.sweat    || 0,
      weekly_addicted: weekCounts.addicted || 0,
      weekly_sth:      weekCounts.sth      || 0,
      weekly_start:     weekStartLabel,
    },
  };
}

function computeLeader(users) {
  const entries = Object.values(users || {}).map(u => ({ username: u.displayName || u.username, score: u.scores?.overall_all || 0 }));
  entries.sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
  return entries[0]?.score > 0 ? entries[0] : null;
}

function updateLeaderStreak(data) {
  const leader = computeLeader(data.users);
  if (!leader) return;
  if (data.leaderStreak?.username?.toLowerCase() !== leader.username.toLowerCase()) {
    data.leaderStreak = { username: leader.username, since: new Date().toISOString() };
  }
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = await redis.get(LB_KEY);
  if (!data?.users) return res.status(200).json({ ok: true, skipped: 'no users' });

  const sb = supabase();

  // Old-method entries (guest, just typed a username, never signed up with a
  // real account) are frozen out of the leaderboard entirely per the site's
  // migration notice: they neither count new scrobbles nor burn Last.fm API
  // calls until they create an account and re-link. The client submission
  // path already enforces this (it requires a Supabase session + verified
  // linked_accounts row), but this cron runs server-to-server with no client
  // involved, so it must check independently or it'll keep an old guest
  // entry updating forever. null (couldn't determine -- e.g. Supabase
  // unreachable this run) fails OPEN so a transient outage can't freeze
  // everyone.
  let verifiedUsernames = null;
  let linkedMap = null;
  let linkedByUser = null; // app_user_id -> [{ source, source_username }]
  if (sb) {
    try {
      const { data: linked, error } = await sb.from('linked_accounts').select('source, source_username, app_user_id');
      if (!error) {
        verifiedUsernames = new Set((linked || []).map(a => a.source_username.toLowerCase()));
        linkedMap = new Map((linked || []).map(a => [a.source_username.toLowerCase(), a.app_user_id]));
        linkedByUser = new Map();
        for (const a of (linked || [])) {
          if (!a.app_user_id) continue;
          if (!linkedByUser.has(a.app_user_id)) linkedByUser.set(a.app_user_id, []);
          linkedByUser.get(a.app_user_id).push({ source: a.source, source_username: a.source_username });
        }
      }
    } catch (e) { console.error('Failed to fetch verified linked accounts:', e); }
  }

  // Names from the Supabase auth profiles, keyed by owner id, in two maps:
  //   chosen — user_metadata.display_name, the ONLY field the badges page shows
  //            (set explicitly by the owner via updateUser). Authoritative.
  //   oauth  — name / full_name, the OAuth real name the site never displays. Kept
  //            solely so we can DETECT (and undo) a row that an earlier bug relabeled
  //            to this value, without ever showing it.
  // `complete` is true only when we paginated all the way to an empty page (proving
  // we saw every user even if perPage was clamped) and actually saw users — so a
  // partial/failed fetch can never trigger a revert.
  let nameInfo = null;
  if (sb) {
    const chosen = new Map();
    const oauth  = new Map();
    let scanned = 0, reachedEnd = false;
    try {
      for (let page = 1; page <= 50; page++) {
        const { data: au, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const list = au?.users || [];
        if (list.length === 0) { reachedEnd = true; break; }
        scanned += list.length;
        for (const u of list) {
          const md = u.user_metadata || u.raw_user_meta_data || {};
          const dn = (md.display_name || '').trim();
          if (dn) chosen.set(u.id, dn);
          const on = (md.name || md.full_name || '').trim();
          if (on) oauth.set(u.id, on);
        }
      }
      nameInfo = { chosen, oauth, complete: reachedEnd && scanned > 0 };
    } catch (e) {
      console.error('listUsers for display-name recovery failed:', e.message);
      nameInfo = null;
    }
  }

  function isVerified(entry) {
    if (!verifiedUsernames) return true;
    const accounts = Array.isArray(entry.linkedAccounts) && entry.linkedAccounts.length
      ? entry.linkedAccounts
      : [{ username: entry.username }];
    return accounts.some(a => verifiedUsernames.has((a.username || '').toLowerCase()));
  }

  const { from: dayFrom }  = getDayBounds();
  const { from: weekFrom } = getWeekBounds();
  const todayKey            = dayKey(dayFrom);
  const thisWeekKey         = dayKey(weekFrom);

  // NOTE: the finalized daily/weekly board is archived AFTER the refresh below
  // (every run, keyed to the CURRENT period) — NOT here on rollover. Archiving on
  // rollover snapshotted data.users at the FIRST cron after the 2am reset, by which
  // point early-bird visitors had already submitted NEXT-day scores, so the day's
  // "finalized" board froze their tiny new-day counts (e.g. a real 1,609 archived
  // as 124). Archiving the current period every run means the last pre-reset cron
  // (the 1:58am sweep) freezes the COMPLETE day, and post-reset runs archive the
  // new day instead of clobbering yesterday.
  data.currentDayKey    = todayKey;
  data.currentDayLabel  = fullDateLabel(new Date(dayFrom * 1000));
  data.currentWeekKey   = thisWeekKey;
  data.currentWeekLabel = `Week of ${fullDateLabel(new Date(weekFrom * 1000))}`;

  for (const u of data.banned || []) delete data.users[u];

  // Self-heal: re-create any verified account that has fallen off the board so a
  // user who vanishes (dropped by a past bug, or whose first submit never landed)
  // reappears on the next refresh instead of staying gone until they happen to
  // reopen their badges. Only seed users with a fetchable Last.fm/Libre.fm/
  // ListenBrainz account — a Musicat/Stats.fm-only fan can't be recomputed
  // server-side, so seeding them at 0 would misrepresent them; they still self-heal
  // the moment they open their badges (which submits their provider breakdown).
  const seeded = [];
  const seededKeys = new Set();
  if (linkedByUser && linkedByUser.size) {
    const bannedSet = new Set((data.banned || []).map(b => (b || '').toLowerCase()));
    // Usernames sitting on a LEGACY entry (no signed-in owner) — probably this
    // same fan pre-signup. We skip seeding when a scrobbler matches one of those.
    // We deliberately do NOT skip when the scrobbler is on a DIFFERENT signed-in
    // user's entry: two people (or two personas) can share a Musicat/Stats.fm
    // handle and still each deserve their own row ("same username, different
    // scrobbler / different login" are not duplicates).
    const legacyOnBoard = new Set();
    const boardOwners = new Set();
    for (const e of Object.values(data.users)) {
      if (e.appUserId) { boardOwners.add(e.appUserId); continue; }
      for (const a of (e.linkedAccounts || [])) {
        if ((a.type || a.source || '').toLowerCase() === 'extension') continue;
        const u = (a.username || '').toLowerCase();
        if (u) legacyOnBoard.add(u);
      }
    }
    for (const [uid, accts] of linkedByUser) {
      if (boardOwners.has(uid)) continue; // this signed-in user already has a row
      if (accts.some(a => legacyOnBoard.has((a.source_username || '').toLowerCase()))) continue;
      const linkedAccounts = accts
        .filter(a => a.source_username)
        .map(a => ({ type: a.source, username: a.source_username }));
      const seedable = linkedAccounts.some(a => ['lastfm', 'librefm', 'listenbrainz'].includes(a.type));
      if (!seedable) continue; // provider-only: needs a client visit to be correct
      const primary = linkedAccounts.find(a => a.type === 'lastfm' || a.type === 'librefm')
        || linkedAccounts.find(a => a.type === 'listenbrainz')
        || linkedAccounts[0];
      const key = primary.username.toLowerCase();
      if (bannedSet.has(key) || data.users[key]) continue;
      data.users[key] = {
        username: primary.username,
        displayName: primary.username, // upgraded to the real display name on next visit
        linkedAccounts,
        avatar: '',
        appUserId: uid,
        scores: {},
        updatedAt: new Date(0).toISOString(),
      };
      seeded.push(primary.username);
      seededKeys.add(key);
    }
  }

  // THE ORDER THE BOARD IS WALKED IN, AND WHY IT HAS TO MOVE.
  //
  // Object.values is insertion order, and the board object is the same JSON
  // reloaded every run, so this list is identical run after run. While the
  // Last.fm key was being exhausted a few seconds in, that meant the same
  // prefix of users was refreshed every time and the same tail never was —
  // 46 of 201 on one run, 88 on another, and the 46 a strict subset of the 88.
  // Nobody in the tail was ever going to recover on their own.
  //
  // The call budget is much smaller now, but a release day (everyone active, so
  // nobody idle-gated) can still cost more than one invocation has time for. So
  // the starting point rotates: whoever we did not reach is where the next run
  // begins. A run that covers half the board still covers all of it over two,
  // and no position on the list is a bad place to be.
  //
  // Stored as a KEY, not an index: entries are added and removed between runs,
  // so an index would quietly point at somebody else.
  const allUsers  = Object.values(data.users);
  let cursorKey   = null;
  try { cursorKey = await redis.get(SCROBBLE_CURSOR_KEY); } catch { /* fall back to the top */ }
  // Only search for a cursor we actually have. Without the guard, no cursor
  // compares equal to an entry whose username is blank and the run would start
  // from whichever broken row that is, rather than from the top.
  const wanted    = typeof cursorKey === 'string' ? cursorKey.toLowerCase() : '';
  const startAt   = wanted
    ? Math.max(0, allUsers.findIndex(e => (e.username || '').toLowerCase() === wanted))
    : 0;
  const users     = startAt ? [...allUsers.slice(startAt), ...allUsers.slice(0, startAt)] : allUsers;

  // The per-account cache that makes an idle account cost one request. Read
  // once here, mutated by refreshUser, written once at the end.
  let lfmCache = null;
  try { lfmCache = (await redis.get(LFM_CACHE_KEY)) || {}; } catch { lfmCache = {}; }

  // Stop cleanly rather than being killed mid-write. Whatever is left becomes
  // the next run's starting point, which is the whole point of the rotation.
  const RUN_BUDGET_MS = Number(process.env.SCROBBLE_RUN_BUDGET_MS || 180000);
  const runStartedAt  = Date.now();
  // Module-level, so it carries over on a warm instance. Zero it per run or the
  // reported figure is "every call this container ever made".
  lfmCalls    = 0;
  lfmNextSlot = 0;
  let   stoppedAt     = null;   // first user not reached, if we ran out of time

  const ok        = [];
  const failed    = [];
  const unverified = [];
  // Per-user floored daily counts captured this run, keyed by owner id, for the
  // durable per-day archive (user_daily_counts). This is the store that makes
  // badges match the leaderboard/finalized board on every device: each day is
  // written under its own (app_user_id, day_key) row, so — unlike the whole-board
  // snapshot — an early-bird who opens badges just after the 2am reset can never
  // overwrite the previous day, and Musicat/Stats.fm history (which the client
  // can't re-derive for past days) is frozen here while it was still "today".
  const dailyByUser = new Map();

  const batchSize = 3;
  for (let i = 0; i < users.length; i += batchSize) {
    if (Date.now() - runStartedAt > RUN_BUDGET_MS) {
      stoppedAt = users[i].username;
      break;
    }
    await Promise.all(users.slice(i, i + batchSize).map(async entry => {
      if (!isVerified(entry)) { unverified.push(entry.username); return; }
      try {
        const refreshed = await refreshUser(entry, sb, linkedMap, nameInfo, lfmCache);
        // Key by displayName (lowercased) so linked-account rows consolidate
        data.users[refreshed.displayName.toLowerCase()] = refreshed;
        // Remove the old key if the display name differs from the raw username
        if (entry.username.toLowerCase() !== refreshed.displayName.toLowerCase()) {
          delete data.users[entry.username.toLowerCase()];
        }
        // Durable per-day key: the signed-in owner id when we can resolve it, else a
        // RECOVERY key from the leaderboard display name ("user_<name>"). Before, an
        // entry whose owner id didn't resolve was dropped from the per-day store
        // entirely — which is what left accounts unrecoverable on the finalized board.
        // The name-keyed rows exist ONLY so those accounts can still be restored to a
        // finalized board later; they are never read back into the live leaderboard or
        // the badges history (both key off the owner id / UUID, never "user_<name>").
        // Keyed by leaderboard name, NOT the Last.fm handle, to avoid the handle↔name
        // confusion that caused earlier mislabels.
        const duKey = refreshed.appUserId
          || (refreshed.displayName ? `user_${refreshed.displayName.toLowerCase()}` : null);
        if (duKey) {
          const s = refreshed.scores || {};
          const bySrc = refreshed.todayBySource || {};
          dailyByUser.set(duKey, {
            jump:     s.daily_jump     || 0,
            shutdown: s.daily_shutdown || 0,
            ddududu:  s.daily_ddududu  || 0,
            ltal:     s.daily_ltal     || 0,
            go:       s.daily_go       || 0,
            // New releases — persisted per-user so the voting board (and badges) can
            // see them too. Written via a SEPARATE guarded upsert below, so a run
            // before the column migration lands just no-ops on these.
            sawadika:    s.daily_sawadika    || 0,
            click:       s.daily_click       || 0,
            fallenangel: s.daily_fallenangel || 0,
            heaven:      s.daily_heaven      || 0,
            newtrick:    s.daily_newtrick    || 0,
            v12:    s.daily_v12    || 0,
            cobra:    s.daily_cobra    || 0,
            tarantino:    s.daily_tarantino    || 0,
            cutuoff:    s.daily_cutuoff    || 0,
            sweat:    s.daily_sweat    || 0,
            addicted: s.daily_addicted || 0,
            sth:      s.daily_sth      || 0,
            by_source: Object.keys(bySrc).length ? bySrc : null,
          });
        }
        ok.push(refreshed.displayName);
      } catch (e) {
        failed.push({ username: entry.username, error: e.message });
        // A seed that can't be refreshed (e.g. Last.fm 404/403 on that account)
        // must not linger as a 0-score skeleton — drop it so the board stays clean.
        if (seededKeys.has(entry.username.toLowerCase())) {
          delete data.users[entry.username.toLowerCase()];
        }
      }
    }));
  }

  // Defensive merge: collapse two entries only when they are provably the SAME
  // person filed under two keys — e.g. a stale key left from before this
  // identity's "stable key" resolved differently on an earlier submission.
  // This MUST match by SOURCE+username pair, skip the extension source, and
  // never merge two different signed-in owners — the exact rules the POST
  // handler's cleanup uses. Matching by bare username (and counting the
  // extension) was catastrophic: every fan who links the Blinks United
  // extension shares that one constant username, so the cron treated them all
  // as one person and deleted all but the most-recently-refreshed — silently
  // dropping real, distinct accounts (blinksunited, blackpinkshazam, colxrzone…)
  // from the board every hour. "Same username, different scrobbler" and "two
  // different logins" are NOT duplicates.
  const src  = a => (a.type || a.source || '').toLowerCase();
  const acctPairs = entry => new Set(
    (entry.linkedAccounts || [])
      .filter(a => src(a) !== 'extension')
      .map(a => `${src(a)}:${(a.username || '').toLowerCase()}`)
      .filter(p => !p.endsWith(':')));
  const entries = Object.entries(data.users);
  const removedKeys = new Set();
  for (let i = 0; i < entries.length; i++) {
    const [keyA, entryA] = entries[i];
    if (removedKeys.has(keyA)) continue;
    const pairsA = acctPairs(entryA);
    if (!pairsA.size) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const [keyB, entryB] = entries[j];
      if (removedKeys.has(keyB)) continue;
      // Two different signed-in accounts are never the same person, even if a
      // scrobbler username coincides.
      if (entryA.appUserId && entryB.appUserId && entryA.appUserId !== entryB.appUserId) continue;
      const pairsB = acctPairs(entryB);
      if (![...pairsB].some(p => pairsA.has(p))) continue;
      // Both rows are the same person. Normally the most-recently-refreshed row
      // survives, but first prefer the one carrying a REAL chosen display name
      // over a self-heal seed still named after its raw Last.fm handle — otherwise
      // collapsing a colxrzone/eilan3502-style pair can freeze the handle as the
      // visible name. Scores are identical (both just refreshed from the same
      // accounts), so dropping the loser never loses counts.
      const isHandleName = e => {
        const dn = (e.displayName || '').toLowerCase();
        return (e.linkedAccounts || []).some(a => (a.username || '').toLowerCase() === dn);
      };
      const aHandle = isHandleName(entryA), bHandle = isHandleName(entryB);
      let dropA;
      if (aHandle !== bHandle) {
        dropA = aHandle; // keep the real-named row
      } else {
        const aTime = new Date(entryA.updatedAt || 0).getTime();
        const bTime = new Date(entryB.updatedAt || 0).getTime();
        dropA = bTime >= aTime;
      }
      if (dropA) { delete data.users[keyA]; removedKeys.add(keyA); break; }
      delete data.users[keyB]; removedKeys.add(keyB);
    }
  }

  // ── Fallen Angel EP first-24h auto-snapshots ───────────────────────────────
  // Capture the community scrobble total of the NEW drop (Fallen Angel + Heaven)
  // at the 2am-Rome Spotify reset and again at the 24h mark, so the release card
  // can show "at Spotify reset: X · at 24h: Y" once the first day closes. Stored on
  // the board object (persisted below) and read client-side in loadLtalStreamsGoal.
  try {
    const FAEP_RELEASE_MS = Date.parse('2026-08-28T04:00:00Z'); // 6am Rome — EP drop
    const FAEP_RESET_MS   = Date.parse('2026-08-29T00:00:00Z'); // first 2am-Rome reset after drop
    const FAEP_H24_MS     = FAEP_RELEASE_MS + 86400000;         // 6am Rome next day
    const FAEP_WEEK_MS    = FAEP_RELEASE_MS + 7 * 86400000;     // first-week close — 6am Rome, Sep 4
    const now = Date.now();
    // Capture ONLY inside a tight window around each mark, so a cron run long after
    // the moment (e.g. this feature deploying after the window already closed) can
    // never record a wrong, much-later value. reset: between 2am and 6am; 24h: the
    // 2h after 6am. Outside those windows nothing is recorded (the card then just
    // shows the running First-week count).
    const inResetWin = now >= FAEP_RESET_MS && now < FAEP_H24_MS;               // 2am → 6am
    const inH24Win   = now >= FAEP_H24_MS   && now < FAEP_H24_MS + 2 * 3600000; // 6am → 8am
    // First-week freeze: capture the new-drop total once the 7-day mark passes, on
    // the first cron run in the 12h window after it (6am → 6pm Sep 4). The card then
    // stops the running "First week" number and shows this frozen value instead.
    const inWeekWin  = now >= FAEP_WEEK_MS  && now < FAEP_WEEK_MS + 12 * 3600000;
    if (inResetWin || inH24Win || inWeekWin) {
      // Exclude secondary (merged) usernames — mirrors computeCommunityTotal client-side.
      const secondary = new Set();
      for (const [k, d] of Object.entries(data.users)) {
        for (const a of (d.linkedAccounts || [])) {
          const ak = (a.username || '').toLowerCase();
          if (ak && ak !== k) secondary.add(ak);
        }
      }
      let newDrop = 0;
      for (const [k, d] of Object.entries(data.users)) {
        if (secondary.has(k.toLowerCase())) continue;
        newDrop += (d.scores?.overall_fallenangel || 0) + (d.scores?.overall_heaven || 0);
      }
      const snap = data._faepSnap || {};
      if (inResetWin && snap.reset == null) snap.reset = newDrop;
      if (inH24Win   && snap.h24   == null) snap.h24   = newDrop;
      if (inWeekWin  && snap.week  == null) snap.week  = newDrop;
      data._faepSnap = snap;
    }
  } catch (e) { console.warn('FAEP snapshot failed:', e.message); }

  data.lastUpdated = new Date().toISOString();
  updateLeaderStreak(data);
  await redis.set(LB_KEY, data);

  // Where the next run starts. Ran out of budget → resume at the first user we
  // never reached, so the tail of this run is the head of the next and the
  // cut-off keeps moving round the board. Got through everyone → there is no
  // tail to make up for, so clear it and start from the top again.
  // Written AFTER the board, so a failure here can never cost a refresh.
  try {
    if (stoppedAt) await redis.set(SCROBBLE_CURSOR_KEY, stoppedAt);
    else           await redis.del(SCROBBLE_CURSOR_KEY);
  } catch (e) { console.error('scrobble cursor write failed:', e.message || e); }

  // Drop cache entries for accounts no longer on the board, so this key tracks
  // the board instead of growing forever.
  try {
    if (lfmCache) {
      const live = new Set();
      for (const e of Object.values(data.users)) {
        for (const a of (e.linkedAccounts || [{ username: e.username }])) {
          if (a.username) live.add(a.username.toLowerCase());
        }
      }
      for (const k of Object.keys(lfmCache)) if (!live.has(k)) delete lfmCache[k];
      await redis.set(LFM_CACHE_KEY, lfmCache);
    }
  } catch (e) { console.error('lastfm cache write failed:', e.message || e); }

  // Freeze the finalized daily/weekly board for the CURRENT period from the fresh,
  // floored board. Overwrites each run; the last run before the 2am reset (the
  // 1:58am sweep) is the one that sticks for the day, so the archived board holds
  // everyone's complete day instead of the racy post-reset snapshot (see note above).
  try { await archivePeriod(sb, 'daily', todayKey, data.currentDayLabel, data.users); }
  catch (e) { console.error('archive daily (current) failed:', e); }
  try { await archivePeriod(sb, 'weekly', thisWeekKey, data.currentWeekLabel, data.users); }
  catch (e) { console.error('archive weekly (current) failed:', e); }

  // Pristine end-of-day restore point: a full-board snapshot the display and repair
  // paths NEVER touch (repair only rewrites period 'daily'; the archive read API only
  // serves 'daily'/'weekly', so 'daily_backup' is invisible to the site). Written
  // every run, so the last pre-reset run — the 1:58am forced refresh — leaves the
  // complete, untouched day here, ready to restore from if anything downstream breaks.
  try { await archivePeriod(sb, 'daily_backup', todayKey, data.currentDayLabel, data.users); }
  catch (e) { console.error('archive daily_backup failed:', e); }

  // ── Community goal backstop ───────────────────────────────────
  // Record today's community goal server-side the moment the board crosses the
  // threshold, instead of relying on a visitor loading the home page while the
  // goal shows hit (the old client-only path, which silently missed whole days —
  // e.g. a 15k+ day with no qualifying home-page visit). The cron runs hourly
  // plus the 1:58am end-of-day sweep, so any day that hits the goal is captured.
  // Max-merged so a partial run can never lower an already-recorded day.
  let goalRecorded = null;
  try {
    const todayDDMM  = ddmm(new Date(dayFrom * 1000));
    const goalTotal  = communityGoalTotal(data.users, todayDDMM);
    if (goalTotal >= GOAL_PRIMARY) {
      const gh = (await redis.get(GOAL_HISTORY_KEY)) || { days: {} };
      gh.days = gh.days || {};
      const prevTotal = gh.days[todayKey]?.total || 0;
      const total = Math.max(goalTotal, prevTotal);
      gh.days[todayKey] = { total, primary: true, stretch: total >= GOAL_SECONDARY, recordedAt: new Date().toISOString() };
      await redis.set(GOAL_HISTORY_KEY, gh);
      goalRecorded = { day: todayKey, total, stretch: total >= GOAL_SECONDARY };
    }
  } catch (e) { console.error('community goal record failed:', e.message || e); }

  // Freeze each refreshed user's floored daily counts into the durable per-day
  // archive. Max-merged against what's already stored for the same day so a
  // partial/rate-limited run can never LOWER a day that was previously higher —
  // the same "counts only climb until reset" guarantee the leaderboard has, now
  // made durable and device-independent. Wrapped so a missing table (before the
  // one-time migration is applied) degrades to a no-op instead of failing the run.
  let dailyArchived = 0;
  if (sb && dailyByUser.size) {
    try {
      const ids = [...dailyByUser.keys()];
      const { data: existing, error: exErr } = await sb
        .from('user_daily_counts')
        // Include the new-release columns so the max-merge below can't LOWER a
        // value the live submit path (api/leaderboard POST) already persisted for
        // a source this server-side pull can't reproduce (extension / Musicat /
        // Stats.fm / private Last.fm). Core columns were always selected; without
        // the new-release ones here a cron run that computed 0 for them would wipe
        // a real live-persisted sawadika/click/fallenangel/heaven back to 0.
        .select('app_user_id,jump,shutdown,ddududu,ltal,go,sawadika,click,fallenangel,heaven')
        .eq('day_key', todayKey)
        .in('app_user_id', ids);
      if (exErr) throw exErr;
      const exMap = new Map((existing || []).map(r => [r.app_user_id, r]));
      const now = new Date().toISOString();
      const rows = ids.map(id => {
        const n = dailyByUser.get(id);
        const e = exMap.get(id) || {};
        return {
          app_user_id: id,
          day_key:     todayKey,
          jump:     Math.max(n.jump,     e.jump     || 0),
          shutdown: Math.max(n.shutdown, e.shutdown || 0),
          ddududu:  Math.max(n.ddududu,  e.ddududu  || 0),
          ltal:     Math.max(n.ltal,     e.ltal     || 0),
          go:       Math.max(n.go,       e.go       || 0),
          updated_at: now,
        };
      });
      const { error: upErr } = await sb
        .from('user_daily_counts')
        .upsert(rows, { onConflict: 'app_user_id,day_key' });
      if (upErr) throw upErr;
      dailyArchived = rows.length;

      // Per-scrobbler breakdown, written SEPARATELY so a missing by_source column
      // (before its migration is applied) can't fail the totals write above. Only
      // sets by_source; the counts stay whatever the main upsert just wrote.
      const bsRows = ids
        .filter(id => dailyByUser.get(id).by_source)
        .map(id => ({ app_user_id: id, day_key: todayKey, by_source: dailyByUser.get(id).by_source }));
      if (bsRows.length) {
        try {
          const { error: bsErr } = await sb
            .from('user_daily_counts')
            .upsert(bsRows, { onConflict: 'app_user_id,day_key' });
          if (bsErr) throw bsErr;
        } catch (e2) {
          console.error('user_daily_counts by_source upsert failed (column migrated yet?):', e2.message || e2);
        }
      }

      // New-release per-day counts, written SEPARATELY (same reason as by_source):
      // a run before the sawadika/click/fallenangel/heaven columns exist no-ops here
      // instead of failing the totals write above. Re-fetched live each run, so
      // today's plays fill in on the next run once the columns are present.
      const nrRows = ids.map(id => {
        const n = dailyByUser.get(id);
        return {
          app_user_id: id, day_key: todayKey,
          sawadika:    Math.max(n.sawadika    || 0, exMap.get(id)?.sawadika    || 0),
          click:       Math.max(n.click       || 0, exMap.get(id)?.click       || 0),
          fallenangel: Math.max(n.fallenangel || 0, exMap.get(id)?.fallenangel || 0),
          heaven:      Math.max(n.heaven      || 0, exMap.get(id)?.heaven      || 0),
        };
      });
      if (nrRows.length) {
        try {
          const { error: nrErr } = await sb
            .from('user_daily_counts')
            .upsert(nrRows, { onConflict: 'app_user_id,day_key' });
          if (nrErr) throw nrErr;
        } catch (e3) {
          console.error('user_daily_counts new-release upsert failed (columns migrated yet?):', e3.message || e3);
        }
      }

      // "new trick" (ROSÉ, 2026-09-17) per-day count — written in its OWN fully
      // isolated guarded block that reads its own existing value, so a run before
      // the `newtrick` column is migrated no-ops here WITHOUT disturbing any column
      // above (it is deliberately kept out of the shared select on line ~1106 for
      // exactly that reason). No plays exist until release, so this is a 0-write
      // until then; add the column with:
      //   ALTER TABLE user_daily_counts ADD COLUMN IF NOT EXISTS newtrick integer NOT NULL DEFAULT 0;
      try {
        const { data: ntEx } = await sb
          .from('user_daily_counts')
          .select('app_user_id,newtrick')
          .eq('day_key', todayKey)
          .in('app_user_id', ids);
        const ntMap = new Map((ntEx || []).map(r => [r.app_user_id, r]));
        const ntRows = ids.map(id => ({
          app_user_id: id, day_key: todayKey,
          newtrick: Math.max(dailyByUser.get(id).newtrick || 0, ntMap.get(id)?.newtrick || 0),
        }));
        if (ntRows.length) {
          const { error: ntErr } = await sb
            .from('user_daily_counts')
            .upsert(ntRows, { onConflict: 'app_user_id,day_key' });
          if (ntErr) throw ntErr;
        }
      } catch (eNt) {
        console.error('user_daily_counts newtrick upsert skipped (column migrated yet?):', eNt.message || eNt);
      }

      // JISOO "ADDICTED" (2026-10-30) persisted in its OWN isolated guarded
      // upsert, for the same reason newtrick has one: a missing `addicted`
      // column must not disturb any column above it. It had no column at all
      // until the 2026-11 migration, so the badges grid showed no ADDICTED row
      // from release day onward while every other count kept working.
      //   ALTER TABLE user_daily_counts ADD COLUMN IF NOT EXISTS addicted integer NOT NULL DEFAULT 0;
      try {
        const { data: adEx } = await sb
          .from('user_daily_counts')
          .select('app_user_id,addicted')
          .eq('day_key', todayKey)
          .in('app_user_id', ids);
        const adMap = new Map((adEx || []).map(r => [r.app_user_id, r]));
        const adRows = ids.map(id => ({
          app_user_id: id, day_key: todayKey,
          addicted: Math.max(dailyByUser.get(id).addicted || 0, adMap.get(id)?.addicted || 0),
        }));
        if (adRows.length) {
          const { error: adErr } = await sb
            .from('user_daily_counts')
            .upsert(adRows, { onConflict: 'app_user_id,day_key' });
          if (adErr) throw adErr;
        }
      } catch (eAd) {
        console.error('user_daily_counts addicted upsert skipped (column migrated yet?):', eAd.message || eAd);
      }

      // JENNIE "Someone to Hold" (2026-11-06), its own isolated guarded upsert
      // for the same reason as the two above: a missing `sth` column must not
      // disturb any column beside it. Written from release day rather than
      // after someone notices a flat row — ADDICTED's column landed a week
      // late and its badge grid was empty for that week.
      //   ALTER TABLE user_daily_counts ADD COLUMN IF NOT EXISTS sth integer NOT NULL DEFAULT 0;
      try {
        const { data: sthEx } = await sb
          .from('user_daily_counts')
          .select('app_user_id,sth')
          .eq('day_key', todayKey)
          .in('app_user_id', ids);
        const sthMap = new Map((sthEx || []).map(r => [r.app_user_id, r]));
        const sthRows = ids.map(id => ({
          app_user_id: id, day_key: todayKey,
          sth: Math.max(dailyByUser.get(id).sth || 0, sthMap.get(id)?.sth || 0),
        }));
        if (sthRows.length) {
          const { error: sthErr } = await sb
            .from('user_daily_counts')
            .upsert(sthRows, { onConflict: 'app_user_id,day_key' });
          if (sthErr) throw sthErr;
        }
      } catch (eSth) {
        console.error('user_daily_counts sth upsert skipped (column migrated yet?):', eSth.message || eSth);
      }
    } catch (e) {
      console.error('user_daily_counts upsert failed:', e.message || e);
    }
  }

  // THE OUTAGE WAS INVISIBLE, AND THAT IS ITS OWN BUG. Every run through it
  // answered 200 with ok:true while 155 of 201 users had failed, so the
  // workflow went green for days and the first notice was a fan writing in. A
  // report that can only be read by counting the lines of a list nobody reads
  // is not a report, so the shape of the failure is named here, in the body,
  // where the workflow can act on it.
  const rateLimited = failed.filter(f => /error 29|Rate Limit/i.test(f.error || '')).length;
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true, seeded, refreshed: ok, failed, unverified, merged: [...removedKeys],
    dailyArchived, goalRecorded,
    // Diagnostics. lastfmCalls is the number this run actually spent, which is
    // the figure to watch: it was ~3,600 before the idle gate.
    lastfmCalls:  lfmCalls,
    rateLimited,
    startedFrom:  startAt ? users[0]?.username : null,
    stoppedAt,
    tookMs:       Date.now() - runStartedAt,
  });
}
