// 2026 VMA power schedule (US Eastern) — mirrors the site & panel.
var VMA_POWER = { hourStart: 13, hourEnd: 14, hourFrom: '2026-08-20', hourTo: '2026-09-24',
  doubleDays: ['2026-08-18', '2026-08-19', '2026-09-25'] };
function vmaPowerLabel() {
  var p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(new Date()).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  var date = p.year + '-' + p.month + '-' + p.day, hour = parseInt(p.hour, 10) % 24;
  if (VMA_POWER.doubleDays.indexOf(date) !== -1) return 'Double day';
  if (date >= VMA_POWER.hourFrom && date <= VMA_POWER.hourTo && hour >= VMA_POWER.hourStart && hour < VMA_POWER.hourEnd) return 'Power hour';
  return '';
}

function render() {
  var plabel = vmaPowerLabel();
  document.body.classList.toggle('power', !!plabel);
  if (plabel) { var pb = document.querySelector('.powerband'); if (pb) pb.textContent = '⚡ ' + plabel + ' — 2× votes now'; }
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
