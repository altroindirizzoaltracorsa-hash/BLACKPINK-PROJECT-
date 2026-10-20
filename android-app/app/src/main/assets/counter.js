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
//   Kids' Choice (kca.nick.tv)
//     A POST whose body names NOBODY: {"votes":[{question_id, option_id}]}, both
//     opaque UUIDs. The map from an option_id to a nominee's name lives in the
//     ballot the page already loaded. So this half resolves the ids here, in the
//     page, and hands over picks that mean something:
//       BUAndroid.recordKcaVote(json)  →  KcaVoteParser
//
// Resolving in-page is the one thing the app can do more simply than the
// extension. There, panel.js runs in an isolated world where window.jsonData is
// out of reach, so it has to find the ballot among the page's <script src> list
// and re-fetch ~325KB to read it. Injected into the WebView we ARE the page: the
// global is simply there, with the fetch kept only as a fallback.
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
  var IS_KCA = /(^|\.)kca\.nick\.tv$/i.test(HOST);
  if (!IS_MTV && !IS_BT && !IS_KCA) return;

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


  // ── Kids' Choice ───────────────────────────────────────────────────────────
  // What makes a request a vote is a readable votes array, not the path; the path
  // is checked only to keep this out of the page's other POSTs. (BreakTudo moved
  // its endpoint once and the counter silently went to zero.)
  function isKcaVote(u) {
    try { return /\/api\/vote\b/i.test(new URL(String(u), location.href).pathname); }
    catch (e) { return /\/api\/vote\b/i.test(String(u)); }
  }

  // option_id -> { t: nominee title, s: category slug }. Built once per page.
  var kcaBallot = null;

  function kcaBuild(data) {
    if (!data || !data.questions || !data.questions.length) return null;
    var by = {}, n = 0;
    for (var i = 0; i < data.questions.length; i++) {
      var q = data.questions[i];
      if (!q || !q.id || !q.options || !q.options.length) continue;
      for (var j = 0; j < q.options.length; j++) {
        var o = q.options[j];
        if (!o || !o.id) continue;
        by[String(o.id)] = { t: String(o.title == null ? '' : o.title), s: String(q.slug || '') };
        n++;
      }
    }
    return n ? by : null;
  }

  function kcaGetBallot() {
    if (kcaBallot) return kcaBallot;
    // The page's own global, which in the WebView we can simply read.
    try { kcaBallot = kcaBuild(window.jsonData); } catch (e) {}
    return kcaBallot;
  }

  // Fallback for the day the page stops assigning the global: find the ballot
  // among the same-origin scripts by what it CONTAINS, since its URL carries a
  // UUID that changes. force-cache, so this re-reads the browser's copy of a file
  // the page has already downloaded rather than fetching it again.
  function kcaFindBallot() {
    if (kcaGetBallot()) return;
    var urls = [];
    try {
      var tags = document.querySelectorAll('script[src]');
      for (var i = 0; i < tags.length; i++) {
        var u = tags[i].src;
        if (u && u.indexOf(location.origin) === 0 && !/\/mik-assets\/vite\/assets\//.test(u)) urls.push(u);
      }
    } catch (e) { return; }
    var at = 0;
    function next() {
      if (kcaBallot || at >= urls.length) return;
      var u = urls[at++];
      fetch(u, { cache: 'force-cache' }).then(function (r) { return r.text(); }).then(function (text) {
        if (kcaBallot) return;
        if (text.indexOf('"questions"') === -1) return next();
        var m = /window\.jsonData\s*=\s*/.exec(text);
        if (!m) return next();
        var start = text.indexOf('{', m.index + m[0].length - 1);
        if (start < 0) return next();
        // Walk to the matching brace, tracking string state — a regex cannot, and
        // nominee titles are quote-heavy.
        var depth = 0, inStr = false, esc = false, end = -1;
        for (var k = start; k < text.length; k++) {
          var c = text.charAt(k);
          if (inStr) {
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') { inStr = true; continue; }
          if (c === '{') depth++;
          else if (c === '}') { depth--; if (!depth) { end = k + 1; break; } }
        }
        if (end < 0) return next();
        var data = null;
        try { data = JSON.parse(text.slice(start, end)); } catch (e) { return next(); }
        kcaBallot = kcaBuild(data);
        if (!kcaBallot) next();
      }).catch(function () { next(); });
    }
    next();
  }

  function kcaParseBody(body) {
    var text = null;
    try {
      if (body == null) return null;
      if (typeof body === 'string') text = body;
      else if (typeof body.votes !== 'undefined') return body;
      else return null;
    } catch (e) { return null; }
    try {
      var j = JSON.parse(text);
      return (j && j.votes && j.votes.length) ? j : null;
    } catch (e) { return null; }
  }

  function reportKca(body) {
    var j = kcaParseBody(body);
    if (!j || !j.votes || !j.votes.length) return;
    var by = kcaGetBallot();
    var picks = [], sig = [];
    for (var i = 0; i < j.votes.length; i++) {
      var v = j.votes[i];
      if (!v || !v.option_id) continue;
      var id = String(v.option_id);
      sig.push(String(v.question_id || '') + ':' + id);
      // Without the ballot an option_id means nothing, and the honest count is
      // zero: guessing which of six entries was BLACKPINK would invent votes.
      // The signature still goes over so the native side can say so.
      var hit = by ? by[id] : null;
      if (hit) picks.push({ slug: hit.s, title: hit.t });
    }
    if (!sig.length) return;
    // `user_id` in the body is the voter's own Nickelodeon identity and is
    // deliberately NOT carried over.
    var payload;
    try { payload = JSON.stringify({ picks: picks, marks: sig.length, sig: sig.sort().join(','), ballot: !!by }); }
    catch (e) { return; }
    send('recordKcaVote', payload);
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
            else if (IS_KCA && isKcaVote(url) && body != null) reportKca(body);
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
        else if (IS_KCA && isKcaVote(xhr.__buUrl) && sent != null) reportKca(sent);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // Warm the ballot now rather than at the moment a vote lands: resolving ids is
  // what makes a pick countable, and the fallback path is a fetch.
  if (IS_KCA) { try { kcaFindBallot(); } catch (e) {} }
})();
