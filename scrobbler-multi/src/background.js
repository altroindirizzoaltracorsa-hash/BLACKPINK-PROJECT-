/*
 * Background service worker.
 *
 * Goal: capture what EVERY open SessionBox Spotify tab is playing — including
 * tabs sitting in the background — and scrobble each to the account(s) mapped
 * to that tab's Spotify identity.
 *
 * Why polling instead of per-tab timers: Chrome heavily throttles (and can
 * suspend) timers running inside background tabs, so a content script's own
 * setInterval only fires reliably in the foreground tab. Instead, an alarm in
 * this worker fires on a schedule and injects a one-shot reader into every
 * Spotify tab. Because the injection is driven from here, it isn't subject to
 * the target tab's timer throttling, so background tabs get read too.
 *
 * State must survive the worker being unloaded between alarms, so per-tab
 * playback progress lives in chrome.storage.session (in-memory, cleared when
 * the browser closes) rather than a plain variable.
 */
import * as AS from './scrobblers/audioscrobbler.js';
import * as LB from './scrobblers/listenbrainz.js';
import * as BU from './scrobblers/blinks.js';

const POLL_ALARM = 'poll';
const POLL_MINUTES = 0.5; // 30s (Chrome clamps to its minimum if lower)
const DEFAULT_ACCT = '__default__';

const DEFAULT_SETTINGS = {
  lastfm: { apiKey: '', secret: '' },
  librefm: { apiKey: '', secret: '' },
  // A connection here is used by any profile that has no connection of its own.
  defaults: { lastfm: null, librefm: null, listenbrainz: null },
  // blinksunited direct target: one profile token for the whole browser
  // install; every Spotify account funnels to it. Additive, off by default.
  // Endpoints are derived from `site` (so login-linking can set both at once).
  blinks: { site: 'https://blinksunited.com', token: '', enabled: false },
};

// ---------- storage ----------

async function getStore() {
  const s = await chrome.storage.local.get(['settings', 'profiles']);
  const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  settings.defaults = { ...DEFAULT_SETTINGS.defaults, ...(settings.defaults || {}) };
  settings.blinks = { ...DEFAULT_SETTINGS.blinks, ...(settings.blinks || {}) };
  return { settings, profiles: s.profiles || {} };
}

async function setProfiles(profiles) {
  await chrome.storage.local.set({ profiles });
}

async function ensureProfile(account) {
  if (!account || !account.id) return;
  const { profiles } = await getStore();
  if (!profiles[account.id]) {
    profiles[account.id] = {
      id: account.id,
      label: account.name || account.id,
      enabled: true,
      lastfm: null,
      librefm: null,
      listenbrainz: null,
    };
    await setProfiles(profiles);
  } else if (account.name && profiles[account.id].label !== account.name) {
    profiles[account.id].label = account.name;
    await setProfiles(profiles);
  }
}

// ---------- scrobble dispatch ----------

function trackKey(t) {
  return t ? `${(t.artist || '').toLowerCase()}${(t.title || '').toLowerCase()}` : '';
}

