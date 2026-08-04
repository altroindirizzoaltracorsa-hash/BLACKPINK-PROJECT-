/*
 * Background service worker.
 *
 * Core idea: SessionBox isolates each tab's Spotify login, so every tab is a
 * different logged-in Spotify account. The content script reports which account
 * a tab belongs to (read from inside the tab), and this worker routes that tab's
 * scrobbles to whatever Last.fm / Libre.fm / ListenBrainz accounts the user has
 * mapped to that Spotify account. One extension, many accounts — routed by the
 * Spotify identity the tab reveals, never by SessionBox internals.
 */
import * as AS from './scrobblers/audioscrobbler.js';
import * as LB from './scrobblers/listenbrainz.js';

const DEFAULT_SETTINGS = {
  lastfm: { apiKey: '', secret: '' },
  librefm: { apiKey: '', secret: '' },
};

// In-memory per-tab playback state (rebuilt as messages arrive; not persisted).
const tabs = {};

// ---------- storage helpers ----------

async function getStore() {
  const s = await chrome.storage.local.get(['settings', 'profiles']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    profiles: s.profiles || {},
  };
}

async function setProfiles(profiles) {
  await chrome.storage.local.set({ profiles });
}

// Create a profile the first time we see a Spotify account, so it shows up in
// the options page ready for the user to attach scrobbling services.
async function ensureProfile(account) {
  if (!account || !account.id) return null;
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
  return profiles[account.id];
}

// ---------- scrobble dispatch ----------

function trackKey(t) {
  return t ? `${(t.artist || '').toLowerCase()}${(t.title || '').toLowerCase()}` : '';
}

async function dispatch(kind, account, track, timestamp) {
  if (!account || !account.id) return;
  const { settings, profiles } = await getStore();
  const profile = profiles[account.id];
  if (!profile || profile.enabled === false) return;

  const jobs = [];

  for (const svc of ['lastfm', 'librefm']) {
    const conn = profile[svc];
    const cfg = settings[svc];
    if (conn && conn.sk && cfg && cfg.apiKey && cfg.secret) {
      const fn = kind === 'nowplaying'
        ? AS.updateNowPlaying(svc, cfg.apiKey, cfg.secret, conn.sk, track)
        : AS.scrobble(svc, cfg.apiKey, cfg.secret, conn.sk, track, timestamp);
      jobs.push(fn.catch((e) => console.warn(`[${svc}] ${kind} failed:`, e.message)));
    }
  }

  if (profile.listenbrainz && profile.listenbrainz.token) {
    const token = profile.listenbrainz.token;
    const fn = kind === 'nowplaying'
      ? LB.updateNowPlaying(token, track)
      : LB.scrobble(token, track, timestamp);
    jobs.push(fn.catch((e) => console.warn(`[listenbrainz] ${kind} failed:`, e.message)));
  }

  await Promise.all(jobs);
  if (kind === 'scrobble') {
    console.log(`Scrobbled "${track.artist} - ${track.title}" for ${profile.label}`);
  }
}

// Last.fm rule: scrobble once a track has played for half its length or 4
// minutes, whichever comes first; ignore tracks under 30s.
function scrobbleThresholdMs(duration) {
  if (duration && duration > 0) {
    if (duration < 30) return Infinity;
    return Math.min(duration / 2, 240) * 1000;
  }
  return 240 * 1000; // duration unknown: fall back to 4 minutes of play
}

