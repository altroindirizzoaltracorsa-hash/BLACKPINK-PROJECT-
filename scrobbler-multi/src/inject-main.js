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
    // Preferred: grab the web player access token, then ask the API who we are.
    try {
      const r = await fetch(
        'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
        { credentials: 'include' },
      );
      if (r.ok) {
        const { accessToken, isAnonymous } = await r.json();
        if (accessToken && !isAnonymous) {
          const me = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (me.ok) {
            const u = await me.json();
            if (u && u.id) return { id: u.id, name: u.display_name || u.id };
          }
        }
      }
    } catch (_) { /* fall through to DOM */ }

    // Fallback: read the display name off the account widget in the top bar.
    const sel = [
      '[data-testid="user-widget-name"]',
      '[data-testid="user-widget-link"]',
      'button[data-testid="user-widget-link"] img[alt]',
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