async function dispatch(kind, account, track, timestamp, meta) {
  if (!account || !account.id) return;
  const { settings, profiles } = await getStore();
  const profile = profiles[account.id];
  if (profile && profile.enabled === false) return;

  // Per-profile connection wins; otherwise fall back to the shared default.
  const pick = (svc) => (profile && profile[svc]) || settings.defaults[svc] || null;
  const jobs = [];

  const track_ = () => `"${track.artist} - ${track.title}" (${account.name || account.id})`;
  const targets = [];
  const run = (label, promise) => promise
    .then(() => true)
    .catch((e) => { console.warn(`[${label}] ${kind} failed for ${track_()}:`, e.message); return false; });

  for (const svc of ['lastfm', 'librefm']) {
    const conn = pick(svc);
    const cfg = settings[svc];
    if (conn && conn.sk && cfg && cfg.apiKey && cfg.secret) {
      targets.push(`${svc}:${conn.name || '?'}`);
      jobs.push(run(svc, kind === 'nowplaying'
        ? AS.updateNowPlaying(svc, cfg.apiKey, cfg.secret, conn.sk, track)
        : AS.scrobble(svc, cfg.apiKey, cfg.secret, conn.sk, track, timestamp)));
    }
  }

  const lb = pick('listenbrainz');
  if (lb && lb.token) {
    targets.push(`listenbrainz:${lb.user || '?'}`);
    jobs.push(run('listenbrainz', kind === 'nowplaying'
      ? LB.updateNowPlaying(lb.token, track)
      : LB.scrobble(lb.token, track, timestamp)));
  }

  // blinksunited direct — scrobble only (no now-playing), install-wide token.
  const bu = settings.blinks;
  if (kind === 'scrobble' && bu && bu.enabled && bu.token) {
    const endpoint = `${(bu.site || 'https://blinksunited.com').replace(/\/$/, '')}/api/ingest-scrobble`;
    targets.push('blinksunited');
    jobs.push(run('blinks', BU.scrobble(endpoint, bu.token, track, timestamp, account.name || account.id)));
  }

  const results = await Promise.all(jobs);
  if (kind === 'scrobble') {
    const okTargets = targets.filter((_, i) => results[i]);
    if (!jobs.length) {
      console.warn(`⚠️ No scrobble target for ${account.name || account.id} — connect a default or per-profile account.`);
    } else if (okTargets.length) {
      console.log(`✅ Scrobbled ${track_()} → ${okTargets.join(', ')}`);
      recordScrobble(account, track, okTargets, meta);
    } else {
      console.warn(`❌ Scrobble rejected for ${track_()} (see the failure line above)`);
    }
  }
}

// ---------- scrobble stats (per-account counters + recent history) ----------

const EMPTY_STATS = { total: 0, counts: {}, history: [] };

// Writes are serialized so concurrent scrobbles in one poll don't clobber
// each other's read-modify-write on the stored stats.
let statsChain = Promise.resolve();
function recordScrobble(account, track, targets, meta = {}) {
  const id = account.id;
  const label = account.name || id;
  statsChain = statsChain.then(async () => {
    const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
    stats.total = (stats.total || 0) + 1;
    stats.counts = stats.counts || {};
    if (!stats.counts[id]) stats.counts[id] = { label, count: 0, tracks: {} };
    stats.counts[id].count += 1;
    stats.counts[id].label = label;
    // Per-track tally for this account, so the options page can break each
    // account down track-by-track (to compare against a playlist).
    stats.counts[id].tracks = stats.counts[id].tracks || {};
    const trackKey = `${track.artist} — ${track.title}`;
    const tr = stats.counts[id].tracks[trackKey] || { title: track.title, artist: track.artist, count: 0 };
    tr.count += 1;
    stats.counts[id].tracks[trackKey] = tr;
    stats.history = stats.history || [];
    stats.history.unshift({
      n: stats.total,
      t: Date.now(),
      artist: track.artist,
      title: track.title,
      account: label,
      accountId: id,
      targets,
      played: meta.playedS != null ? meta.playedS : null,
      pct: meta.pct != null ? meta.pct : null,
    });
    if (stats.history.length > 100) stats.history.length = 100;
    await chrome.storage.local.set({ stats });
  }).catch((e) => console.warn('recordScrobble failed:', e.message));
  return statsChain;
}

