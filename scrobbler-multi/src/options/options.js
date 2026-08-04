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

// ---------- settings ----------

async function loadSettings(settings) {
  $('#lastfm-key').value = settings.lastfm.apiKey || '';
  $('#lastfm-secret').value = settings.lastfm.secret || '';
  $('#librefm-key').value = settings.librefm.apiKey || '';
  $('#librefm-secret').value = settings.librefm.secret || '';
}

$('#save-settings').addEventListener('click', async () => {
  const settings = {
    lastfm: { apiKey: $('#lastfm-key').value.trim(), secret: $('#lastfm-secret').value.trim() },
    librefm: { apiKey: $('#librefm-key').value.trim(), secret: $('#librefm-secret').value.trim() },
  };
  const res = await send({ type: 'saveSettings', settings });
  toast(res && res.ok ? 'Credentials saved.' : 'Save failed.', !(res && res.ok));
});

// ---------- profiles ----------

const SVC_NAMES = { lastfm: 'Last.fm', librefm: 'Libre.fm', listenbrainz: 'ListenBrainz' };

// Wire one service row. All three now authenticate with credentials typed into
// the row itself, so each profile connects its OWN account with no dependence
// on which account the browser happens to be logged into.
function wireService(node, profile, svc) {
  const svcEl = $(`.svc[data-svc="${svc}"]`, node);
  const state = $('.svc-state', svcEl);
  const cred = $('.cred', svcEl);
  const disconnectBtn = $('.c-disconnect', svcEl);
  const conn = profile[svc];
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
    await send({ type: 'disconnect', profileId: profile.id, service: svc });
    refresh();
  });

  const connectBtn = $('.c-connect', svcEl);
  connectBtn.addEventListener('click', async () => {
    let msg;
    if (svc === 'listenbrainz') {
      const token = $('.c-token', svcEl).value.trim();
      if (!token) return;
      msg = { type: 'saveListenBrainz', profileId: profile.id, token };
    } else {
      const username = $('.c-user', svcEl).value.trim();
      const password = $('.c-pass', svcEl).value;
      if (!username || !password) return;
      msg = { type: 'connectPassword', service: svc, profileId: profile.id, username, password };
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

  for (const svc of ['lastfm', 'librefm', 'listenbrainz']) wireService(node, profile, svc);

  return node;
}

async function refresh() {
  const { settings, profiles } = await send({ type: 'getState' });
  loadSettings(settings);
  const list = $('#profiles');
  list.innerHTML = '';
  const entries = Object.values(profiles);
  $('#empty').classList.toggle('hidden', entries.length > 0);
  for (const p of entries) list.appendChild(renderProfile(p));
}

$('#refresh').addEventListener('click', refresh);
refresh();
