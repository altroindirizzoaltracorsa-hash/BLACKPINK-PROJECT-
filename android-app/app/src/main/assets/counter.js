// Injected into vote.mtv.com inside the app's WebView. Hooks fetch + XMLHttpRequest
// and, on a SUCCESSFUL vote submission, hands the request URL to the native app
// (BUAndroid.recordVote). The native side parses + filters it (VoteParser) and logs
// the BLACKPINK/LISA votes. Mirrors the extension's webRequest observer — count only,
// never auto-vote.
(function () {
  if (window.__buHooked) return;
  window.__buHooked = true;

  function isVote(u) {
    try { return /\/api\/prod\/vote\/s2\/vote/i.test(String(u)); } catch (e) { return false; }
  }
  function report(u) {
    try { if (window.BUAndroid && BUAndroid.recordVote) BUAndroid.recordVote(String(u)); } catch (e) {}
  }

  // fetch()
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      return origFetch.apply(this, arguments).then(function (res) {
        try { if (res && res.ok && isVote(url)) report(url); } catch (e) {}
        return res;
      });
    };
  }

  // XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__buUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    this.addEventListener('load', function () {
      try {
        if (xhr.status >= 200 && xhr.status < 300 && isVote(xhr.__buUrl)) report(xhr.__buUrl);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
