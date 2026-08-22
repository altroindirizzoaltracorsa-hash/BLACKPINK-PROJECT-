// Runs on blinksunited.com. Reuses the vote-link.html handshake to receive this
// account's link token and store it for the vote counter — user links once, by login.
(function () {
  // Announce repeatedly so the page hears us no matter the injection/listener order
  // (older engines like Kiwi can inject late).
  function announce() { try { window.postMessage({ source: 'bu-ext-link-ready' }, '*'); } catch (_) {} }
  announce();
  document.addEventListener('DOMContentLoaded', announce);
  window.addEventListener('load', announce);
  let n = 0;
  const iv = setInterval(() => { announce(); if (++n > 12) clearInterval(iv); }, 500);

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;
    if (e.data.source === 'bu-ext-link' && e.data.token) {
      chrome.storage.local.set(
        { buToken: e.data.token, buProfile: e.data.profile || null },
        function () { try { window.postMessage({ source: 'bu-ext-link-ack', ok: true }, '*'); } catch (_) {} }
      );
    }
  });
})();
