/*
 * Runs in the page's MAIN world (same JS realm as Spotify's web player) so it
 * can read `navigator.mediaSession` and make same-origin requests with THIS
 * tab's cookies. Under SessionBox that means this tab's isolated Spotify login.
 *
 * It cannot use chrome.* APIs, so it hands data to the isolated content script
 * via window.postMessage.
 */
(() => {
  let account = null;          // { id, name }
  let accountFetchedAt = 0;
  let lastPayload = '';

  // --- which Spotify account is this tab logged into? ---

  async function fetchAccount() {
    // Preferred: get a web-player access token, then ask the API who we are.
    // This yields a UNIQUE Spotify user id, which is what keeps two accounts
    // from being merged into one profile.
    const token = await getAccessToken();
    if (token) {
      try {
        const me = await fetch('https://api.spotify.com/v1/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (me.ok) {
          const u = await me.json();
          if (u && u.id) return { id: u.id, name: u.display_name || u.id };
        }
      } catch (_) { /* fall through to DOM */ }
    }

    // Last resort: the account widget in the top bar. This is often just the
    // avatar initial, so ids built from it are marked with a "name:" prefix and
    // can collide — connect at least one service to force a real-id lookup.
    const sel = [
      '[data-testid="user-widget-name"]',
      '[data-testid="user-widget-link"]',
      'button[data-testid="user-widget-link"] img[alt]',
      'img[data-testid="user-widget-avatar"][alt]',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      const name = el && (el.textContent || el.getAttribute('alt'));
      if (name && name.trim()) {
        const clean = name.trim();
        return { id: `name:${clean.toLowerCase()}`, name: clean };
      }
    }
    return null;
  }

  // Resolve a web-player access token via several routes, since Spotify has
  // changed how it exposes this over time.
  async function getAccessToken() {
    // 1. The transport token endpoint (older but often still present).
    try {
      const r = await fetch(
        'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
        { credentials: 'include' },
      );
      if (r.ok) {
        const j = await r.json();
        if (j.accessToken && !j.isAnonymous) return j.accessToken;
      }
    } catch (_) { /* try next */ }

    // 2. A token embedded in the page's bootstrap script tags.
    for (const id of ['session', 'config']) {
      const el = document.getElementById(id);
      if (el && el.textContent) {
        try {
          const j = JSON.parse(el.textContent);
          if (j.accessToken) return j.accessToken;
        } catch (_) { /* not JSON */ }
      }
    }

    // 3. Scan any inline script for an accessToken field.
    for (const s of document.querySelectorAll('script')) {
      const m = (s.textContent || '').match(/"accessToken"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  async function refreshAccount() {
    const age = Date.now() - accountFetchedAt;
    if (account && age < 60000) return;
    accountFetchedAt = Date.now();
    const a = await fetchAccount();
    if (a) account = a;
  }

  // --- what's playing? ---

  function parseDuration() {
    const el = document.querySelector('[data-testid="playback-duration"]');
    if (!el) return 0;
    const parts = el.textContent.trim().split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  function readTrack() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    if (!md || !md.title) return null;
    return {
      title: md.title,
      artist: md.artist || '',
      album: md.album || '',
      duration: parseDuration(),
    };
  }

  function isPlaying() {
    const st = navigator.mediaSession && navigator.mediaSession.playbackState;
    if (st) return st === 'playing';
    // Fallback to the play/pause control's label.
    const btn = document.querySelector('[data-testid="control-button-playpause"]');
    return btn ? /pause/i.test(btn.getAttribute('aria-label') || '') : false;
  }

  function tick() {
    refreshAccount();
    const track = readTrack();
    const playing = track ? isPlaying() : false;
    const payload = { account, playing, track };

    // Post every tick while playing (so the worker can accumulate play time),
    // and whenever the track/state/account changes.
    const sig = JSON.stringify({
      a: account && account.id,
      t: track && `${track.artist}|${track.title}`,
      p: playing,
    });
    if (playing || sig !== lastPayload) {
      lastPayload = sig;
      window.postMessage({ __sbscrob: true, payload }, '*');
    }
  }

  setInterval(tick, 3000);
  tick();
})();
