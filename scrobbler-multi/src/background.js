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

const POLL_ALARM = 'poll';
const POLL_MINUTES = 0.5; // 30s (Chrome clamps to its minimum if lower)
const DEFAULT_ACCT = '__default__';

const DEFAULT_SETTINGS = {
  lastfm: { apiKey: '', secret: '' },
  librefm: { apiKey: '', secret: '' },
  // A connection here is used by any profile that has no connection of its own.
  defaults: { lastfm: null, librefm: null, listenbrainz: null },
};

// ---------- storage ----------

async function getStore() {
  const s = await chrome.storage.local.get(['settings', 'profiles']);
  const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  settings.defaults = { ...DEFAULT_SETTINGS.defaults, ...(settings.defaults || {}) };
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

async function dispatch(kind, account, track, timestamp) {
  if (!account || !account.id) return;
  const { settings, profiles } = await getStore();
  const profile = profiles[account.id];
  if (profile && profile.enabled === false) return;

  // Per-profile connection wins; otherwise fall back to the shared default.
  const pick = (svc) => (profile && profile[svc]) || settings.defaults[svc] || null;
  const jobs = [];

  for (const svc of ['lastfm', 'librefm']) {
    const conn = pick(svc);
    const cfg = settings[svc];
    if (conn && conn.sk && cfg && cfg.apiKey && cfg.secret) {
      const fn = kind === 'nowplaying'
        ? AS.updateNowPlaying(svc, cfg.apiKey, cfg.secret, conn.sk, track)
        : AS.scrobble(svc, cfg.apiKey, cfg.secret, conn.sk, track, timestamp);
      jobs.push(fn.catch((e) => console.warn(`[${svc}] ${kind} failed:`, e.message)));
    }
  }

  const lb = pick('listenbrainz');
  if (lb && lb.token) {
    const fn = kind === 'nowplaying'
      ? LB.updateNowPlaying(lb.token, track)
      : LB.scrobble(lb.token, track, timestamp);
    jobs.push(fn.catch((e) => console.warn(`[listenbrainz] ${kind} failed:`, e.message)));
  }

  await Promise.all(jobs);
  if (kind === 'scrobble' && jobs.length) {
    console.log(`Scrobbled "${track.artist} - ${track.title}" (${account.name || account.id})`);
  }
}

// Last.fm rule: scrobble after half the track or 4 minutes, whichever is first;
// skip tracks under 30s.
function scrobbleThresholdMs(duration) {
  if (duration && duration > 0) {
    if (duration < 30) return Infinity;
    return Math.min(duration / 2, 240) * 1000;
  }
  return 240 * 1000;
}

// ---------- per-tab progress (advances a persisted record) ----------

function advance(prev, msg, now, jobs) {
  const rec = prev || { account: null, cur: null };
  if (msg.account) {
    rec.account = msg.account;
    jobs.push(ensureProfile(msg.account));
  }

  const track = msg.track && msg.track.artist && msg.track.title ? msg.track : null;
  const playing = !!msg.playing && !!track;

  if (!track) {
    if (rec.cur) rec.cur.playing = false;
    return rec;
  }

  const key = trackKey(track);

  if (!rec.cur || rec.cur.key !== key) {
    rec.cur = {
      key,
      track,
      startedAt: Math.floor(now / 1000),
      playedMs: 0,
      lastTs: now,
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
  cur.playing = playing;
  if (track.duration && !cur.track.duration) cur.track.duration = track.duration;

  if (playing && !cur.nowPlayingSent) {
    cur.nowPlayingSent = true;
    jobs.push(dispatch('nowplaying', rec.account, cur.track));
  }
  if (!cur.scrobbled && cur.playedMs >= scrobbleThresholdMs(cur.track.duration)) {
    cur.scrobbled = true;
    jobs.push(dispatch('scrobble', rec.account, cur.track, cur.startedAt));
  }
  return rec;
}

// ---------- the poll ----------

// Injected into each Spotify tab's MAIN world. Self-contained (no closures):
// reads the now-playing track from mediaSession, and — only when asked — the
// tab's own Spotify account via its isolated cookies.
async function readState(needAccount) {
  function parseDuration() {
    const el = document.querySelector('[data-testid="playback-duration"]');
    if (!el) return 0;
    const p = el.textContent.trim().split(':').map(Number);
    if (p.some(isNaN)) return 0;
    return p.reduce((a, n) => a * 60 + n, 0);
  }

  const md = navigator.mediaSession && navigator.mediaSession.metadata;
  const track = md && md.title
    ? { title: md.title, artist: md.artist || '', album: md.album || '', duration: parseDuration() }
    : null;

  let playing = false;
  if (track) {
    const st = navigator.mediaSession.playbackState;
    if (st) {
      playing = st === 'playing';
    } else {
      const b = document.querySelector('[data-testid="control-button-playpause"]');
      playing = b ? /pause/i.test(b.getAttribute('aria-label') || '') : false;
    }
  }

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

  return { account, playing, track };
}

async function poll() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: 'https://open.spotify.com/*' });
  } catch (e) { return; }

  const { pbState = {} } = await chrome.storage.session.get('pbState');
  const now = Date.now();
  const alive = new Set();
  const jobs = [];

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
      continue; // tab still loading, discarded, or frozen — try again next poll
    }
    if (!result) continue;
    pbState[tab.id] = advance(prev, result, now, jobs);
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

        case 'saveSettings': {
          const { settings } = await getStore();
          settings.lastfm = msg.settings.lastfm;
          settings.librefm = msg.settings.librefm;
          await chrome.storage.local.set({ settings });
          sendResponse({ ok: true });
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
