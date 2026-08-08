// ── Featured Instagram posts (BLACKPINK & the members) ───────────────────────
// ONE shared list, rendered on the homepage (where the Jennie banner was) and on
// the 10th-anniversary page. Add posts by pasting each one's URL below. Order
// here = order on the page. Must be individual PUBLIC posts/reels
// (…/p/XXXX/ or …/reel/XXXX/), NOT profile links.
window.IG_POSTS = [
  // { url: 'https://www.instagram.com/p/XXXXXXXXXXX/' },
  // { url: 'https://www.instagram.com/reel/XXXXXXXXXXX/' },
];

window.renderIgPosts = function (containerId) {
  var grid = document.getElementById(containerId);
  if (!grid) return;
  var posts = window.IG_POSTS || [];
  if (!posts.length) {
    grid.innerHTML =
      '<div style="border:1px dashed rgba(255,255,255,0.16);border-radius:14px;padding:2rem 1.5rem;max-width:560px;margin:0 auto;text-align:center;font-family:Georgia,serif;font-style:italic;color:rgba(245,240,240,0.5);line-height:1.6;">' +
      'No posts featured yet — send the Instagram links and they’ll appear here. 🖤💗</div>';
    return;
  }
  grid.innerHTML = posts.map(function (p) {
    return '<blockquote class="instagram-media" data-instgrm-permalink="' + p.url +
      '" data-instgrm-version="14" style="margin:0;max-width:540px;width:100%;min-width:300px;"></blockquote>';
  }).join('');
  // Load Instagram's embed script once, then (re)process the blockquotes.
  if (window.instgrm && window.instgrm.Embeds) { window.instgrm.Embeds.process(); return; }
  if (document.getElementById('ig-embed-js')) return;
  var s = document.createElement('script');
  s.id = 'ig-embed-js';
  s.async = true;
  s.src = 'https://www.instagram.com/embed.js';
  s.onload = function () { if (window.instgrm && window.instgrm.Embeds) window.instgrm.Embeds.process(); };
  document.body.appendChild(s);
};
