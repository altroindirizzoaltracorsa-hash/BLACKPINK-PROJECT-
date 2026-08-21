// Runs in the PAGE (MAIN) world on vote.mtv.com, at document_start.
// The VMA site submits each vote as an XHR/fetch POST to
//   https://vote.mtv.com/api/prod/vote/s2/vote?...&category=cat06&total=10&C1=10
//   https://vote.mtv.com/api/prod/vote/s2/vote?...&category=cat11&total=10&A1=10
// The nominee-slot key is NOT fixed — it varies per category (Best Pop uses C1,
// Best K-pop uses A1, …), so we capture ANY <letter><number> param as a slot and
// let background.js decide which slots are BLACKPINK/a member (see BP_SLOTS).
// We wrap fetch + XMLHttpRequest so we can read those params on a *successful*
// submission and hand them to the isolated bridge (vote-bridge.js) via postMessage.
// We never modify or send any request — only observe the ones the user makes.
(function () {
  const VOTE_RE = /\/api\/prod\/vote\/s2\/vote/i;
  // Reserved query params that are never nominee slots.
  const RESERVED = new Set(['apikey', 'timestamp', 'action_type', 'user_id', 'method', 'category', 'total']);

  function parseVote(url) {
    try {
      const u = new URL(url, location.href);
      if (!VOTE_RE.test(u.pathname)) return null;
      const p = u.searchParams;
      if ((p.get('action_type') || '') !== 'vote') return null;
      const slots = {};
      for (const [k, v] of p.entries()) {
        // A nominee slot is a single letter + digits (A1, B2, C1, …), not a reserved key.
        if (!RESERVED.has(k.toLowerCase()) && /^[A-Z]\d+$/i.test(k)) {
          slots[k.toUpperCase()] = parseInt(v, 10) || 0;
        }
      }
      return {
        category: p.get('category') || null,
        slots,
        total: parseInt(p.get('total'), 10) || 0,
        timestamp: p.get('timestamp') || null,
      };
    } catch (_) { return null; }
  }

  function emit(detail) {
    try { window.postMessage({ __buVote: true, detail }, '*'); } catch (_) {}
  }

  // ── fetch ──
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url = null;
      try { url = typeof input === 'string' ? input : (input && input.url); } catch (_) {}
      const vote = url ? parseVote(url) : null;
      const p = origFetch.apply(this, arguments);
      if (vote && p && typeof p.then === 'function') {
        p.then(function (res) { if (res && res.ok) emit(vote); }).catch(function () {});
      }
      return p;
    };
  }

  // ── XMLHttpRequest ──
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__buUrl = url; } catch (_) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      const vote = this.__buUrl ? parseVote(this.__buUrl) : null;
      if (vote) {
        this.addEventListener('load', function () {
          if (this.status >= 200 && this.status < 300) emit(vote);
        });
      }
    } catch (_) {}
    return origSend.apply(this, arguments);
  };
})();