// Count threshold: 40s of playback — a safety margin above Spotify's 30s stream
// minimum, still well below Skipper Pro's ~64-81s skip point. A play counts once
// it has been played for 40s, once per track (the per-track guard is the
// `scrobbled` flag + trackKey). Songs shorter than 30s never count.
//
// Why not 60: paired with Skipper Pro (auto-skips every song at ~64-81s), a 60s
// bar left only a ~6s window (60s→skip) for our 30s poll to catch the song
// before it was skipped, so genuine streams were dropped (observed: 15 Skipper
// skips vs 12 of ours). 40s keeps a solid margin over Spotify's 30s stream floor
// while giving the poll a much wider window; combined with the finalize-on-skip
// safety net below, songs skipped at 70s+ (the vast majority) are always caught.
// The only softness is the occasional fast skip (64-69s), where an unlucky poll
// phase can miss one — an accepted trade for the extra conservatism of 40s.
const COUNT_THRESHOLD_S = 40;
function scrobbleThresholdMs(duration) {
  if (duration && duration > 0 && duration < 30) return Infinity;
  return COUNT_THRESHOLD_S * 1000;
}

// ---------- per-tab progress (advances a persisted record) ----------

function advance(prev, msg, now, jobs) {
  const rec = prev || { account: null, cur: null };
  if (msg.account) {
    rec.account = msg.account;
    jobs.push(ensureProfile(msg.account));
  }

  // A scrobble needs both title and artist; skip ads and artist-less items.
  const t = msg.track;
  const isAd = t && t.title && /^(advertisement|spotify|spotify ad)$/i.test(t.title.trim());
  const track = t && t.title && t.artist && !isAd ? t : null;
  if (!track) {
    if (rec.cur) rec.cur.playing = false;
    return rec;
  }

  const key = trackKey(track);
  const sameTrack = rec.cur && rec.cur.key === key;
  const domPos = typeof msg.domPos === 'number' ? msg.domPos : 0;
  const mediaPos = typeof msg.mediaPos === 'number' ? msg.mediaPos : 0;

  if (!sameTrack) {
    // Finalize the OUTGOING track before we replace it. A poll may never have
    // observed it cross the threshold if it was skipped between polls — Skipper
    // Pro skips every song at ~64-81s, and if our last poll for it landed early
    // (e.g. we first saw it late, past the lead-in window) the credited counter
    // can still be under the bar when it vanishes. Use the last REAL playhead
    // position we saw (lastDomPos) as proof of the stream: if it was still
    // playing and had already reached the threshold on screen, scrobble it now.
    // Gated on `playing` so a paused-then-changed track never counts.
    const out = rec.cur;
    if (out && !out.scrobbled && out.playing) {
      const outDur = out.track.duration || 0;
      const outThr = (outDur && outDur < 30) ? Infinity : COUNT_THRESHOLD_S;
      const reachedS = Math.max(Math.round(out.playedMs / 1000), out.lastDomPos || 0);
      if (reachedS >= outThr) {
        out.scrobbled = true;
        const pct = outDur ? Math.min(100, Math.round((reachedS / outDur) * 100)) : null;
        jobs.push(dispatch('scrobble', rec.account, out.track, out.startedAt, { playedS: reachedS, pct }));
      }
    }
    // Credit the lead-in. Polling latches onto a track mid-play, so the first
    // poll usually catches it a few seconds in (e.g. domPos=8). Those seconds
    // were genuinely played from the top, but the old code started the counter
    // at 0 and only credited advances AFTER the first poll — silently dropping
    // that lead-in. On a real 60s+ listen that loss pushed the play-time just
    // under the 60s scrobble threshold: a first song caught at 0:08 reached the
    // bar 8s "late" and could be skipped to the next track before any poll saw
    // it cross 60s, so it never scrobbled (exactly what happened to JUMP in the
    // wild). If we catch the track early in its runtime (within ~1.5 poll
    // cycles of the start), seed playedMs with the seconds already on its clock.
    // Caught later than that window we can't assume play-from-start (tab opened
    // mid-song, a seek, or a missed poll), so start at 0 — conservative, exactly
    // the old behaviour, never over-credits.
    const LEAD_IN_MAX_S = 45;
    const leadIn = (domPos > 0 && domPos <= LEAD_IN_MAX_S) ? domPos : 0;
    rec.cur = {
      key,
      track,
      startedAt: Math.floor(now / 1000) - leadIn,
      playedMs: leadIn * 1000,
      lastTs: now,
      lastDomPos: domPos,
      lastMediaPos: mediaPos,
      playing: true,
      nowPlayingSent: true,
      scrobbled: false,
    };
    jobs.push(dispatch('nowplaying', rec.account, track));
    return rec;
  }

  const cur = rec.cur;

  // Credit real listened time by how far the position ADVANCED, using whichever
  // source moved — the on-screen player timer (domPos, always the real track)
  // or the media element (mediaPos). This avoids trusting a "paused" flag that
  // Spotify often reports wrong, and ignores the Canvas loop (which doesn't
  // advance the real timer). Cap to wall-clock so a seek isn't counted as play.
  const wall = (now - cur.lastTs) / 1000;
  let progressed = 0;
  if (typeof cur.lastDomPos === 'number' && domPos > cur.lastDomPos) {
    progressed = domPos - cur.lastDomPos;
  } else if (typeof cur.lastMediaPos === 'number' && mediaPos > cur.lastMediaPos) {
    progressed = mediaPos - cur.lastMediaPos;
  }
  const playing = progressed > 0;
  if (progressed > 0) cur.playedMs += Math.min(progressed, wall + 5) * 1000;

  cur.lastTs = now;
  cur.lastDomPos = domPos;
  cur.lastMediaPos = mediaPos;
  cur.playing = playing;
  if (track.duration && !cur.track.duration) cur.track.duration = track.duration;

  if (playing && !cur.nowPlayingSent) {
    cur.nowPlayingSent = true;
    jobs.push(dispatch('nowplaying', rec.account, cur.track));
  }
  if (!cur.scrobbled && cur.playedMs >= scrobbleThresholdMs(cur.track.duration)) {
    cur.scrobbled = true;
    const playedS = Math.round(cur.playedMs / 1000);
    const dur = cur.track.duration || 0;
    const pct = dur ? Math.min(100, Math.round((playedS / dur) * 100)) : null;
    jobs.push(dispatch('scrobble', rec.account, cur.track, cur.startedAt, { playedS, pct }));
  }
  return rec;
}

