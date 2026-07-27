/**
 * fetch-apple-global-chart.mjs
 *
 * Fetches the Apple Music Global Top 100 playlist.
 *
 * Token extraction order:
 *   1. Cached token (.apple-token-cache) — call API directly, fast
 *   2. Plain HTTP fetch of music.apple.com — scan ALL scripts for JWT,
 *      also try MusicKit.js directly from Apple's CDN
 *   3. Playwright browser — block service workers + context.route() for
 *      network-level interception; also try JSON-LD from rendered DOM
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

// ── JWT detection ─────────────────────────────────────────────────────────────

// A JWT has three base64url-encoded segments separated by dots.
// Apple's developer tokens start with eyJ (base64 for '{"').
const JWT_RE = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;

function findJwt(text) {
  const m = text.match(JWT_RE);
  return m ? m[0] : null;
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
  console.log('  [Method 1] Scanning music.apple.com for embedded token…');
  try {
    const resp = await fetch(PLAYLIST_URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    });
    const html = await resp.text();
    console.log(`  HTML: ${html.length} chars — first 300: ${html.slice(0, 300).replace(/\n/g, ' ')}`);

    // Pattern A: meta tag config
    const metaM = html.match(/name="desktop-music-app\/config\/environment"\s+content="([^"]+)"/);
    if (metaM) {
      try {
        const cfg = JSON.parse(decodeURIComponent(metaM[1]));
        const t = cfg?.MEDIA_API?.token;
        if (t) { console.log('  ✓ Token from meta tag'); return t; }
      } catch (_) {}
    }

    // Pattern B: JWT directly in HTML
    const inlineJwt = findJwt(html);
    if (inlineJwt) { console.log('  ✓ Token inline in HTML'); return inlineJwt; }

    // Pattern C: scan ALL <script src="..."> — handle relative and absolute URLs
    const srcMatches = [...html.matchAll(/\bsrc="([^"]+)"/g)].map(m => m[1]);
    const jsSrcs = srcMatches.filter(u => u.includes('.js'));
    const absUrls = jsSrcs.map(u => {
      if (u.startsWith('http')) return u;
      if (u.startsWith('//')) return `https:${u}`;
      return `https://music.apple.com${u.startsWith('/') ? '' : '/'}${u}`;
    });
    console.log(`  ${srcMatches.length} src= attrs, ${jsSrcs.length} JS files to scan`);

    for (const url of absUrls.slice(0, 8)) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!r.ok) continue;
        const js = await r.text();
        const t = findJwt(js);
        if (t) { console.log(`  ✓ Token from JS bundle ${url.split('/').pop().slice(0, 40)}`); return t; }
      } catch (_) {}
    }

    // Pattern D: try Apple's MusicKit CDN directly (well-known source of the token)
    console.log('  Trying MusicKit CDN URLs…');
    const musicKitUrls = [
      'https://js-cdn.music.apple.com/musickit/v3/musickit.js',
      'https://js-cdn.music.apple.com/musickit/v1/musickit.js',
    ];
    for (const url of musicKitUrls) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!r.ok) { console.log(`  ${url} → HTTP ${r.status}`); continue; }
        const js = await r.text();
        const t = findJwt(js);
        if (t) { console.log(`  ✓ Token from MusicKit CDN`); return t; }
        console.log(`  MusicKit.js fetched (${js.length} chars) but no JWT found`);
      } catch (e) {
        console.log(`  MusicKit fetch error: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`  Method 1 error: ${e.message}`);
  }
  return null;
}

// ── Token extraction: Method 2 — Playwright with route interception ───────────

async function extractTokenViaBrowser() {
  console.log('  [Method 2] Playwright (service workers blocked, context.route intercept)…');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  // Block service workers so ALL requests go through channels Playwright can intercept.
  // Apple Music's web player uses SWs for caching/API calls; without this block,
  // the Bearer token never appears in network events we can observe.
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    serviceWorkers: 'block',
  });

  let capturedToken = null;
  let capturedData = null;

  // Network-level route intercept — fires for every request before it's sent.
  // Works regardless of service workers because SWs are blocked above.
  await context.route('**/api.music.apple.com/**', async route => {
    const req = route.request();
    const auth = req.headers()['authorization'] ?? '';
    if (auth.startsWith('Bearer ') && !capturedToken) {
      capturedToken = auth.slice(7);
      console.log(`  ✓ Token captured via route (${capturedToken.slice(0, 20)}…)`);
    }
    await route.continue();
  });

  const page = await context.newPage();

  // Also capture response bodies for playlist data
  page.on('response', async response => {
    const url = response.url();
    if (!url.includes('api.music.apple.com') || !url.includes('playlists')) return;
    try {
      const json = await response.json();
      const tracks = json?.data?.[0]?.relationships?.tracks?.data ?? [];
      if (tracks.length > 0) {
        capturedData = tracks;
        console.log(`  ✓ ${tracks.length} tracks captured from API response`);
      }
    } catch (_) {}
  });

  try {
    await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log(`  Navigation: ${e.message}`);
  }
  await page.waitForTimeout(8000);

  // Fallback: check if token is in page-level meta tag after JS hydration
  if (!capturedToken) {
    capturedToken = await page.evaluate(() => {
      try {
        const content = document.querySelector('meta[name="desktop-music-app/config/environment"]')?.content;
        if (content) return JSON.parse(decodeURIComponent(content))?.MEDIA_API?.token ?? null;
      } catch (_) {}
      return null;
    }).catch(() => null);
    if (capturedToken) console.log('  ✓ Token from page meta tag (post-hydration)');
  }

  // Fallback: extract from JSON-LD structured data in the rendered DOM
  if (!capturedData) {
    console.log('  Trying JSON-LD / structured data extraction from DOM…');
    capturedData = await page.evaluate(() => {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const d = JSON.parse(s.textContent ?? '');
          if (d['@type'] === 'MusicPlaylist' && Array.isArray(d.track) && d.track.length > 10) {
            return d.track.map((t, i) => ({
              id: String(i),
              attributes: {
                name: t.name ?? '',
                artistName: (t.byArtist?.name ?? t.byArtist ?? ''),
                url: t.url ?? null,
                artwork: null,
                releaseDate: null,
              },
            }));
          }
        } catch (_) {}
      }
      return null;
    }).catch(() => null);
    if (capturedData) console.log(`  ✓ ${capturedData.length} tracks from JSON-LD`);
  }

  if (!capturedData && capturedToken) {
    capturedData = await fetchTracks(capturedToken);
  }

  await browser.close();
  return { token: capturedToken, tracks: capturedData };
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
