function render() {
  chrome.storage.local.get(['buToken', 'buProfile', 'buCount', 'buPending'], function (r) {
    const s = document.getElementById('status');
    if (r.buToken) {
      s.innerHTML = '<span class="status-ok">● Linked</span> '
        + (r.buProfile ? '<span class="muted">as ' + escapeHtml(r.buProfile) + '</span>' : '');
    } else {
      s.innerHTML = '<span class="status-no">● Not linked</span> <span class="muted">— link to log votes</span>';
    }
    document.getElementById('count').textContent = r.buCount || 0;
    const pend = r.buPending || 0;
    document.getElementById('pending').textContent = pend
      ? (pend + ' vote(s) waiting — link your account to send them.') : '';
  });
}

function escapeHtml(x) {
  return String(x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
  });
}

document.getElementById('link').onclick = function () {
  chrome.tabs.create({ url: 'https://blinksunited.com/vote-link.html' });
};
document.getElementById('reset').onclick = function () {
  chrome.storage.local.set({ buCount: 0, buPending: 0 }, render);
};

render();