// ---------- the poll ----------

// Injected into each Spotify tab's MAIN world. Self-contained (no closures):
// reads the now-playing track from mediaSession, and — only when asked — the
// tab's own Spotify account via its isolated cookies.
async function readState(needAccount) {
  function clock(sel) {
    const el = document.querySelector(sel);
    if (!el) return 0;
    const p = el.textContent.trim().split(':').map(Number);
    if (!p.length || p.some(isNaN)) return 0;
    return p.reduce((a, n) => a * 60 + n, 0);
  }

  // Pick the REAL track element, not the short looping "Canvas" visual.
  // Spotify pages can have several <video>/<audio> elements; the Canvas loop is
  // a few seconds long and often paused/stuck, which previously made played=0
  // for songs that were actually playing. Prefer a playing element with a
  // track-length duration (>30s), then any long element, then anything.
  const medias = Array.from(document.querySelectorAll('video, audio'));
  const longPlaying = medias.find((m) => !m.paused && isFinite(m.duration) && m.duration > 30);
  const anyLong = medias.find((m) => isFinite(m.duration) && m.duration > 30);
  const anyPlaying = medias.find((m) => !m.paused && (m.currentTime || 0) > 0);
  const media = longPlaying || anyLong || anyPlaying || medias[0] || null;

  const mediaPos = media ? Math.floor(media.currentTime || 0) : 0;
  const mediaDur = (media && isFinite(media.duration) && media.duration > 0) ? Math.floor(media.duration) : 0;
  // The on-screen player timer reflects the REAL track (never the Canvas loop).
  const domPos = clock('[data-testid="playback-position"]');
  const domDur = clock('[data-testid="playback-duration"]');
  const duration = domDur || mediaDur;

  // Track: prefer mediaSession, but fill any missing field from the DOM. Many
  // (free/web-player) tabs don't populate mediaSession, and Last.fm rejects a
  // scrobble with no artist, so the artist fallback matters most.
  const md = navigator.mediaSession && navigator.mediaSession.metadata;
  let title = md && md.title ? md.title : '';
  let artist = md && md.artist ? md.artist : '';
  let album = md && md.album ? md.album : '';

  const widget = document.querySelector('[data-testid="now-playing-widget"]');
  if (!title) {
    const t = document.querySelector('[data-testid="context-item-link"]')
      || document.querySelector('[data-testid="context-item-info-title"]');
    if (t) title = (t.textContent || '').trim();
  }
  if (!artist) {
    // Artist links are language-independent (the name text, not "by"/"di").
    const scope = widget || document;
    const links = Array.from(scope.querySelectorAll('a[href*="/artist/"]'))
      .map((a) => (a.textContent || '').trim()).filter(Boolean);
    if (links.length) {
      artist = Array.from(new Set(links)).join(', ');
    } else {
      const a = document.querySelector('[data-testid="context-item-info-artist"]')
        || document.querySelector('[data-testid="context-item-info-subtitles"]');
      if (a) artist = (a.textContent || '').trim();
    }
  }

  const track = title ? { title, artist, album, duration } : null;

  let account = null;
  if (needAccount) {
    let token = null;
    try {
      const r = await fetch(
        'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
        { credentials: 'include' },
      );
      if (r.ok) { const j = await r.json(); if (j.accessToken && !j.isAnonymous) token = j.accessToken; }
    } catch (e) { /* try dom */ }
    if (!token) {
      for (const id of ['session', 'config']) {
        const el = document.getElementById(id);
        if (el && el.textContent) {
          try { const j = JSON.parse(el.textContent); if (j.accessToken) { token = j.accessToken; break; } } catch (e) { /* */ }
        }
      }
    }
    if (!token) {
      for (const s of document.querySelectorAll('script')) {
        const m = (s.textContent || '').match(/"accessToken"\s*:\s*"([^"]+)"/);
        if (m) { token = m[1]; break; }
      }
    }
    if (token) {
      try {
        const me = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
        if (me.ok) { const u = await me.json(); if (u && u.id) account = { id: u.id, name: u.display_name || u.id }; }
      } catch (e) { /* dom fallback */ }
    }
    if (!account) {
      const sels = [
        '[data-testid="user-widget-name"]',
        '[data-testid="user-widget-link"]',
        'button[data-testid="user-widget-link"] img[alt]',
        'img[data-testid="user-widget-avatar"][alt]',
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        const name = el && (el.textContent || el.getAttribute('alt'));
        if (name && name.trim()) { const c = name.trim(); account = { id: `name:${c.toLowerCase()}`, name: c }; break; }
      }
    }
  }

  return { account, track, domPos, mediaPos, duration };
}

