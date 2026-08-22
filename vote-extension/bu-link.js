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

  // Diagnostic (link page only): a visible marker proves the content script actually
  // injected in this browser. If you see it, injection works and any remaining problem
  // is the handshake; if you never see it, this browser isn't injecting content scripts.
  if (location.pathname.indexOf('vote-link') !== -1) {
    function badge() {
      try {
        if (document.getElementById('bu-cs-badge')) return;
        var d = document.createElement('div');
        d.id = 'bu-cs-badge';
        d.textContent = '🩷 vote-counter script active (v1.1.0)';
        d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#ff2e77;'
          + 'color:#12000a;font:12px/1.3 -apple-system,sans-serif;padding:6px 10px;border-radius:8px;'
          + 'box-shadow:0 4px 14px #0008;';
        (document.body || document.documentElement).appendChild(d);
      } catch (_) {}
    }
    if (document.body) badge(); else document.addEventListener('DOMContentLoaded', badge);
  }
})();
