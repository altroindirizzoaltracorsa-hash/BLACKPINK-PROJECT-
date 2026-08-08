// ── Featured 10th-anniversary content (BLACKPINK & the members) ──────────────
// Shared across the homepage and the 10th-anniversary page. Groups:
//   IG_LETTERS  — members' handwritten letters (self-hosted images, labelled)
//   IG_MESSAGES — members' Weverse / app messages (self-hosted screenshots)
//   IG_POSTS    — Instagram posts, shown as live embeds
//   IG_LINKS    — external links (Weverse listening party, Stationhead, …)
// Image entry: { img:'/path.jpg', name?:'JISOO', url?:'https://…' }  (name = label; url = where it links, else opens the image)
// Embed entry: { url:'https://www.instagram.com/p/XXXX/' }
// Link entry:  { label:'Stationhead', url:'https://…' }

window.IG_LETTERS = [
  { img: '/anniv-jisoo.jpg',  name: 'JISOO'  },
  { img: '/anniv-jennie.jpg', name: 'JENNIE' },
  { img: '/anniv-rose.jpg',   name: 'ROSÉ'   },
  { img: '/anniv-lisa.jpg',   name: 'LISA'   },
];

window.IG_MESSAGES = [
  { img: '/msg-lisa.jpg' },
  { img: '/msg-jisoo-1.jpg' },
  { img: '/msg-jisoo-2.jpg' },
  { img: '/msg-jisoo-3.jpg' },
];

window.IG_POSTS = [
  { url: 'https://www.instagram.com/p/Dbvju_ipzwT/' },
  { url: 'https://www.instagram.com/p/DbvkMz_iQYc/' },
  { url: 'https://www.instagram.com/p/DbvklikFCcR/' },
  { url: 'https://www.instagram.com/p/Dbvj6S3z6cZ/' },
  { url: 'https://www.instagram.com/p/DbxcbjyEW5k/' },
];

window.IG_LINKS = [
  { label: '🎧 Weverse Listening Party', url: 'https://listening-party.weverse.io/blackpink/wlp/3-238187356' },
  { label: '🔴 Weverse · Live', url: 'https://weverse.io/blackpink/live/2-178873994' },
  { label: '📻 Stationhead', url: 'https://www.stationhead.com/blackpink' },
];

