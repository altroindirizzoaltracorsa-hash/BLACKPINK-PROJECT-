// Isolated content script on vote.mtv.com. Relays vote events from the MAIN-world
// interceptor (which can't use chrome.* APIs) to the background service worker.
window.addEventListener('message', function (e) {
  if (e.source !== window || !e.data || e.data.__buVote !== true) return;
  try { chrome.runtime.sendMessage({ type: 'bu-vote', detail: e.data.detail }); } catch (_) {}
});
