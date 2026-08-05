/*
 * Runs only on the blinksunited /extension-link page. After the user logs in
 * there, the page mints a profile token and posts it to the window; this relays
 * it to the extension and auto-configures the blinksunited target (token + the
 * site it was linked from), then acks so the page can show success.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || d.source !== 'bu-ext-link' || !d.token) return;

  chrome.runtime.sendMessage({
    type: 'saveBlinks',
    enabled: true,
    token: d.token,
    site: location.origin,
  }, (res) => {
    window.postMessage({
      source: 'bu-ext-link-ack',
      ok: !!(res && res.ok),
      profile: d.profile || null,
    }, '*');
  });
});

// Tell the page the extension is present (so it can show "Connecting…" instead
// of "install the extension first").
window.postMessage({ source: 'bu-ext-link-ready' }, '*');
