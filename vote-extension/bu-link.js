// Runs on blinksunited.com. Reuses the existing /extension-link.html handshake
// (same one the Multi-Account Scrobbler uses) to receive this account's link token
// and store it for the vote counter — so the user links once, by login, with no
// hand-copied token.
try { window.postMessage({ source: 'bu-ext-link-ready' }, '*'); } catch (_) {}

window.addEventListener('message', function (e) {
  if (e.source !== window || !e.data) return;
  if (e.data.source === 'bu-ext-link' && e.data.token) {
    chrome.storage.local.set(
      { buToken: e.data.token, buProfile: e.data.profile || null },
      function () { try { window.postMessage({ source: 'bu-ext-link-ack', ok: true }, '*'); } catch (_) {} }
    );
  }
});
