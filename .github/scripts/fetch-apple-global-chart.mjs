/**
 * fetch-apple-global-chart.mjs
 *
 * Fetches the Apple Music Global Top 100 playlist by:
 *   1. First trying a direct API call using a cached developer token
 *   2. If that fails (token expired), launching headless Chromium to intercept
 *      the actual API request Apple's web player makes, extract the token,
 *      then call the API directly and cache the new token.
 *
 * Saves:
 *   data/apple-global-chart-latest.json
 *   data/apple-global-chart-YYYY-MM-DD.json
 *   .apple-token-cache (bearer token, refreshed as needed)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');
const TOKEN_CACHE = join(REPO_ROOT, '.apple-token-cache');

const PLAYLIST_ID = 'pl.d25f5d1181894928af76c85c967f8f31';
const PLAYLIST_URL = `https://music.apple.com/us/playlist/top-100-global/${PLAYLIST_ID}`;
const API_BASE = 'https://api.music.apple.com/v1';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ARTIST_PATTERNS = [
  /\bblackpink\b/i,
  /\blisa\b/i,
  /\blalisa\b/i,
  /\bjennie\b/i,
  /ros[eé]/i,
  /\bjisoo\b/i,
  /블랙핑크/,
  /리사/,
  /제니/,
  /로제/,
  /지수/,
];

function isBlackpink(artist = '') {
  return ARTIST_PATTERNS.some(p => p.test(artist));
}

function identifyMember(artist = '') {
  if (/\bblackpink\b/i.test(artist) || /블랙핑크/.test(artist)) return 'BLACKPINK';
  if (/\blisa\b/i.test(artist) || /\blalisa\b/i.test(artist) || /리사/.test(artist)) return 'LISA';
  if (/\bjennie\b/i.test(artist) || /제니/.test(artist)) return 'JENNIE';
  if (/ros[eé]/i.test(artist) || /로제/.test(artist)) return 'ROSÉ';
  if (/\bjisoo\b/i.test(artist) || /지수/.test(artist)) return 'JISOO';
  return 'BLACKPINK';
}

async function callApi(token, path) {
  const url = `${API_BASE}${path}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://music.apple.com',
      'Referer': 'https://music.apple.com/',
      'User-Agent': UA,
    },
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function fetchWithToken(token) {
  console.log('  Trying direct API call…');
  // Fetch playlist, then its tracks (relationships)
  const data = await callApi(token,
    `/catalog/us/playlists/${PLAYLIST_ID}?include=tracks&limit=100`);
  if (!data) return null;

  const tracks = data?.data?.[0]?.relationships?.tracks?.data ?? [];
  if (tracks.length === 0) {
    // Try without limit param
    const data2 = await callApi(token, `/catalog/us/playlists/${PLAYLIST_ID}?include=tracks`);
    const tracks2 = data2?.data?.[0]?.relationships?.tracks?.data ?? [];
    if (tracks2.length === 0) return null;
    return tracks2;
  }
  return tracks;
}

async function extractTokenViaBrowser() {
  console.log('  Launching Chromium to extract Apple Music bearer token…');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  const page = await context.newPage();

  let capturedToken = null;
  let capturedTracks = null;

  // Intercept outgoing requests to grab the Authorization header
  page.on('request', request => {
    const url = request.url();
    if (!url.includes('api.music.apple.com')) return;
    const auth = request.headers()['authorization'];
    if (auth?.startsWith('Bearer ') && !capturedToken) {
      capturedToken = auth.slice(7);
      console.log(`  ✓ Captured bearer token (${capturedToken.slice(0, 20)}…)`);
    }
  });

  // Intercept responses to grab playlist data directly
  page.on('response', async response => {
    const url = response.url();
    if (!url.includes('api.music.apple.com') || !url.includes('playlists')) return;
    try {
      const json = await response.json();
      const tracks = json?.data?.[0]?.relationships?.tracks?.data ?? [];
      if (tracks.length > 0 && !capturedTracks) {
        capturedTracks = tracks;
        console.log(`  ✓ Captured ${tracks.length} tracks from intercepted response`);
      }
    } catch (_) {}
  });

  try {
    await page.goto(PLAYLIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log(`  Navigation: ${e.message}`);
  }
  await page.waitForTimeout(5000);

  // If we got tracks via intercept but not yet via direct call, use them
  if (!capturedTracks && capturedToken) {
    console.log('  Trying API with captured token…');
    capturedTracks = await fetchWithToken(capturedToken);
  }

  // Last resort: scrape from DOM
  if (!capturedTracks) {
    console.log('  Falling back to DOM scrape…');
    capturedTracks = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(
        '[data-testid="tracklist-row"], .songs-list-row, li.row'
      ));
      return rows.map((row, i) => {
        const title = row.querySelector('[data-testid="track-title"], .songs-list__col--song-name, .title')?.textContent?.trim();
        const artist = row.querySelector('[data-testid="track-artist"], .songs-list__col--artist, .artist')?.textContent?.trim();
        return title ? { _domScrape: true, position: i + 1, title, artist } : null;
      }).filter(Boolean);
    });
  }

  await browser.close();
  return { token: capturedToken, tracks: capturedTracks };
}

function parseTracks(tracks) {
  return tracks.map((t, i) => {
    // API response shape
    if (t.attributes) {
      const attr = t.attributes;
      const artistName = attr.artistName ?? '';
      return {
        position: i + 1,
        name: attr.name ?? '',
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
    }
    // DOM scrape shape
    return {
      position: t.position,
      name: t.title ?? '',
      artists: t.artist ?? '',
      member: isBlackpink(t.artist ?? '') ? identifyMember(t.artist ?? '') : null,
      releaseDate: null,
      url: null,
      artworkUrl: null,
      appleId: null,
      isBlackpink: isBlackpink(t.artist ?? ''),
    };
  });
}

async function main() {
  console.log('=== Apple Music Global Top 100 — BLACKPINK tracker ===');
  const today = new Date().toISOString().slice(0, 10);
  console.log(`  Run date: ${today}`);
  mkdirSync(DATA_DIR, { recursive: true });

  // Try cached token first
  let token = null;
  let rawTracks = null;

  if (existsSync(TOKEN_CACHE)) {
    token = readFileSync(TOKEN_CACHE, 'utf8').trim();
    console.log(`  Loaded cached token (${token.slice(0, 20)}…)`);
    rawTracks = await fetchWithToken(token);
    if (!rawTracks) {
      console.log('  Cached token expired or API error — refreshing via browser');
      token = null;
    }
  }

  if (!rawTracks) {
    const result = await extractTokenViaBrowser();
    token = result.token;
    rawTracks = result.tracks;
    if (token) {
      writeFileSync(TOKEN_CACHE, token);
      console.log('  Saved new token to cache');
    }
  }

  if (!rawTracks || rawTracks.length === 0) {
    console.error('  ERROR: Could not retrieve Global 100 tracks');
    process.exit(1);
  }

  const tracks = parseTracks(rawTracks);
  const bpHits = tracks.filter(t => t.isBlackpink);

  console.log(`\n  Total tracks: ${tracks.length}`);
  console.log(`  BLACKPINK hits: ${bpHits.length}`);
  if (bpHits.length > 0) {
    console.log('\n=== BLACKPINK entries in Global Top 100 ===');
    for (const h of bpHits) {
      console.log(`  #${h.position.toString().padStart(3)} ${h.member} — "${h.name}" (${h.artists})`);
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

  const dated = join(DATA_DIR, `apple-global-chart-${today}.json`);
  const latest = join(DATA_DIR, 'apple-global-chart-latest.json');
  writeFileSync(dated, JSON.stringify(output, null, 2));
  writeFileSync(latest, JSON.stringify(output, null, 2));

  console.log(`\n  Saved: ${dated}`);
  console.log(`  Saved: ${latest}`);
  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
