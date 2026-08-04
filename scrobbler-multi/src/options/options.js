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

function renderServiceButton(svcEl, profile, svc) {
  const state = $('.svc-state', svcEl);
  const btn = $('.svc-btn', svcEl);
  const conn = profile[svc];
  if (conn && (conn.sk || conn.token)) {
    state.textContent = `connected${conn.name || conn.user ? ` as ${conn.name || conn.user}` : ''}`;
    state.classList.add('on');
    btn.textContent = 'Disconnect';
    btn.dataset.action = 'disconnect';
  } else {
    state.textContent = 'not connected';
    state.classList.remove('on');
    btn.textContent = 'Connect';
    btn.dataset.action = 'connect';
  }
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

  // Last.fm / Libre.fm (web auth)
  for (const svc of ['lastfm', 'librefm']) {
    const svcEl = $(`.svc[data-svc="${svc}"]`, node);
    renderServiceButton(svcEl, profile, svc);
    $('.svc-btn', svcEl).addEventListener('click', async (e) => {
      const action = e.target.dataset.action;
      if (action === 'disconnect') {
        await send({ type: 'disconnect', profileId: profile.id, service: svc });
        refresh();
        return;
      }
      const res = await send({ type: 'startWebAuth', service: svc, profileId: profile.id });
      if (!res || !res.ok) { toast(res && res.error || 'Auth failed.', true); return; }
      showPending(profile.label, svc);
      // Opening a tab closes this popup; the pending banner is restored from
      // storage the next time the panel opens, so the Finish step isn't lost.
      chrome.tabs.create({ url: res.url });
    });
  }

  // ListenBrainz (token)
  const lbEl = $('.svc[data-svc="listenbrainz"]', node);
  const lb = profile.listenbrainz;
  const lbState = $('.svc-state', lbEl);
  const lbConnect = $('.lb-connect', lbEl);
  const lbDisconnect = $('.lb-disconnect', lbEl);
  if (lb && lb.token) {
    lbState.textContent = `connected${lb.user ? ` as ${lb.user}` : ''}`;
    lbState.classList.add('on');
    lbConnect.classList.add('hidden');
    lbDisconnect.classList.remove('hidden');
  } else {
    lbState.textContent = 'not connected';
    lbConnect.classList.remove('hidden');
    lbDisconnect.classList.add('hidden');
  }
  $('.lb-save', lbEl).addEventListener('click', async () => {
    const token = $('.lb-token', lbEl).value.trim();
    if (!token) return;
    const res = await send({ type: 'saveListenBrainz', profileId: profile.id, token });
    if (res && res.ok) { toast(`ListenBrainz connected as ${res.user}.`); refresh(); }
    else toast(res && res.error || 'Token rejected.', true);
  });
  lbDisconnect.addEventListener('click', async () => {
    await send({ type: 'disconnect', profileId: profile.id, service: 'listenbrainz' });
    refresh();
  });

  return node;
}

function showPending(label, service) {
  const svcName = service === 'librefm' ? 'Libre.fm' : 'Last.fm';
  const el = $('#pending');
  el.innerHTML = '';
  const msg = document.createElement('div');
  msg.textContent =
    `Approve ${svcName} access for "${label}" in the tab that opened. ` +
    `Once you've clicked "Yes, allow access" there, come back and click Finish.`;
  el.appendChild(msg);

  const finish = document.createElement('button');
  finish.className = 'primary';
  finish.textContent = 'Finish connecting';
  finish.addEventListener('click', async () => {
    finish.disabled = true;
    const res = await send({ type: 'finishWebAuth' });
    finish.disabled = false;
    if (res && res.ok) {
      toast(`${svcName} connected as ${res.name}.`);
      el.classList.add('hidden');
      refresh();
    } else {
      // Most common: clicked before approving. Keep the banner so they can retry.
      toast(res && res.error ? `${res.error}` : 'Could not finish — approve access first, then retry.', true);
    }
  });
  el.appendChild(finish);

  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', async () => {
    await send({ type: 'cancelAuth' });
    el.classList.add('hidden');
  });
  el.appendChild(cancel);

  el.classList.remove('hidden');
}

async function refresh() {
  const { settings, profiles, pendingAuth } = await send({ type: 'getState' });
  loadSettings(settings);
  const list = $('#profiles');
  list.innerHTML = '';
  const entries = Object.values(profiles);
  $('#empty').classList.toggle('hidden', entries.length > 0);
  for (const p of entries) list.appendChild(renderProfile(p));

  // Restore an in-progress Last.fm / Libre.fm auth after the popup reopened.
  if (pendingAuth) {
    const p = profiles[pendingAuth.profileId];
    showPending(p ? p.label : pendingAuth.profileId, pendingAuth.service);
  } else {
    $('#pending').classList.add('hidden');
  }
}

$('#refresh').addEventListener('click', refresh);
refresh();
