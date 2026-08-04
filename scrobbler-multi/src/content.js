/*
 * Isolated-world content script. It has no direct view of the page's
 * mediaSession, but it can talk to the background worker. Its only job is to
 * relay the payloads that inject-main.js (MAIN world) posts on the window.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__sbscrob !== true || !data.payload) return;
  chrome.runtime.sendMessage({ type: 'update', ...data.payload }).catch(() => {
    // Worker asleep or reloading; the next tick will retry.
  });
});
