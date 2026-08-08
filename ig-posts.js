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
  // Lisa's post — add when the link is ready:
  // { url: 'https://www.instagram.com/p/XXXXXXXXXXX/' },
];

window.IG_LINKS = [
  { label: '🎧 Weverse Listening Party', url: 'https://listening-party.weverse.io/blackpink/wlp/3-238187356' },
  { label: '🔴 Weverse · Live', url: 'https://weverse.io/blackpink/live/2-178873994' },
  { label: '📻 Stationhead', url: 'https://www.stationhead.com/blackpink' },
];

// renderIgPosts(containerId, list) — image cards + Instagram embeds. Cards are
// masonry-friendly (break-inside:avoid) so they fit column layouts.
window.renderIgPosts = function (containerId, list) {
  var grid = document.getElementById(containerId);
  if (!grid) return;
  var posts = list || window.IG_POSTS || [];
  if (!posts.length) { grid.innerHTML = ''; return; }
  var needsEmbed = false;
  grid.innerHTML = posts.map(function (p) {
    if (p.img) {
      var label = p.name
        ? '<div style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.58rem;letter-spacing:0.16em;text-transform:uppercase;color:#FF0066;padding:0.55rem 0.6rem;text-align:center;">' + p.name + '</div>'
        : '';
      return '<a href="' + (p.url || p.img) + '" target="_blank" rel="noopener" ' +
        'style="display:block;width:100%;margin:0 0 1rem;break-inside:avoid;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);background:#150c13;text-decoration:none;transition:border-color 0.2s;" ' +
        'onmouseover="this.style.borderColor=\'rgba(255,0,102,0.5)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.1)\'">' +
        '<img src="' + p.img + '" alt="' + (p.name || 'BLACKPINK') + ' — 10th anniversary message to BLINK" loading="lazy" style="display:block;width:100%;height:auto;">' +
        label + '</a>';
    }
    needsEmbed = true;
    return '<blockquote class="instagram-media" data-instgrm-permalink="' + p.url +
      '" data-instgrm-version="14" style="margin:0;max-width:400px;width:100%;min-width:300px;"></blockquote>';
  }).join('');

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
      '.ig-track{display:flex;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;transition:height .25s ease;}' +
      '.ig-track::-webkit-scrollbar{display:none;}' +
      '.ig-slide{flex:0 0 100%;scroll-snap-align:center;padding:0 2px;}' +
      '.ig-slide img{display:block;width:100%;height:auto;border-radius:16px;border:1px solid rgba(255,255,255,0.12);}' +
      '.ig-dots{display:flex;gap:0.4rem;justify-content:center;margin-top:0.9rem;}' +
      '.ig-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.25);border:0;padding:0;cursor:pointer;transition:background .2s,transform .2s;}' +
      '.ig-dot.active{background:#FF3D8F;transform:scale(1.35);}' +
      '.ig-hint{font-family:ui-monospace,SFMono-Regular,monospace;font-size:0.55rem;letter-spacing:0.16em;text-transform:uppercase;color:rgba(245,240,240,0.4);text-align:center;margin-top:0.7rem;}';
    document.head.appendChild(st);
  }
  var slides = items.map(function (p) {
    return '<div class="ig-slide"><a href="' + (p.url || p.img) + '" target="_blank" rel="noopener">' +
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
  function fitHeight() { var s = track.children[current()]; if (s) track.style.height = s.offsetHeight + 'px'; }
  function sync() {
    var i = current();
    dotEls.forEach(function (d, j) { d.classList.toggle('active', j === i); });
    fitHeight();
  }
  dotEls.forEach(function (d) {
    d.addEventListener('click', function () { track.scrollTo({ left: (+d.dataset.i) * track.clientWidth, behavior: 'smooth' }); });
  });
  var raf;
  track.addEventListener('scroll', function () { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(sync); });
  window.addEventListener('resize', fitHeight);
  // Images load async — fit height as each arrives.
  wrap.querySelectorAll('.ig-slide img').forEach(function (img) {
    if (img.complete) fitHeight(); else img.addEventListener('load', fitHeight);
  });
  fitHeight();
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
