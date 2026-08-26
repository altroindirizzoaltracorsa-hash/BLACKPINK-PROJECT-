// Injected into blinksunited.com inside the app's WebView. Port of the extension's
// bu-link.js: announces itself so extension-link.html hands over the account link
// token via postMessage, then passes that token to the native app (BUAndroid.setToken)
// and acks so the page shows "Linked". The user links once, by signing in.
(function () {
  if (window.__buLinkHooked) return;
  window.__buLinkHooked = true;

  function announce() {
    try { window.postMessage({ source: 'bu-ext-link-ready' }, '*'); } catch (e) {}
  }
  announce();
  document.addEventListener('DOMContentLoaded', announce);
  window.addEventListener('load', announce);
  var n = 0;
  var iv = setInterval(function () { announce(); if (++n > 12) clearInterval(iv); }, 500);

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;
    if (e.data.source === 'bu-ext-link' && e.data.token) {
      try {
        if (window.BUAndroid && BUAndroid.setToken) BUAndroid.setToken(e.data.token, e.data.profile || '');
      } catch (err) {}
      try { window.postMessage({ source: 'bu-ext-link-ack', ok: true }, '*'); } catch (err) {}
    }
  });
})();