// ---------- playback tracking ----------

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function handleUpdate(tabId, msg) {
  const state = tabs[tabId] || (tabs[tabId] = { account: null, cur: null });

  if (msg.account) {
    state.account = msg.account;
    await ensureProfile(msg.account);
  }

  const track = msg.track && msg.track.artist && msg.track.title ? msg.track : null;
  const playing = !!msg.playing && !!track;
  const now = Date.now();

  // Nothing playing / stopped.
  if (!track) {
    if (state.cur) state.cur.playing = false;
    return;
  }

  const key = trackKey(track);

  // New track.
  if (!state.cur || state.cur.key !== key) {
    state.cur = {
      key,
      track,
      startedAt: nowSec(),
      playedMs: 0,
      lastTs: now,
      playing,
      nowPlayingSent: false,
      scrobbled: false,
    };
    if (playing) {
      state.cur.nowPlayingSent = true;
      dispatch('nowplaying', state.account, track);
    }
    return;
  }

  // Same track: advance accumulated play time.
  const cur = state.cur;
  if (cur.playing) cur.playedMs += now - cur.lastTs;
  cur.lastTs = now;
  cur.playing = playing;
  if (track.duration && !cur.track.duration) cur.track.duration = track.duration;

  if (playing && !cur.nowPlayingSent) {
    cur.nowPlayingSent = true;
    dispatch('nowplaying', state.account, cur.track);
  }

  if (!cur.scrobbled && cur.playedMs >= scrobbleThresholdMs(cur.track.duration)) {
    cur.scrobbled = true;
    dispatch('scrobble', state.account, cur.track, cur.startedAt);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => { delete tabs[tabId]; });

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'update':
          await handleUpdate(sender.tab && sender.tab.id, msg);
          sendResponse({ ok: true });
          break;

        case 'getState': {
          const store = await getStore();
          const { pendingAuth } = await chrome.storage.local.get('pendingAuth');
          sendResponse({ ...store, pendingAuth: pendingAuth || null });
          break;
        }

        case 'cancelAuth': {
          await chrome.storage.local.remove('pendingAuth');
          sendResponse({ ok: true });
          break;
        }

        case 'saveSettings': {
          await chrome.storage.local.set({ settings: msg.settings });
          sendResponse({ ok: true });
          break;
        }

        case 'startWebAuth': {
          const { settings } = await getStore();
          const cfg = settings[msg.service];
          if (!cfg || !cfg.apiKey || !cfg.secret) {
            throw new Error(`Set the ${msg.service} API key and secret first.`);
          }
          const token = await AS.getToken(msg.service, cfg.apiKey, cfg.secret);
          await chrome.storage.local.set({
            pendingAuth: { service: msg.service, token, profileId: msg.profileId },
          });
          sendResponse({ ok: true, url: AS.authUrl(msg.service, cfg.apiKey, token) });
          break;
        }

        case 'finishWebAuth': {
          const { pendingAuth } = await chrome.storage.local.get('pendingAuth');
          if (!pendingAuth) throw new Error('No auth in progress.');
          const { settings, profiles } = await getStore();
          const cfg = settings[pendingAuth.service];
          const session = await AS.getSession(
            pendingAuth.service, cfg.apiKey, cfg.secret, pendingAuth.token,
          );
          const p = profiles[pendingAuth.profileId];
          if (!p) throw new Error('Profile no longer exists.');
          p[pendingAuth.service] = { sk: session.key, name: session.name };
          await setProfiles(profiles);
          await chrome.storage.local.remove('pendingAuth');
          sendResponse({ ok: true, service: pendingAuth.service, name: session.name });
          break;
        }

        case 'saveListenBrainz': {
          const check = await LB.validateToken(msg.token);
          if (!check.valid) throw new Error('ListenBrainz rejected that token.');
          const { profiles } = await getStore();
          const p = profiles[msg.profileId];
          if (!p) throw new Error('Profile no longer exists.');
          p.listenbrainz = { token: msg.token, user: check.user };
          await setProfiles(profiles);
          sendResponse({ ok: true, user: check.user });
          break;
        }

        case 'disconnect': {
          const { profiles } = await getStore();
          const p = profiles[msg.profileId];
          if (p) { p[msg.service] = null; await setProfiles(profiles); }
          sendResponse({ ok: true });
          break;
        }

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
  return true; // async response
});