// ── Lightbox ─────────────────────────────────────────────────────────────────
// Tapping any letter/message opens a full-screen viewer you can swipe or arrow
// through (prev/next within the same gallery), instead of opening a new tab.
window._igGroups = window._igGroups || {};
window.openIgLightbox = function (groupId, index) {
  var imgs = window._igGroups[groupId];
  if (!imgs || !imgs.length) return false;
  var ov = document.getElementById('ig-lightbox');
  if (!ov) {
    var st = document.createElement('style');
    st.textContent =
      '#ig-lightbox{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.93);display:none;align-items:center;justify-content:center;padding:3rem 1rem;}' +
      '#ig-lightbox.open{display:flex;}' +
      '#ig-lightbox img.iglb-img{max-width:min(92vw,560px);max-height:84vh;width:auto;height:auto;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.6);}' +
      '.iglb-btn{position:absolute;background:rgba(255,255,255,0.12);border:0;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;}' +
      '.iglb-close{top:1rem;right:1.1rem;width:40px;height:40px;border-radius:50%;font-size:1.3rem;}' +
      '.iglb-nav{top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;font-size:1.8rem;}' +
      '.iglb-prev{left:0.6rem;} .iglb-next{right:0.6rem;}' +
      '.iglb-count{position:absolute;bottom:1.1rem;left:0;right:0;text-align:center;color:rgba(255,255,255,0.7);font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.7rem;letter-spacing:0.14em;}';
    document.head.appendChild(st);
    ov = document.createElement('div');
    ov.id = 'ig-lightbox';
    ov.innerHTML =
      '<button class="iglb-btn iglb-close" aria-label="Close">✕</button>' +
      '<button class="iglb-btn iglb-nav iglb-prev" aria-label="Previous">‹</button>' +
      '<img class="iglb-img" alt="">' +
      '<button class="iglb-btn iglb-nav iglb-next" aria-label="Next">›</button>' +
      '<div class="iglb-count"></div>';
    document.body.appendChild(ov);
    var imgEl = ov.querySelector('.iglb-img');
    var countEl = ov.querySelector('.iglb-count');
    function show(i) {
      var list = window._igGroups[ov.dataset.group] || [];
      if (!list.length) return;
      ov._i = (i + list.length) % list.length;
      imgEl.src = list[ov._i];
      var multi = list.length > 1;
      ov.querySelector('.iglb-prev').style.display = multi ? '' : 'none';
      ov.querySelector('.iglb-next').style.display = multi ? '' : 'none';
      countEl.textContent = multi ? (ov._i + 1) + ' / ' + list.length : '';
    }
    ov._show = show;
    function close() { ov.classList.remove('open'); document.removeEventListener('keydown', onKey); }
    ov._close = close;
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') show(ov._i - 1);
      else if (e.key === 'ArrowRight') show(ov._i + 1);
    }
    ov._onKey = onKey;
    ov.querySelector('.iglb-close').addEventListener('click', close);
    ov.querySelector('.iglb-prev').addEventListener('click', function (e) { e.stopPropagation(); show(ov._i - 1); });
    ov.querySelector('.iglb-next').addEventListener('click', function (e) { e.stopPropagation(); show(ov._i + 1); });
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var sx = 0;
    ov.addEventListener('touchstart', function (e) { sx = e.changedTouches[0].clientX; }, { passive: true });
    ov.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 40) show(ov._i + (dx < 0 ? 1 : -1));
    }, { passive: true });
  }
  ov.dataset.group = groupId;
  ov.classList.add('open');
  document.addEventListener('keydown', ov._onKey);
  ov._show(index);
  return false;
};

// renderIgPosts(containerId, list) — image cards + Instagram embeds. Cards are
// masonry-friendly (break-inside:avoid) so they fit column layouts.
window.renderIgPosts = function (containerId, list) {
  var grid = document.getElementById(containerId);
  if (!grid) return;
  var posts = list || window.IG_POSTS || [];
  if (!posts.length) { grid.innerHTML = ''; return; }
  var needsEmbed = false;
  var imgs = [];
  grid.innerHTML = posts.map(function (p) {
    if (p.img) {
      var label = p.name
        ? '<div style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.58rem;letter-spacing:0.16em;text-transform:uppercase;color:#FF0066;padding:0.55rem 0.6rem;text-align:center;">' + p.name + '</div>'
        : '';
      var opener;
      if (p.url) { opener = 'href="' + p.url + '" target="_blank" rel="noopener"'; }
      else { var idx = imgs.length; imgs.push(p.img); opener = 'href="#" onclick="return openIgLightbox(\'' + containerId + '\',' + idx + ')"'; }
      return '<a ' + opener + ' ' +
        'style="display:block;width:100%;margin:0 0 1rem;break-inside:avoid;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);background:#150c13;text-decoration:none;cursor:pointer;transition:border-color 0.2s;" ' +
        'onmouseover="this.style.borderColor=\'rgba(255,0,102,0.5)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.1)\'">' +
        '<img src="' + p.img + '" alt="' + (p.name || 'BLACKPINK') + ' — 10th anniversary message to BLINK" loading="lazy" style="display:block;width:100%;height:auto;">' +
        label + '</a>';
    }
    needsEmbed = true;
    return '<blockquote class="instagram-media" data-instgrm-permalink="' + p.url +
      '" data-instgrm-version="14" style="margin:0;max-width:400px;width:100%;min-width:300px;"></blockquote>';
  }).join('');
  window._igGroups[containerId] = imgs;

  if (!needsEmbed) return; // pure image gallery — no external script needed
  if (window.instgrm && window.instgrm.Embeds) { window.instgrm.Embeds.process(); return; }
  if (document.getElementById('ig-embed-js')) return;
  var s = document.createElement('script');
  s.id = 'ig-embed-js';
  s.async = true;
  s.src = 'https://www.instagram.com/embed.js';
  s.onload = function () { if (window.instgrm && window.instgrm.Embeds) window.instgrm.Embeds.process(); };
  document.body.appendChild(s);
};

