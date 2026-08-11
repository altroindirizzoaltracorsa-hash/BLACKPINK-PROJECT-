// Runs at document_start in the page's MAIN world on open.spotify.com, BEFORE
// Spotify's player boots.
//
// In some isolated/partitioned contexts — Brave's storage partitioning combined
// with SessionBox's virtual sessions (VirtualSessionHelper) — localStorage is
// denied entirely: every setItem throws QuotaExceededError even at 0 bytes used.
// Spotify's web player writes playback/ad state to localStorage at each track
// transition, so when that write throws the player HANGS — most visibly it
// freezes on ads and never advances (Skipper then waits forever on an ad that
// can't finish).
//
// We can't grant real storage from here, but we CAN stop the throw: if storage
// is unusable, swap in an in-memory stand-in so the player's reads/writes succeed
// and it keeps moving through ads. Only activates when storage is actually broken
// — on healthy tabs it does nothing (and it can't make a frozen tab any worse).
(function () {
  function usable() {
    try {
      localStorage.setItem('__bu_probe__', '1');
      localStorage.removeItem('__bu_probe__');
      return true;
    } catch (e) {
      return false;
    }
  }

  if (usable()) {
    // Storage already works — nothing to fix. Log anyway so a reload always
    // shows a [bu-shim] line, confirming the shim is installed and ran.
    console.log('[bu-shim] active — localStorage healthy, nothing to do.');
    return;
  }

  // Merely FULL (has keys)? Clearing may restore the real store — prefer that,
  // since real (persistent) storage is better than an in-memory copy. Login is
  // cookie-based, so clearing localStorage does not sign the account out.
  try {
    if (localStorage.length > 0) {
      localStorage.clear();
      if (usable()) {
        console.log('[bu-shim] localStorage was full — cleared; real storage restored.');
        return;
      }
    }
  } catch (e) { /* fall through to the in-memory stand-in */ }

  // Storage is denied (0 bytes yet writes throw). Install an in-memory stand-in
  // so Spotify stops crashing on state writes and can get past ads.
  var mem = Object.create(null);
  var shim = {
    getItem: function (k) { k = String(k); return k in mem ? mem[k] : null; },
    setItem: function (k, v) { mem[String(k)] = String(v); },
    removeItem: function (k) { delete mem[String(k)]; },
    clear: function () { for (var k in mem) delete mem[k]; },
    key: function (i) { var ks = Object.keys(mem); return i >= 0 && i < ks.length ? ks[i] : null; },
    get length() { return Object.keys(mem).length; },
  };

  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: function () { return shim; },
    });
    console.log('[bu-shim] localStorage was blocked — installed in-memory stand-in so playback survives ads.');
  } catch (e) {
    console.warn('[bu-shim] could not install localStorage stand-in:', e && e.message);
  }
})();
