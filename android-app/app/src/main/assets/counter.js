// Injected into the vote sites inside the app's WebView, and the only place the app
// observes a vote. It hooks fetch + XMLHttpRequest and, on a SUCCESSFUL submission,
// hands what it saw to the native side (Bridge), which parses, filters and logs it.
// Count only — it never votes for you.
//
// Two awards, two shapes:
//
//   MTV VMAs (vote.mtv.com)
//     Everything is in the request URL's query string, so the URL alone is enough:
//       BUAndroid.recordVote(url)  →  VoteParser
//
//   BreakTudo (vote.breaktudoawards.com)
//     A POST whose BODY carries the marks, with the category coming from the page
//     URL. So the payload is what gets handed over:
//       BUAndroid.recordBtVote(json)  →  BtVoteParser
//
// The BreakTudo half is deliberately simpler than the extension's. The extension
// runs in the background and has to stitch one vote together across three
// webRequest events — body in onBeforeRequest, category from the Referer header in
// onSendHeaders, outcome in onCompleted — keyed by requestId, and that stitching is
// what MV3's service-worker teardown kept breaking. In the page we already have the
// body and location.pathname in hand at the call site, so there is nothing to stitch.
(function () {
  if (window.__buHooked) return;
  window.__buHooked = true;

  var HOST = '';
  try { HOST = String(location.hostname || ''); } catch (e) {}
  var IS_MTV = HOST.indexOf('vote.mtv.com') !== -1;
  var IS_BT  = HOST.indexOf('vote.breaktudoawards.com') !== -1;
  if (!IS_MTV && !IS_BT) return;

  function send(fn, arg) {
    try { if (window.BUAndroid && BUAndroid[fn]) BUAndroid[fn](String(arg)); } catch (e) {}
  }

  // ── MTV ────────────────────────────────────────────────────────────────────
  function isMtvVote(u) {
    try { return /\/api\/prod\/vote\/s2\/vote/i.test(String(u)); } catch (e) { return false; }
  }

  // ── BreakTudo ──────────────────────────────────────────────────────────────
  function isBtVote(u) {
    try { return /\/wp-json\/bta\/v1\/awards\/vote\/?$/i.test(new URL(String(u), location.href).pathname); }
    catch (e) { return /\/wp-json\/bta\/v1\/awards\/vote/i.test(String(u)); }
  }

  // The /vote/<slug>/ the marks were cast on. One submission is one category page.
  function btSlug() {
    try {
      var m = String(location.pathname).match(/\/vote\/([^/]+)\/?/i);
      return m ? m[1].toLowerCase() : null;
    } catch (e) { return null; }
  }

  // BreakTudo has shipped the vote body as BOTH form-urlencoded and JSON, and an
  // unreadable body is a vote counted as zero with nothing to show for it — so try
  // both rather than assuming, exactly as the extension's parseBtBody does.
  function btParseBody(body) {
    var text = null;
    try {
      if (body == null) return null;
      if (typeof body === 'string') text = body;
      else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) text = body.toString();
      else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        var o = {};
        body.forEach(function (v, k) { o[k] = String(v); });
        return { action: o.action || null, votes: o.votes || null, valid: o.valid || null };
      } else return null;
    } catch (e) { return null; }
    if (text == null) return null;

    var action = null, votes = null, valid = null;
    try {
      var p = new URLSearchParams(text);
      action = p.get('action'); votes = p.get('votes'); valid = p.get('valid');
    } catch (e) {}
    if (votes == null) {
      try {
        var j = JSON.parse(text);
        if (j && typeof j === 'object' && typeof j.votes !== 'undefined') {
          action = j.action != null ? String(j.action) : action;
          votes  = typeof j.votes === 'string' ? j.votes : JSON.stringify(j.votes);
          valid  = j.valid != null ? String(j.valid) : valid;
        }
      } catch (e) {}
    }
    if (votes == null) return null;
    return { action: action, votes: votes, valid: valid };
  }

  function reportBt(body) {
    var p = btParseBody(body);
    if (!p) return;
    var payload;
    try {
      payload = JSON.stringify({ slug: btSlug(), votes: p.votes, valid: p.valid, action: p.action });
    } catch (e) { return; }
    send('recordBtVote', payload);
  }

  // ── fetch() ────────────────────────────────────────────────────────────────
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      // Read the body BEFORE awaiting: a Request's body is a stream that the real
      // fetch consumes, so reading it after the fact gets nothing.
      var body = (init && init.body != null) ? init.body : null;
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          if (res && res.ok) {
            if (IS_MTV && isMtvVote(url)) send('recordVote', url);
            else if (IS_BT && isBtVote(url) && body != null) reportBt(body);
          }
        } catch (e) {}
        return res;
      });
    };
  }

  // ── XMLHttpRequest ─────────────────────────────────────────────────────────
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__buUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var sent = (body != null) ? body : null;
    this.addEventListener('load', function () {
      try {
        if (xhr.status < 200 || xhr.status >= 300) return;
        if (IS_MTV && isMtvVote(xhr.__buUrl)) send('recordVote', xhr.__buUrl);
        else if (IS_BT && isBtVote(xhr.__buUrl) && sent != null) reportBt(sent);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
