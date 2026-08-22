// Isolated content script on vote.mtv.com. Draws the BLINKS UNITED vote panel
// directly on the page (in a shadow root so MTV's CSS can't touch it), fed by the
// counters/log that background.js keeps in chrome.storage. Shows the live "blinks
// voting now" pulse. Never touches the MTV voting UI — it only reads our own state.
(function () {
  if (window.__buPanelMounted) return;         // guard against double-inject
  window.__buPanelMounted = true;
  if (window.top !== window) return;            // top frame only

  const HEART = chrome.runtime.getURL('assets/heart.png');
  const STICK = chrome.runtime.getURL('assets/lightstick.png');

  const host = document.createElement('div');
  host.id = 'bu-vote-panel-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host{ all:initial; }
      *{ box-sizing:border-box; margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
      .panel{
        position:fixed; top:96px; right:22px; width:290px;
        color:#fff2f6;
        background:
          radial-gradient(120% 80% at 50% -10%, #3a0c22 0%, transparent 55%),
          linear-gradient(180deg,#15070c 0%, #0c0509 100%);
        border-radius:16px; border:1px solid #4a1526;
        box-shadow:0 18px 50px -12px #000, 0 0 0 1px #ff2e7733, inset 0 0 46px #ff2e7718;
        overflow:hidden; user-select:none;
      }
      .head{ position:relative; padding:14px 16px 11px; text-align:center; border-bottom:1px solid #ff2e7722; cursor:grab; touch-action:none; }
      .head.dragging{ cursor:grabbing; }
      .titlerow{ display:flex; align-items:center; justify-content:center; gap:11px; }
      .stick{ height:40px; width:auto; filter:drop-shadow(0 2px 5px #000a) drop-shadow(0 0 7px #ff2e7755); }
      .stick.right{ transform:scaleX(-1); }
      .title{ font-weight:800; font-size:15px; letter-spacing:.16em;
        background:linear-gradient(90deg,#ff8fb4,#ff2e77 55%,#ff8fb4); -webkit-background-clip:text; background-clip:text; color:transparent; }
      .sub{ font-size:9px; letter-spacing:.24em; color:#d38aa4; text-transform:uppercase; margin-top:5px; }
      .btns{ position:absolute; top:7px; right:8px; display:flex; gap:6px; z-index:2; }
      .btns button{ all:unset; color:#ffb0cb; font-size:22px; font-weight:700; cursor:pointer; line-height:1;
        width:34px; height:34px; display:flex; align-items:center; justify-content:center; border-radius:9px;
        background:#ff2e7722; }
      .btns button:active{ background:#ff2e7744; }

      .live{ display:flex; align-items:center; justify-content:center; gap:7px; padding:9px 12px 2px; font-size:11px; color:#ff8fb4; }
      .live .dot{ width:7px; height:7px; border-radius:50%; background:#ff2e77; box-shadow:0 0 0 0 #ff2e7799; animation:pulse 1.8s infinite; }
      .live b{ color:#fff; font-variant-numeric:tabular-nums; }
      @keyframes pulse{ 0%{box-shadow:0 0 0 0 #ff2e7766} 70%{box-shadow:0 0 0 7px #ff2e7700} 100%{box-shadow:0 0 0 0 #ff2e7700} }

      .total{ position:relative; text-align:center; padding:8px 12px 6px; overflow:hidden; }
      .total .wm{ position:absolute; left:50%; top:54%; transform:translate(-50%,-50%); height:92px; opacity:.08; pointer-events:none; }
      .lbl{ position:relative; font-size:9px; letter-spacing:.24em; color:#d38aa4; text-transform:uppercase; }
      .num{ position:relative; font-variant-numeric:tabular-nums; font-weight:800; font-size:46px; line-height:1; margin-top:6px; text-shadow:0 0 24px #ff2e77aa; transition:transform .2s; }
      .num.bump{ transform:scale(1.12); }
      .unit{ position:relative; font-size:9.5px; letter-spacing:.18em; color:#ff8fb4; text-transform:uppercase; margin-top:6px; }

      .divider{ display:flex; align-items:center; gap:10px; margin:12px 16px 8px; }
      .divider::before,.divider::after{ content:""; flex:1; height:1px; background:linear-gradient(90deg,transparent,#ff2e7755,transparent); }
      .divider img{ height:18px; filter:drop-shadow(0 0 5px #ff2e7788); }

      .splits{ display:flex; gap:8px; padding:2px 14px 12px; }
      .chip{ flex:1; background:#ff2e7710; border:1px solid #ff2e7733; border-radius:11px; padding:9px 8px; text-align:center; }
      .chip .who{ font-size:10px; letter-spacing:.1em; color:#ff8fb4; text-transform:uppercase; }
      .chip .v{ font-variant-numeric:tabular-nums; font-weight:800; font-size:20px; margin-top:3px; }

      .log{ margin:2px 12px 12px; background:#0a0407; border:1px solid #ff2e7722; border-radius:11px; padding:8px; max-height:120px; overflow:hidden; }
      .log .empty{ color:#8a5c6c; font-size:11px; text-align:center; padding:10px 4px; }
      .row{ display:flex; align-items:center; gap:7px; font-size:11.5px; padding:5px 4px; border-bottom:1px dashed #ff2e7718; }
      .row:last-child{ border-bottom:0; }
      .row img{ height:13px; flex:none; }
      .plus{ color:#ff2e77; font-weight:800; font-variant-numeric:tabular-nums; }
      .cat{ color:#fff2f6; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .time{ color:#8a5c6c; font-size:10px; }

      .accts{ margin:0 12px 12px; }
      .acctToggle{ all:unset; display:flex; align-items:center; gap:6px; width:100%; cursor:pointer;
        font-size:11px; color:#d38aa4; padding:2px 2px 6px; }
      .acctToggle:hover{ color:#ff8fb4; }
      .acctToggle .caret{ margin-left:auto; color:#8a5c6c; }
      .acctList{ background:#0a0407; border:1px solid #ff2e7722; border-radius:11px; padding:6px 8px; }
      .acctRow{ display:flex; align-items:center; gap:8px; font-size:11px; padding:4px 2px; border-bottom:1px dashed #ff2e7714; }
      .acctRow:last-child{ border-bottom:0; }
      .aid{ flex:1; color:#fff2f6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .am{ font-size:9px; letter-spacing:.06em; text-transform:uppercase; color:#12000a; background:#ff8fb4; border-radius:5px; padding:2px 5px; }
      .av{ color:#ff8fb4; font-variant-numeric:tabular-nums; }
      .acctNote{ font-size:9px; color:#8a5c6c; text-align:center; padding:6px 2px 2px; }

      .sync{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 12px 12px; padding:8px 10px; background:#ff2e770a; border:1px solid #ff2e7722; border-radius:11px; }
      .sync .lab{ font-size:11px; color:#d38aa4; }
      .sync .lab b{ color:#ff8fb4; font-weight:700; }
      .sync .lab .sub{ display:block; font-size:9px; color:#8a5c6c; margin-top:2px; }
      .toggle{ all:unset; cursor:pointer; flex:none; width:36px; height:20px; border-radius:11px; background:#3a1622; position:relative; transition:background .15s; }
      .toggle[aria-checked="true"]{ background:#ff2e77; }
      .toggle .knob{ position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
      .toggle[aria-checked="true"] .knob{ left:18px; }
      .syncedTag{ font-size:8.5px; letter-spacing:.06em; text-transform:uppercase; color:#12000a; background:#ff8fb4; border-radius:5px; padding:1px 5px; margin-left:6px; }

      .foot{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 14px; border-top:1px solid #ff2e7722; background:#0a0407; }
      .status{ display:flex; align-items:center; gap:6px; font-size:10.5px; color:#d38aa4; }
      .status .d{ width:7px; height:7px; border-radius:50%; }
      .status.on .d{ background:#ff2e77; box-shadow:0 0 6px #ff2e77; }
      .status.off .d{ background:#7a4a58; }
      .link{ all:unset; color:#ff8fb4; font-size:10.5px; cursor:pointer; text-decoration:underline; }
      .brand{ font-size:9px; letter-spacing:.1em; color:#8a5c6c; text-transform:uppercase; }

      /* Collapsed "pill" — a small draggable chip that never blocks the vote UI. */
      .pill{ display:none; align-items:center; gap:8px; padding:11px 15px; cursor:grab; touch-action:none; }
      .pill img{ height:20px; filter:drop-shadow(0 0 5px #ff2e7788); }
      .pill .pk{ font-weight:800; letter-spacing:.1em; font-size:12px;
        background:linear-gradient(90deg,#ff8fb4,#ff2e77 55%,#ff8fb4); -webkit-background-clip:text; background-clip:text; color:transparent; }
      .pill .pn{ font-variant-numeric:tabular-nums; font-weight:800; font-size:16px; color:#fff; }
      .pill .pex{ margin-left:2px; color:#ffb0cb; font-size:15px; }
      .body.collapsed{ display:none; }
      .panel.min{ width:auto; }
      .panel.min .head, .panel.min .body{ display:none; }
      .panel.min .pill{ display:flex; }
    </style>

    <div class="panel" id="panel">
      <div class="pill" id="pill">
        <img src="${HEART}" alt=""><span class="pk">BU</span><span class="pn" id="pillnum">0</span><span class="pex">▸</span>
      </div>
      <div class="head" id="head">
        <div class="btns">
          <button id="min" title="Collapse">–</button>
        </div>
        <div class="titlerow">
          <img class="stick left" src="${STICK}" alt="">
          <div>
            <div class="title">BLINKS UNITED</div>
            <div class="sub">VMA Vote Counter</div>
          </div>
          <img class="stick right" src="${STICK}" alt="">
        </div>
      </div>

      <div class="body" id="body">
        <div class="live"><span class="dot"></span><b id="live">–</b> blinks voting now</div>

        <div class="total">
          <img class="wm" src="${HEART}" alt="">
          <div class="lbl">Counted today</div>
          <div class="num" id="total">0</div>
          <div class="unit">votes · synced to /voting</div>
        </div>

        <div class="divider"><img src="${HEART}" alt=""></div>

        <div class="splits">
          <div class="chip"><div class="who">BLACKPINK</div><div class="v" id="bp">0</div></div>
          <div class="chip"><div class="who">LISA</div><div class="v" id="lisa">0</div></div>
        </div>

        <div class="log" id="log"></div>

        <div class="accts" id="accts"></div>

        <div class="sync">
          <span class="lab"><b>⇄ Sync my devices</b>
            <span class="sub" id="syncSub">Off — counts &amp; accounts stay on this device</span></span>
          <button class="toggle" id="syncToggle" role="switch" aria-checked="false"
            title="Merge your counts and accounts-used list across every device you enable this on. Stores your voting emails to your BU account (only you can see them)."><span class="knob"></span></button>
        </div>

        <div class="foot">
          <span class="status off" id="status"><span class="d"></span><span id="statusTxt">Not linked</span></span>
          <span class="brand">blinksunited.com</span>
        </div>
      </div>
    </div>
  `;

  (document.body || document.documentElement).appendChild(host);

  const $ = (id) => root.getElementById(id);
  const elPanel = $('panel'), elBody = $('body'), elHead = $('head');
  const elTotal = $('total'), elBP = $('bp'), elLisa = $('lisa'), elLog = $('log');
  const elLive = $('live'), elStatus = $('status'), elStatusTxt = $('statusTxt'), elMin = $('min');
  const elAccts = $('accts');
  const elSyncToggle = $('syncToggle'), elSyncSub = $('syncSub');
  const elPill = $('pill'), elPillNum = $('pillnum');
  let acctOpen = false;
  let syncView = null; // last server-merged { bp, lisa, total, accounts } when sync is on

  const fmt = (n) => (n || 0).toLocaleString('en-US');
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'now'; if (s < 60) return s + 's'; const m = Math.round(s / 60);
    if (m < 60) return m + 'm'; return Math.round(m / 60) + 'h';
  };

  let lastTotal = 0;
  function render(s) {
    // When cross-device sync is on and we have a server view, show the merged
    // numbers/accounts; otherwise show this device's local ones.
    const synced = !!s.buSyncOn && !!s.buToken;
    const view = synced && syncView ? syncView : null;

    const total = view ? (view.total || 0) : (s.buCount || 0);
    if (total !== lastTotal) { elTotal.classList.add('bump'); setTimeout(() => elTotal.classList.remove('bump'), 200); lastTotal = total; }
    elTotal.textContent = fmt(total);
    elPillNum.textContent = fmt(total);
    elBP.textContent = fmt(view ? view.bp : s.bpCount);
    elLisa.textContent = fmt(view ? view.lisa : s.lisaCount);

    // Sync toggle + caption.
    elSyncToggle.setAttribute('aria-checked', s.buSyncOn ? 'true' : 'false');
    elSyncSub.textContent = s.buSyncOn
      ? 'On — merging across your devices'
      : 'Off — counts & accounts stay on this device';

    const log = Array.isArray(s.buLog) ? s.buLog : [];
    if (!log.length) {
      elLog.innerHTML = '<div class="empty">No votes counted yet — vote on this page and they’ll appear here.</div>';
    } else {
      elLog.innerHTML = log.slice(0, 5).map((e) =>
        '<div class="row"><img src="' + HEART + '" alt=""><span class="plus">+' + e.n + '</span>'
        + '<span class="cat">' + e.cat + ' · ' + e.who + '</span>'
        + '<span class="time">' + ago(e.ts) + '</span></div>'
      ).join('');
    }

    if (s.buToken) {
      elStatus.className = 'status on';
      elStatusTxt.textContent = s.buProfile ? ('Linked · ' + s.buProfile) : 'Linked';
    } else {
      elStatus.className = 'status off';
      elStatusTxt.innerHTML = '<button class="link" id="linkBtn">Link your account</button>';
      const lb = root.getElementById('linkBtn');
      if (lb) lb.onclick = () => window.open('https://blinksunited.com/vote-link.html', '_blank');
    }

    // Accounts you've voted with today. Local to this browser unless sync is on, in
    // which case it's the merged list across your devices.
    const accts = view ? (view.accounts || []) : (Array.isArray(s.buAccounts) ? s.buAccounts : []);
    let ah = '<button class="acctToggle" id="acctToggle">🔑 Accounts used today · ' + accts.length
      + (synced ? '<span class="syncedTag">synced</span>' : '')
      + '<span class="caret">' + (acctOpen ? '▾' : '▸') + '</span></button>';
    if (acctOpen) {
      if (accts.length) {
        const sorted = accts.slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0) || (b.votes || 0) - (a.votes || 0));
        ah += '<div class="acctList">' + sorted.map((a) =>
          '<div class="acctRow"><span class="aid" title="' + esc(a.id) + '">' + esc(a.id) + '</span>'
          + '<span class="am">' + esc(a.method || 'email') + '</span>'
          + '<span class="av">' + fmt(a.votes) + '</span></div>').join('')
          + '<div class="acctNote">' + (synced ? 'Synced to your BU account — only you can see this' : 'Stored on this device only') + '</div></div>';
      } else {
        ah += '<div class="acctList"><div class="acctNote">No accounts yet — vote and the emails/logins you use will appear here.</div></div>';
      }
    }
    elAccts.innerHTML = ah;
    const at = root.getElementById('acctToggle');
    if (at) at.onclick = () => { acctOpen = !acctOpen; refresh(); };
  }

  const KEYS = ['buCount', 'bpCount', 'lisaCount', 'buLog', 'buAccounts', 'buToken', 'buProfile', 'buSyncOn', 'buPanelPos', 'buPanelMin'];
  function refresh() { chrome.storage.local.get(KEYS, (s) => { applyLayout(s); render(s); }); }

  // React to background updates immediately.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => KEYS.includes(k))) refresh();
    // A vote just landed — pull the merged view too if sync is on.
    if (changes.buCount) pollSync();
  });
  // Keep the relative timestamps fresh.
  setInterval(refresh, 15000);

  // ── cross-device sync (opt-in) ──
  function pollSync() {
    chrome.storage.local.get(['buSyncOn', 'buToken'], (s) => {
      if (!s.buSyncOn || !s.buToken) { if (syncView) { syncView = null; refresh(); } return; }
      try {
        chrome.runtime.sendMessage({ type: 'bu-sync-pull' }, (resp) => {
          if (chrome.runtime.lastError) return;
          if (resp && resp.data) { syncView = resp.data; refresh(); }
        });
      } catch (_) {}
    });
  }
  elSyncToggle.onclick = () => {
    chrome.storage.local.get(['buToken', 'buSyncOn'], (s) => {
      if (!s.buToken) { window.open('https://blinksunited.com/vote-link.html', '_blank'); return; }
      const next = !s.buSyncOn;
      chrome.storage.local.set({ buSyncOn: next }, () => { if (next) pollSync(); else { syncView = null; refresh(); } });
    });
  };
  pollSync();
  setInterval(pollSync, 20000);

  // ── live "voting now" poll ──
  function pollLive() {
    try {
      chrome.runtime.sendMessage({ type: 'bu-live' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && typeof resp.liveVoters === 'number') elLive.textContent = fmt(resp.liveVoters);
      });
    } catch (_) {}
  }
  pollLive();
  setInterval(pollLive, 20000);

  // ── collapse / expand ──
  // On phones the panel starts collapsed as a small pill so it never covers the vote
  // button; on desktop it starts open. Once the user toggles, their choice sticks.
  function isMin(s) {
    return s.buPanelMin === undefined ? (window.innerWidth < 560) : !!s.buPanelMin;
  }
  function applyLayout(s) {
    const min = isMin(s);
    elBody.classList.toggle('collapsed', min);
    elPanel.classList.toggle('min', min);
    const pos = s.buPanelPos;
    if (pos && typeof pos.left === 'number') {
      elPanel.style.left = pos.left + 'px'; elPanel.style.top = pos.top + 'px'; elPanel.style.right = 'auto';
    }
  }
  let justDragged = false;
  const setMin = (v) => chrome.storage.local.set({ buPanelMin: v });
  elMin.onclick = (e) => { e.stopPropagation(); if (!justDragged) setMin(true); };
  elPill.addEventListener('click', () => { if (!justDragged) setMin(false); });

  // ── drag (pointer events → works with touch on Kiwi/mobile) ──
  let drag = null;
  function onDown(e) {
    if (e.target.closest('.btns')) return; // let the collapse button work
    const r = elPanel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    elHead.classList.add('dragging');
  }
  function onMove(e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.sx) > 4 || Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
    const left = Math.max(4, Math.min(window.innerWidth - 48, e.clientX - drag.dx));
    const top = Math.max(4, Math.min(window.innerHeight - 32, e.clientY - drag.dy));
    elPanel.style.left = left + 'px'; elPanel.style.top = top + 'px'; elPanel.style.right = 'auto';
    if (drag.moved) e.preventDefault();
  }
  function onUp() {
    if (!drag) return;
    const moved = drag.moved; drag = null; elHead.classList.remove('dragging');
    const r = elPanel.getBoundingClientRect();
    chrome.storage.local.set({ buPanelPos: { left: r.left, top: r.top } });
    if (moved) { justDragged = true; setTimeout(() => { justDragged = false; }, 250); }
  }
  elHead.addEventListener('pointerdown', onDown);
  elPill.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  refresh();
})();
