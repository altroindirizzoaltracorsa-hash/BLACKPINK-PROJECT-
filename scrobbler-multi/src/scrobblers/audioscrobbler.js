/*
 * AudioScrobbler 2.0 client — shared by Last.fm and Libre.fm.
 * Libre.fm runs GNU FM, which implements the same 2.0 API, so the only
 * difference between the two services is the API root URL.
 */
import { md5 } from '../lib/md5.js';

export const SERVICES = {
  lastfm: {
    id: 'lastfm',
    name: 'Last.fm',
    apiRoot: 'https://ws.audioscrobbler.com/2.0/',
    authRoot: 'https://www.last.fm/api/auth/',
  },
  librefm: {
    id: 'librefm',
    name: 'Libre.fm',
    apiRoot: 'https://libre.fm/2.0/',
    authRoot: 'https://libre.fm/api/auth/',
  },
};

// Sign params per the AudioScrobbler spec: sort by name, concat name+value,
// append the shared secret, then MD5.
function sign(params, secret) {
  const keys = Object.keys(params).filter((k) => k !== 'format' && k !== 'callback').sort();
  let str = '';
  for (const k of keys) str += k + params[k];
  str += secret;
  return md5(str);
}

async function apiCall(apiRoot, params, secret, { post = false } = {}) {
  const signed = { ...params, api_sig: sign(params, secret) };
  signed.format = 'json';
  const body = new URLSearchParams(signed);
  let url = apiRoot;
  const opts = { method: post ? 'POST' : 'GET' };
  if (post) {
    opts.body = body;
    opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  } else {
    url += '?' + body.toString();
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    throw new Error(`${data.error}: ${data.message || 'API error'}`);
  }
  return data;
}

// --- Auth (per-account) ---

// Step 1: get a request token to send the user to the auth page.
export async function getToken(service, apiKey, secret) {
  const svc = SERVICES[service];
  const data = await apiCall(svc.apiRoot, { method: 'auth.getToken', api_key: apiKey }, secret);
  return data.token;
}

export function authUrl(service, apiKey, token) {
  const svc = SERVICES[service];
  return `${svc.authRoot}?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
}

// Step 3 (after the user approves): exchange the token for a session key.
export async function getSession(service, apiKey, secret, token) {
  const svc = SERVICES[service];
  const data = await apiCall(svc.apiRoot, { method: 'auth.getSession', api_key: apiKey, token }, secret);
  return { key: data.session.key, name: data.session.name };
}

// --- Scrobbling ---

export async function updateNowPlaying(service, apiKey, secret, sk, track) {
  const svc = SERVICES[service];
  const params = {
    method: 'track.updateNowPlaying',
    api_key: apiKey,
    sk,
    artist: track.artist,
    track: track.title,
  };
  if (track.album) params.album = track.album;
  if (track.duration) params.duration = String(Math.round(track.duration));
  return apiCall(svc.apiRoot, params, secret, { post: true });
}

export async function scrobble(service, apiKey, secret, sk, track, timestamp) {
  const svc = SERVICES[service];
  const params = {
    method: 'track.scrobble',
    api_key: apiKey,
    sk,
    artist: track.artist,
    track: track.title,
    timestamp: String(timestamp),
  };
  if (track.album) params.album = track.album;
  if (track.duration) params.duration = String(Math.round(track.duration));
  return apiCall(svc.apiRoot, params, secret, { post: true });
}
