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
    if (!stats.counts[id]) stats.counts[id] = { label, count: 0 };
    stats.counts[id].count += 1;
    stats.counts[id].label = label;
    stats.history = stats.history || [];
    stats.history.unshift({
      n: stats.total,
      t: Date.now(),
      artist: track.artist,
      title: track.title,
      account: label,
      targets,
      played: meta.playedS != null ? meta.playedS : null,
      pct: meta.pct != null ? meta.pct : null,
    });
    if (stats.history.length > 100) stats.history.length = 100;
    await chrome.storage.local.set({ stats });
  }).catch((e) => console.warn('recordScrobble failed:', e.message));
  return statsChain;
}

// Mirror Skipper Pro's counting rule: a play counts once it has been played for
// ~60s (Skipper's window is ~60-86s), once per track (the per-track guard is the
// `scrobbled` flag + trackKey, matching Skipper's lastTrackName check). Sub-30s
// clips never count. This keeps the scrobble counter in lockstep with Skipper's
// stream counter.
const COUNT_THRESHOLD_S = 60;
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

  // Decide "playing" without reading any UI text (locale-independent):
  // trust an explicit mediaSession state, else infer from position advancing.
  let playing;
  if (msg.playbackState === 'playing') {
    playing = true;
  } else if (msg.playbackState === 'paused') {
    playing = false;
  } else if (sameTrack && typeof rec.cur.lastPosition === 'number') {
    playing = msg.position > rec.cur.lastPosition;
  } else {
    playing = true; // first sighting, unknown state — assume playing; next poll confirms
  }

  if (!sameTrack) {
    rec.cur = {
      key,
      track,
      startedAt: Math.floor(now / 1000),
      playedMs: 0,
      lastTs: now,
      lastPosition: msg.position,
      playing,
      nowPlayingSent: false,
      scrobbled: false,
    };
    if (playing) {
      rec.cur.nowPlayingSent = true;
      jobs.push(dispatch('nowplaying', rec.account, track));
    }
    return rec;
  }

  const cur = rec.cur;
  if (cur.playing) cur.playedMs += now - cur.lastTs;
  cur.lastTs = now;
  cur.lastPosition = msg.position;
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

  // Read the actual media element first: its currentTime/paused keep advancing
  // even when a background tab's on-screen position counter is throttled, and
  // paused is an unambiguous, language-independent play state.
  let position = 0;
  let duration = 0;
  let mediaState = null;
  const media = document.querySelector('video, audio');
  if (media) {
    position = Math.floor(media.currentTime || 0);
    if (isFinite(media.duration) && media.duration > 0) duration = Math.floor(media.duration);
    mediaState = media.paused ? 'paused' : 'playing';
  }
  if (!duration) duration = clock('[data-testid="playback-duration"]');
  if (!position) position = clock('[data-testid="playback-position"]');

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

  // Raw state signals; the worker decides "playing" (see advance()) so it can
  // use position-advance, which does not depend on UI language.
  const playbackState = mediaState
    || (navigator.mediaSession && navigator.mediaSession.playbackState) || 'none';

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

  return { account, track, position, playbackState };
}

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
      + `state=${result.playbackState} pos=${result.position}s playing=${c ? c.playing : false} `
      + `played=${c ? Math.round(c.playedMs / 1000) : 0}s${c && c.scrobbled ? ' [scrobbled]' : ''}`);
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
