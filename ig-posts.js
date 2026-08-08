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
  { label: '📺 Weverse · Media', url: 'https://weverse.io/blackpink/media/3-238407383' },
  { label: '📺 Weverse · Media', url: 'https://weverse.io/blackpink/media/4-238345927' },
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