// renderIgCarousel(containerId, list) — swipeable one-at-a-time carousel of images
// (used for the members' message screenshots, which vary in shape). Native
// scroll-snap; dots + dynamic height so each message frames snugly.
window.renderIgCarousel = function (containerId, list) {
  var wrap = document.getElementById(containerId);
  if (!wrap) return;
  var items = list || [];
  if (!items.length) { wrap.innerHTML = ''; return; }
  if (!document.getElementById('ig-carousel-css')) {
    var st = document.createElement('style');
    st.id = 'ig-carousel-css';
    st.textContent =
      '.ig-carousel{max-width:420px;margin:2rem auto 0;}' +
      '.ig-track{display:flex;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;height:clamp(340px,58vh,540px);}' +
      '.ig-track::-webkit-scrollbar{display:none;}' +
      '.ig-slide{flex:0 0 100%;scroll-snap-align:center;padding:0 2px;height:100%;display:flex;align-items:center;justify-content:center;}' +
      '.ig-slide img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;border-radius:16px;border:1px solid rgba(255,255,255,0.12);}' +
      '.ig-dots{display:flex;gap:0.4rem;justify-content:center;margin-top:0.9rem;}' +
      '.ig-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.25);border:0;padding:0;cursor:pointer;transition:background .2s,transform .2s;}' +
      '.ig-dot.active{background:#FF3D8F;transform:scale(1.35);}' +
      '.ig-hint{font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.55rem;letter-spacing:0.16em;text-transform:uppercase;color:rgba(245,240,240,0.4);text-align:center;margin-top:0.7rem;}';
    document.head.appendChild(st);
  }
  window._igGroups[containerId] = items.map(function (p) { return p.img; });
  var slides = items.map(function (p, i) {
    return '<div class="ig-slide"><a href="#" onclick="return openIgLightbox(\'' + containerId + '\',' + i + ')" style="cursor:zoom-in;">' +
      '<img src="' + p.img + '" alt="' + (p.name || 'BLACKPINK') + ' — 10th anniversary message to BLINK" loading="lazy"></a></div>';
  }).join('');
  var dots = items.map(function (_, i) {
    return '<button class="ig-dot' + (i === 0 ? ' active' : '') + '" data-i="' + i + '" aria-label="Message ' + (i + 1) + '"></button>';
  }).join('');
  wrap.innerHTML = '<div class="ig-carousel"><div class="ig-track">' + slides +
    '</div><div class="ig-dots">' + dots + '</div>' +
    (items.length > 1 ? '<div class="ig-hint">← swipe →</div>' : '') + '</div>';
  var track = wrap.querySelector('.ig-track');
  var dotEls = wrap.querySelectorAll('.ig-dot');
  function current() { return Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); }
  dotEls.forEach(function (d) {
    d.addEventListener('click', function () { track.scrollTo({ left: (+d.dataset.i) * track.clientWidth, behavior: 'smooth' }); });
  });
  var raf;
  track.addEventListener('scroll', function () {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () {
      var i = current();
      dotEls.forEach(function (d, j) { d.classList.toggle('active', j === i); });
    });
  });
};

// renderIgLinks(containerId, list) — external link buttons.
window.renderIgLinks = function (containerId, list) {
  var wrap = document.getElementById(containerId);
  if (!wrap) return;
  var links = list || window.IG_LINKS || [];
  wrap.innerHTML = links.map(function (l) {
    return '<a href="' + l.url + '" target="_blank" rel="noopener" ' +
      'style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:#FF0066;border:1px solid rgba(255,0,102,0.45);border-radius:999px;padding:0.6rem 1rem;text-decoration:none;transition:background 0.2s,color 0.2s;" ' +
      'onmouseover="this.style.background=\'#FF0066\';this.style.color=\'#0a0006\'" onmouseout="this.style.background=\'transparent\';this.style.color=\'#FF0066\'">' +
      l.label + '</a>';
  }).join('');
};