// Injected after a stuck-tab reload to resume playback hands-free. Clicks the
// page's main Play button (the playlist/context play), which restarts the
// context; falls back to the bottom player's play/pause only when it's showing
// "Play" (paused) so we never accidentally pause a track that's already going.
// Only called on a tab we just reloaded (so it's stopped), never on a live one.
function clickPlay() {
  const q = (s) => document.querySelector(s);
  const ctx = q('[data-testid="action-bar-row"] [data-testid="play-button"]')
           || q('[data-testid="play-button"]');
  if (ctx) { ctx.click(); return { clicked: 'context', label: ctx.getAttribute('aria-label') || '' }; }
  const pp = q('[data-testid="control-button-playpause"]');
  if (pp) {
    const lbl = (pp.getAttribute('aria-label') || '').toLowerCase();
    // Language-agnostic-ish "play" match (en/it/pt/es/fr/de).
    if (/play|riprod|reprodu|lectur|abspiel/.test(lbl)) { pp.click(); return { clicked: 'playpause', label: lbl }; }
    return { clicked: null, label: lbl };
  }
  return { clicked: null };
}

// Stuck-tab watchdog: Spotify-Free ad freezes (and hung players) leave a tab
// where the position never advances and play/pause won't recover it — only a
// reload does. If a tab hasn't advanced for STUCK_LIMIT consecutive polls
// (~2 min, well past a normal 30–60s ad break so we don't reload mid-ad), we
// reload it and then click Play to resume, self-healing unattended farming.
const STUCK_LIMIT = 4;   // polls with no position advance before we reload
const RESUME_MAX  = 6;   // resume-click attempts after a reload before giving up

