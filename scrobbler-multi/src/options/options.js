const $ = (sel, root = document) => root.querySelector(sel);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

let toastTimer;
function toast(text, isErr = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('err', isErr);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

const SVC_NAMES = { lastfm: 'Last.fm', librefm: 'Libre.fm', listenbrainz: 'ListenBrainz' };
const DEFAULT_ACCT = '__default__';

// ---------- settings ----------

function loadSettings(settings) {
  $('#lastfm-key').value = settings.lastfm.apiKey || '';
  $('#lastfm-secret').value = settings.lastfm.secret || '';
  $('#librefm-key').value = settings.librefm.apiKey || '';
  $('#librefm-secret').value = settings.librefm.secret || '';

  const b = settings.blinks || {};
  $('#blinks-enabled').checked = !!b.enabled;
  $('#blinks-token').value = b.token || '';
  $('#blinks-site').value = b.site || '';
  const status = $('#blinks-status');
  const linked = !!(b.enabled && b.token);
  status.textContent = linked ? 'connected' : 'not connected';
  status.classList.toggle('on', linked);
}

$('#connect-blinks').addEventListener('click', () => {
  const site = ($('#blinks-site').value.trim() || 'https://blinksunited.com').replace(/\/$/, '');
  chrome.tabs.create({ url: `${site}/extension-link.html` });
  toast('Log in on the page that opened — it links automatically.');
});

$('#save-blinks').addEventListener('click', async () => {
  const res = await send({
    type: 'saveBlinks',
    enabled: $('#blinks-enabled').checked,
    token: $('#blinks-token').value.trim(),
    site: $('#blinks-site').value.trim(),
  });
  if (!res || !res.ok) { toast('Save failed.', true); return; }
  const c = res.check || {};
  if (c.valid === true) toast(`blinksunited connected${c.profile ? ` as ${c.profile}` : ''}.`);
  else if (c.valid === false) toast(c.error || 'Saved, but the token/site check failed.', true);
  else toast('Saved.');
  refresh();
});

// When the link page saves the token via the content script, reflect it live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refresh();
});

$('#save-settings').addEventListener('click', async () => {
  const settings = {
    lastfm: { apiKey: $('#lastfm-key').value.trim(), secret: $('#lastfm-secret').value.trim() },
    librefm: { apiKey: $('#librefm-key').value.trim(), secret: $('#librefm-secret').value.trim() },
  };
  const res = await send({ type: 'saveSettings', settings });
  toast(res && res.ok ? 'Credentials saved.' : 'Save failed.', !(res && res.ok));
});

// ---------- one service row ----------

// targetId is a profile id, or DEFAULT_ACCT for the shared default account.
// conn is the stored connection object for this service (or null).
function wireService(svcEl, targetId, conn, svc) {
  const state = $('.svc-state', svcEl);
  const cred = $('.cred', svcEl);
  const disconnectBtn = $('.c-disconnect', svcEl);
  const connectBtn = $('.c-connect', svcEl);
  const connected = !!(conn && (conn.sk || conn.token));

  if (connected) {
    const who = conn.name || conn.user;
    state.textContent = `connected${who ? ` as ${who}` : ''}`;
    state.classList.add('on');
    cred.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
  } else {
    state.textContent = 'not connected';
    state.classList.remove('on');
    cred.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
  }

  disconnectBtn.addEventListener('click', async () => {
    await send({ type: 'disconnect', profileId: targetId, service: svc });
    refresh();
  });

  connectBtn.addEventListener('click', async () => {
    let msg;
    if (svc === 'listenbrainz') {
      const token = $('.c-token', svcEl).value.trim();
      if (!token) return;
      msg = { type: 'saveListenBrainz', profileId: targetId, token };
    } else {
      const username = $('.c-user', svcEl).value.trim();
      const password = $('.c-pass', svcEl).value;
      if (!username || !password) return;
      msg = { type: 'connectPassword', service: svc, profileId: targetId, username, password };
    }
    connectBtn.disabled = true;
    const res = await send(msg);
    connectBtn.disabled = false;
    if (res && res.ok) {
      toast(`${SVC_NAMES[svc]} connected as ${res.name || res.user}.`);
      refresh();
    } else {
      toast(res && res.error ? res.error : 'Connect failed — check the credentials.', true);
    }
  });
}

function servicesNode(targetId, connSource) {
  const node = $('#services-tpl').content.firstElementChild.cloneNode(true);
  for (const svc of ['lastfm', 'librefm', 'listenbrainz']) {
    wireService($(`.svc[data-svc="${svc}"]`, node), targetId, connSource[svc], svc);
  }
  return node;
}

