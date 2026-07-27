/**
 * fetch-apple-global-chart.mjs
 *
 * Fetches the Apple Music Global Top 100 playlist.
 *
 * Token extraction order:
 *   1. Cached token (.apple-token-cache) — call API directly, fast
 *   2. Plain HTTP fetch of music.apple.com — scan HTML/scripts for JWT
 *   3. Playwright browser — intercept window.fetch via addInitScript
 *
 * Saves:
 *   data/apple-global-chart-latest.json
 *   data/apple-global-chart-YYYY-MM-DD.json
 *   .apple-token-cache  (committed, refreshed when expired)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');
const TOKEN_CACHE = join(REPO_ROOT, '.apple-token-cache');

const PLAYLIST_ID = 'pl.d25f5d1181894928af76c85c967f8f31';
const PLAYLIST_URL = `https://music.apple.com/us/playlist/top-100-global/${PLAYLIST_ID}`;
const API_BASE = 'https://api.music.apple.com/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ARTIST_PATTERNS = [
  /\bblackpink\b/i, /\blisa\b/i, /\blalisa\b/i, /\bjennie\b/i,
  /ros[eé]/i, /\bjisoo\b/i, /블랙핑크/, /리사/, /제니/, /로제/, /지수/,
];
function isBlackpink(a = '') { return ARTIST_PATTERNS.some(p => p.test(a)); }
function identifyMember(a = '') {
  if (/\bblackpink\b/i.test(a) || /블랙핑크/.test(a)) return 'BLACKPINK';
  if (/\blisa\b/i.test(a) || /\blalisa\b/i.test(a) || /리사/.test(a)) return 'LISA';
  if (/\bjennie\b/i.test(a) || /제니/.test(a)) return 'JENNIE';
  if (/ros[eé]/i.test(a) || /로제/.test(a)) return 'ROSÉ';
  if (/\bjisoo\b/i.test(a) || /지수/.test(a)) return 'JISOO';
  return 'BLACKPINK';
}

// ── API call ──────────────────────────────────────────────────────────────────

async function callApi(token, path) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
      'User-Agent': UA,
    },
  });
  if (!resp.ok) {
    console.log(`  API ${path} → HTTP ${resp.status}`);
    return null;
  }
  return resp.json();
}

async function fetchTracks(token) {
  const data = await callApi(token, `/catalog/us/playlists/${PLAYLIST_ID}?include=tracks`);
  return data?.data?.[0]?.relationships?.tracks?.data ?? null;
}

// ── Token extraction: Method 1 — plain HTTP scan ──────────────────────────────

async function extractTokenFromHttp() {
  console.log('  [Method 1] Scanning music.apple.com HTML for token…');
  try {
    const resp = await fetch(PLAYLIST_URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    });
    const html = await resp.text();

    // Pattern A: meta tag config
    const metaM = html.match(/name="desktop-music-app\/config\/environment"\s+content="([^"]+)"/);
    if (metaM) {
      try {
        const cfg = JSON.parse(decodeURIComponent(metaM[1]));
        const t = cfg?.MEDIA_API?.token;
        if (t) { console.log('  ✓ Token from meta tag'); return t; }
      } catch (_) {}
    }

    // Pattern B: token JSON key
    const tokenM = html.match(/"token"\s*:\s*"(eyJ[A-Za-z0-9._-]{50,})"/);
    if (tokenM) { console.log('  ✓ Token from HTML script'); return tokenM[1]; }

    // Pattern C: scan JS bundle URLs found in the HTML
    const scriptUrls = [...html.matchAll(/src="(https?:\/\/[^"]*\.js[^"]*)"/g)].map(m => m[1]);
    const appBundles = scriptUrls.filter(u => u.includes('music.apple.com'));
    console.log(`  Scanning ${appBundles.length} app JS bundles…`);
    for (const url of appBundles.slice(0, 5)) {
      const r = await fetch(url, { headers: { 'User-Agent': UA } }).catch(() => null);
      if (!r?.ok) continue;
      const js = await r.text();
      const m = js.match(/["']?(eyJ[A-Za-z0-9._-]{100,})["']?/);
      if (m) { console.log(`  ✓ Token from JS bundle ${url.split('/').pop()}`); return m[1]; }
    }
  } catch (e) {
    console.log(`  Method 1 error: ${e.message}`);
  }
  return null;
}

// ── Token extraction: Method 2 — Playwright with fetch intercept ──────────────

async function extractTokenViaBrowser() {
  console.log('  [Method 2] Launching Chromium with fetch intercept…');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });

  // Inject script before any page JS runs — intercepts window.fetch
  await context.addInitScript(() => {
    const _fetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('api.music.apple.com')) {
        const auth = (init?.headers?.Authorization ?? init?.headers?.authorization ?? '');
        if (auth.startsWith('Bearer ')) {
          window.__amToken = auth.slice(7);
        }
      }
      return _fetch.apply(this, arguments);
    };

    // Also intercept XMLHttpRequest
    const _open = XMLHttpRequest.prototype.open;
    const _setReqHeader = XMLHttpRequest.prototype.setRequestHeader;
    const _xhrUrls = new WeakMap();
    XMLHttpRequest.prototype.open = function (m, url) {
      _xhrUrls.set(this, url);
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if ((_xhrUrls.get(this) ?? '').includes('api.music.apple.com') &&
          name.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
        window.__amToken = value.slice(7);
      }
      return _setReqHeader.apply(this, arguments);
    };
  });

  const page = await context.newPage();
  let capturedData = null;

  // Also intercept response bodies for playlist data
  page.on('response', async response => {
    const url = response.url();
    if (!url.includes('api.music.apple.com') || !url.includes('playlists')) return;
    try {
      const json = await response.json();
      const tracks = json?.data?.[0]?.relationships?.tracks?.data ?? [];
      if (tracks.length > 0) capturedData = tracks;
    } catch (_) {}
  });

  try {
    await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log(`  Navigation: ${e.message}`);
  }
  await page.waitForTimeout(6000);

  // Read token from page context
  const token = await page.evaluate(() => window.__amToken ?? null).catch(() => null);
  if (token) console.log(`  ✓ Token captured via fetch intercept (${token.slice(0, 20)}…)`);

  // If we have response data already, use it
  if (!capturedData && token) {
    capturedData = await fetchTracks(token);
  }

  await browser.close();
  return { token, tracks: capturedData };
}

// ── Parse raw track objects ───────────────────────────────────────────────────

function parseTracks(raw) {
  return raw.map((t, i) => {
    const attr = t.attributes ?? {};
    const artistName = attr.artistName ?? t.artist ?? '';
    return {
      position: i + 1,
      name: attr.name ?? t.title ?? '',
      artists: artistName,
      member: isBlackpink(artistName) ? identifyMember(artistName) : null,
      releaseDate: attr.releaseDate ?? null,
      url: attr.url ?? null,
      artworkUrl: attr.artwork?.url
        ? attr.artwork.url.replace('{w}', '100').replace('{h}', '100')
        : null,
      appleId: t.id ?? null,
      isBlackpink: isBlackpink(artistName),
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Apple Music Global Top 100 — BLACKPINK tracker ===');
  const today = new Date().toISOString().slice(0, 10);
  console.log(`  Run date: ${today}`);
  mkdirSync(DATA_DIR, { recursive: true });

  let token = null;
  let rawTracks = null;

  // Step 1: try cached token
  if (existsSync(TOKEN_CACHE)) {
    token = readFileSync(TOKEN_CACHE, 'utf8').trim();
    console.log(`  Trying cached token (${token.slice(0, 20)}…)`);
    rawTracks = await fetchTracks(token);
    if (!rawTracks) { console.log('  Cached token invalid, refreshing…'); token = null; }
  }

  // Step 2: plain HTTP token extraction
  if (!token) {
    token = await extractTokenFromHttp();
    if (token) rawTracks = await fetchTracks(token);
  }

  // Step 3: Playwright
  if (!token || !rawTracks) {
    const result = await extractTokenViaBrowser();
    if (result.token) token = result.token;
    if (result.tracks) rawTracks = result.tracks;
  }

  if (!rawTracks || rawTracks.length === 0) {
    console.error('  ERROR: Could not retrieve Global 100 tracks after all methods');
    process.exit(1);
  }

  // Save new token
  if (token) writeFileSync(TOKEN_CACHE, token);

  const tracks = parseTracks(rawTracks);
  const bpHits = tracks.filter(t => t.isBlackpink);

  console.log(`\n  Total tracks: ${tracks.length}`);
  if (bpHits.length > 0) {
    console.log('\n=== BLACKPINK entries in Global Top 100 ===');
    for (const h of bpHits) {
      console.log(`  #${String(h.position).padStart(3)} ${h.member} — "${h.name}" (${h.artists})`);
    }
  } else {
    console.log('  No BLACKPINK/member entries in Global Top 100 today.');
  }

  const output = {
    generatedAt: new Date().toISOString(),
    date: today,
    totalTracks: tracks.length,
    tracks,
    bpHits,
    summary: { bpHitCount: bpHits.length },
  };

  writeFileSync(join(DATA_DIR, `apple-global-chart-${today}.json`), JSON.stringify(output, null, 2));
  writeFileSync(join(DATA_DIR, 'apple-global-chart-latest.json'), JSON.stringify(output, null, 2));
  console.log('\n  Saved apple-global-chart-latest.json');
  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