let polling = false;

async function poll() {
  // Prevent overlapping runs: a slow poll must not race a second one on the
  // shared pbState, which caused the same track to scrobble repeatedly.
  if (polling) { console.log('[poll] skipped — previous run still in progress'); return; }
  polling = true;
  try {
    await pollOnce();
  } finally {
    polling = false;
  }
}

async function pollOnce() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: 'https://open.spotify.com/*' });
  } catch (e) { return; }

  const { pbState = {} } = await chrome.storage.session.get('pbState');
  const now = Date.now();
  const alive = new Set();
  const jobs = [];

  console.log(`[poll] ${tabs.length} Spotify tab(s)`);
  for (const tab of tabs) {
    alive.add(String(tab.id));
    const prev = pbState[tab.id] || null;
    const needAccount = !(prev && prev.account);
    let result = null;
    try {
      const inj = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: readState,
        args: [needAccount],
      });
      result = inj && inj[0] ? inj[0].result : null;
    } catch (e) {
      console.log(`[poll] tab ${tab.id}: unreadable (${e.message}) — loading/discarded/frozen`);
      continue;
    }
    if (!result) continue;
    const acct = (result.account && result.account.name) || (prev && prev.account && prev.account.name) || '?';
    pbState[tab.id] = advance(prev, result, now, jobs);
    const c = pbState[tab.id].cur;
    const tr = result.track || {};
    console.log(`[poll] tab ${tab.id}: acct=${acct} track="${tr.title || '—'}" artist="${tr.artist || '—'}" `
      + `domPos=${result.domPos}s mediaPos=${result.mediaPos}s playing=${c ? c.playing : false} `
      + `played=${c ? Math.round(c.playedMs / 1000) : 0}s${c && c.scrobbled ? ' [scrobbled]' : ''}`);

    // ---- stuck-tab watchdog (auto-recover frozen ad / hung player) ----
    const rec = pbState[tab.id];
    rec.recover = rec.recover || { stuck: 0, reloadedAt: 0, resumeTries: 0 };
    const advancing = !!(c && c.playing);
    if (rec.recover.reloadedAt) {
      // We recently reloaded this tab — keep clicking Play until it plays again.
      if (advancing) {
        rec.recover.reloadedAt = 0; rec.recover.resumeTries = 0;
      } else if (now - rec.recover.reloadedAt > 4000 && rec.recover.resumeTries < RESUME_MAX) {
        rec.recover.resumeTries += 1;
        const n = rec.recover.resumeTries;
        jobs.push(chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: clickPlay })
          .then((r) => console.log(`[recover] tab ${tab.id}: resume click #${n} →`, r && r[0] && r[0].result))
          .catch(() => {}));
      } else if (rec.recover.resumeTries >= RESUME_MAX) {
        console.warn(`[recover] tab ${tab.id}: couldn't auto-resume after reload — autoplay may be blocked; click Play once to prime it.`);
        rec.recover.reloadedAt = 0;
      }
      rec.recover.stuck = 0;
    } else if (c && !advancing) {
      // Only watch tabs that have actually been playing (c exists); a truly
      // idle/never-started tab is left alone. Normal 30–60s ad breaks won't
      // reach STUCK_LIMIT, so we only fire on a genuine multi-minute freeze.
      rec.recover.stuck += 1;
      if (rec.recover.stuck >= STUCK_LIMIT) {
        console.warn(`[recover] tab ${tab.id} (acct=${acct}) frozen ${rec.recover.stuck} polls — reloading to unstick.`);
        rec.recover.stuck = 0;
        rec.recover.reloadedAt = now;
        rec.recover.resumeTries = 0;
        jobs.push(chrome.tabs.reload(tab.id).catch(() => {}));
      }
    } else {
      rec.recover.stuck = 0;
    }
  }

  for (const id of Object.keys(pbState)) if (!alive.has(id)) delete pbState[id];

  await chrome.storage.session.set({ pbState });
  await Promise.all(jobs);
}