function renderProfile(profile) {
  const node = $('#profile-tpl').content.firstElementChild.cloneNode(true);

  const enabled = $('.p-enabled', node);
  enabled.checked = profile.enabled !== false;
  enabled.addEventListener('change', () =>
    send({ type: 'toggleProfile', profileId: profile.id, enabled: enabled.checked }));

  $('.p-label', node).textContent = profile.label || profile.id;

  $('.p-remove', node).addEventListener('click', async () => {
    await send({ type: 'removeProfile', profileId: profile.id });
    refresh();
  });

  $('.profile-services', node).appendChild(servicesNode(profile.id, profile));
  return node;
}

async function refresh() {
  const { settings, profiles } = await send({ type: 'getState' });
  loadSettings(settings);

  const def = $('#default-container');
  def.innerHTML = '';
  def.appendChild(servicesNode(DEFAULT_ACCT, settings.defaults || {}));

  const list = $('#profiles');
  list.innerHTML = '';
  const entries = Object.values(profiles);
  $('#empty').classList.toggle('hidden', entries.length > 0);
  for (const p of entries) list.appendChild(renderProfile(p));
}

// ---------- scrobble activity (live) ----------

function fmtTime(ms) {
  try { return new Date(ms).toLocaleTimeString(); } catch (e) { return ''; }
}

// Which account the activity panel is filtered to ('__all__' = every account).
let selectedAccount = '__all__';

async function renderStats() {
  const stats = await send({ type: 'getStats' }) || { total: 0, counts: {}, history: [] };
  const countsMap = stats.counts || {};
  const history = stats.history || [];
  $('#stat-total').textContent = stats.total || 0;

  // If the selected account disappeared (e.g. stats cleared), fall back to All.
  if (selectedAccount !== '__all__' && !countsMap[selectedAccount]) selectedAccount = '__all__';

  const entries = Object.entries(countsMap).sort((a, b) => b[1].count - a[1].count);

  // ---- account chips act as filters ----
  const counts = $('#stat-counts');
  counts.innerHTML = '';
  const mkChip = (id, label, count) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'stat-chip' + (selectedAccount === id ? ' sel' : '');
    chip.innerHTML = `<span>${escapeHtml(label)}</span><b>${count}</b>`;
    chip.addEventListener('click', () => { selectedAccount = id; renderStats(); });
    counts.appendChild(chip);
  };
  mkChip('__all__', 'All', stats.total || 0);
  for (const [id, c] of entries) mkChip(id, c.label, c.count);

  // ---- per-track breakdown for the current selection ----
  const bd = $('#stat-breakdown');
  bd.innerHTML = '';
  const relevant = selectedAccount === '__all__'
    ? entries.map((e) => e[1])
    : [countsMap[selectedAccount]].filter(Boolean);
  const trackTotals = {};
  for (const c of relevant) {
    for (const [key, tr] of Object.entries(c.tracks || {})) {
      const cur = trackTotals[key] || { title: tr.title, artist: tr.artist, count: 0 };
      cur.count += tr.count;
      trackTotals[key] = cur;
    }
  }
  const trackEntries = Object.values(trackTotals).sort((a, b) => b.count - a.count);
  if (trackEntries.length) {
    const head = document.createElement('div');
    head.className = 'bd-head';
    head.textContent = selectedAccount === '__all__'
      ? 'Per track — all accounts'
      : `Per track — ${countsMap[selectedAccount].label}`;
    bd.appendChild(head);
    for (const tr of trackEntries) {
      const row = document.createElement('div');
      row.className = 'bd-row';
      row.innerHTML = `<span class="bd-title">${escapeHtml(tr.title)} • ${escapeHtml(tr.artist)}</span>`
        + `<b>${tr.count}</b>`;
      bd.appendChild(row);
    }
  }

  // ---- chronological history, filtered to the selection ----
  const hist = $('#stat-history');
  hist.innerHTML = '';
  const shown = selectedAccount === '__all__'
    ? history
    : history.filter((h) => h.accountId === selectedAccount);
  $('#stat-empty').classList.toggle('hidden', shown.length > 0);
  for (const h of shown) {
    const el = document.createElement('div');
    el.className = 'hist';
    const at = h.played != null ? ` at ${h.played}s` : '';
    const to = h.pct != null ? ` to ${h.pct}%` : '';
    el.innerHTML = `<div class="hist-line1"><span class="hist-n">[${h.n}]</span> `
      + `<span class="hist-verb">Scrobbled</span>${at}${to}</div>`
      + `<div class="hist-track">${escapeHtml(h.title)} • ${escapeHtml(h.artist)}</div>`
      + `<div class="hist-meta">${escapeHtml(h.account)} · ${fmtTime(h.t)}</div>`;
    hist.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('#clear-stats').addEventListener('click', async () => {
  await send({ type: 'clearStats' });
  renderStats();
});

$('#refresh').addEventListener('click', refresh);
refresh();
renderStats();
// Keep the activity panel live while the popup is open.
setInterval(renderStats, 3000);