function ensureAlarm() {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener((a) => { if (a.name === POLL_ALARM) poll(); });

// ---------- message router (options page) ----------

async function saveConnection(profileId, svc, value) {
  const { settings, profiles } = await getStore();
  if (profileId === DEFAULT_ACCT) {
    settings.defaults[svc] = value;
    await chrome.storage.local.set({ settings });
  } else {
    const p = profiles[profileId];
    if (!p) throw new Error('Profile no longer exists.');
    p[svc] = value;
    await setProfiles(profiles);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'getState':
          sendResponse(await getStore());
          break;

        case 'getStats': {
          const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
          sendResponse(stats);
          break;
        }

        case 'clearStats':
          await chrome.storage.local.set({ stats: { total: 0, counts: {}, history: [] } });
          sendResponse({ ok: true });
          break;

        case 'saveSettings': {
          const { settings } = await getStore();
          settings.lastfm = msg.settings.lastfm;
          settings.librefm = msg.settings.librefm;
          await chrome.storage.local.set({ settings });
          sendResponse({ ok: true });
          break;
        }

        case 'saveBlinks': {
          const { settings } = await getStore();
          const site = (msg.site || DEFAULT_SETTINGS.blinks.site).trim().replace(/\/$/, '');
          settings.blinks = { site, token: (msg.token || '').trim(), enabled: !!msg.enabled };
          await chrome.storage.local.set({ settings });
          let check = { valid: null };
          if (settings.blinks.enabled && settings.blinks.token) {
            check = await BU.validateToken(`${site}/api/ingest-scrobble`, settings.blinks.token);
          }
          sendResponse({ ok: true, check, site });
          break;
        }

        case 'connectPassword': {
          const { settings } = await getStore();
          const cfg = settings[msg.service];
          if (!cfg || !cfg.apiKey || !cfg.secret) {
            throw new Error(`Set the ${msg.service} API key and secret first.`);
          }
          const session = await AS.getMobileSession(
            msg.service, cfg.apiKey, cfg.secret, msg.username, msg.password,
          );
          await saveConnection(msg.profileId, msg.service, { sk: session.key, name: session.name });
          sendResponse({ ok: true, name: session.name });
          break;
        }

        case 'saveListenBrainz': {
          const check = await LB.validateToken(msg.token);
          if (!check.valid) throw new Error('ListenBrainz rejected that token.');
          await saveConnection(msg.profileId, 'listenbrainz', { token: msg.token, user: check.user });
          sendResponse({ ok: true, user: check.user });
          break;
        }

        case 'disconnect':
          await saveConnection(msg.profileId, msg.service, null);
          sendResponse({ ok: true });
          break;

        case 'toggleProfile': {
          const { profiles } = await getStore();
          const p = profiles[msg.profileId];
          if (p) { p.enabled = msg.enabled; await setProfiles(profiles); }
          sendResponse({ ok: true });
          break;
        }

        case 'removeProfile': {
          const { profiles } = await getStore();
          delete profiles[msg.profileId];
          await setProfiles(profiles);
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
