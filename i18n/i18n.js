// Site translation, applied to the DOM rather than to the source.
//
// WHY THIS SHAPE. index.html is 22,000 lines and roughly 70% of its
// user-facing text is built inside JavaScript template literals — by
// drawVoteAward(), the badge grids, every chart panel. Tagging every element
// with data-i18n="a.key" would mean inventing ~1,600 keys and editing thousands
// of lines, and would still miss every string that does not exist until a
// render function runs.
//
// So nothing is tagged and no keys are invented: whatever built it, every
// string lands in the DOM, and THE ENGLISH IS THE KEY.
//
// THE UNIT IS A SENTENCE, NOT A TEXT NODE. This is the thing worth getting
// right. Markup splits sentences constantly — <b>, <a>, a <span> around a
// number — so walking text nodes hands a translator this:
//
//     "— 17.5B+ Spotify streams"
//
// when the sentence is "Most streamed girl group of all time — 17.5B+ Spotify
// streams". 77% of this site's strings are fragments like that (measured, not
// guessed). Translating them individually produces word salad in any language
// whose word order differs from English, which is most of the ten we ship.
//
// So the unit is the smallest element that contains a whole sentence, and its
// inline markup is replaced by numbered placeholders:
//
//     "Most streamed girl group of all time <0>— {n}B+ Spotify streams</0>"
//
// A translator sees one sentence and can put <0> wherever their grammar wants
// it. Keys stay stable when a class or href changes, because attributes are not
// in the key. And on the way back in, the ORIGINAL child elements are moved
// into place rather than re-created from HTML — so inline onclick handlers,
// attached listeners and element identity all survive a language switch.
//
// Everything else follows from the key being the English:
//
//   * a missing entry falls back to English by itself, so a language that is
//     40% done is usable, and a feature shipped tomorrow keeps working in all
//     ten until someone translates it;
//   * the dictionary cannot drift from the page, because the extractor calls
//     __collect() below — this same code — to build the string list;
//   * no render function has to know that translation exists.
//
// NOT REACHED, deliberately: text drawn into <canvas> (the share cards) and
// text inside images. Both are pixels by the time they exist.
(function () {
  'use strict';

  // Each language names itself. A picker that says "Spanish" to someone who
  // does not read English has failed at its one job.
  const LANGS = {
    en:      'English',
    es:      'Español',
    'pt-BR': 'Português (BR)',
    id:      'Bahasa Indonesia',
    fil:     'Filipino',
    th:      'ไทย',
    ko:      '한국어',
    ja:      '日本語',
    fr:      'Français',
    de:      'Deutsch',
    it:      'Italiano',
  };
  // A flag beside each name, to make the list scannable rather than read.
  //
  // BESIDE, never instead of. A flag is a country and these are languages, and
  // the two only line up for some of them: Spanish is spoken by far more people
  // outside Spain than in it, and English has no sensible flag at all. The
  // native name carries the meaning; the flag is a marker for the eye.
  //
  // ON WINDOWS THESE ARE NOT FLAGS. Windows ships no flag glyphs, so each one
  // falls back to its two regional-indicator letters — 🇰🇷 renders as "KR".
  // That still works as a scan marker, which is why this is worth doing anyway,
  // but it is not a rendering bug and nothing here can fix it.
  const FLAGS = {
    en: '🇬🇧', es: '🇪🇸', 'pt-BR': '🇧🇷', id: '🇮🇩', fil: '🇵🇭',
    th: '🇹🇭', ko: '🇰🇷', ja: '🇯🇵', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹',
  };
  // What the closed control shows. The nav bar has room for a marker, not for
  // "Bahasa Indonesia", so the face is a code and the full names live in the
  // list that opens.
  const CODES = {
    en: 'EN', es: 'ES', 'pt-BR': 'PT', id: 'ID', fil: 'FIL',
    th: 'TH', ko: 'KO', ja: 'JA', fr: 'FR', de: 'DE', it: 'IT',
  };
  // Languages whose script should not inherit the site's Latin letter-spacing.
  // See translateEl() for what this does and why it is per-element.
  const TIGHT = new Set(['ko', 'ja', 'th']);
  const DEFAULT_LANG = 'en';
  const STORE_KEY = 'buLang';

  let current = DEFAULT_LANG;
  let dict = null;
  let observer = null;

  // Elements that live INSIDE a sentence. Anything not here starts a new one.
  const INLINE = new Set(['A', 'B', 'I', 'EM', 'STRONG', 'SPAN', 'SMALL', 'U', 'S',
                          'SUP', 'SUB', 'MARK', 'ABBR', 'BR', 'WBR', 'IMG', 'Q', 'TIME', 'BDI']);

  // Never descend. <code>/<pre> must stay exact; the rest hold no prose.
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'SVG', 'CANVAS',
                             'NOSCRIPT', 'SELECT', 'OPTION']);

  // Attributes a person reads. `value` is absent on purpose: on every input
  // that has one here, it is the user's own typing.
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  // What we replaced, so a switch can put it back and a re-render is not
  // mistaken for new English. Keyed by the element we translated.
  const done = new WeakMap();   // el → { key, tags, nodes }

  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  // Numbers are why a plain dictionary fails on a live site: "3 votes are held"
  // and "7 votes are held" are one sentence and nobody translates every value.
  // Both key as "{n} votes are held", and the real numbers go back in after.
  // A number must END on a digit. The inner [.,] is for thousands separators
  // and decimals ("1,234.5"), but without the closing \d the match also eats a
  // sentence's full stop — "closes Oct 17." captured "17." as the number. In
  // English that is invisible, because the number is refilled exactly where it
  // was and the stop comes back with it. In a translation that moves the number
  // the stop travels too, and Spanish read "cierra el 17. de octubre".
  const NUM_RE = /\d(?:[\d.,]*\d)?/g;
  const keyOf = (s) => s.replace(NUM_RE, '{n}');

  function fillNums(translated, source) {
    const nums = source.match(NUM_RE);
    if (!nums) return translated;
    let i = 0;
    // A translation may reorder or drop placeholders — some languages must —
    // so these are consumed in order and anything extra is left alone.
    return translated.replace(/\{n\}/g, () => (i < nums.length ? nums[i++] : '{n}'));
  }

  // Language, or data? Pure numbers, emails, URLs and handles are data.
  function translatable(s) {
    if (!s || s.length < 2 || s.length > 1000) return false;
    if (!/[A-Za-z]{2}/.test(s)) return false;
    if (/^[\w.+-]+@[\w.-]+$/.test(s)) return false;
    if (/^https?:\/\//i.test(s)) return false;
    if (/^@[\w.-]+$/.test(s)) return false;
    return true;
  }

  function skipEl(el) {
    return SKIP_TAGS.has(el.tagName) || (el.hasAttribute && el.hasAttribute('data-no-i18n'));
  }

  // Does this element hold a sentence of its own, or is it a container of them?
  function isSentenceHost(el) {
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (/\S/.test(n.nodeValue)) hasText = true; }
      else if (n.nodeType === 1) {
        if (skipEl(n)) return false;          // leave the whole thing alone
        if (!INLINE.has(n.tagName)) return false;  // a block child — recurse instead
        if (n.textContent && /\S/.test(n.textContent)) hasText = true;
      }
    }
    return hasText;
  }

  // ── the key, and the pieces needed to rebuild ─────────────────────────────
  // "Most streamed <span>— 17.5B+ streams</span>" → { key: "Most streamed <0>— {n}B+ streams</0>", tags: [span] }
  function serialize(el) {
    const tags = [];
    const walk = (node) => {
      let out = '';
      for (const n of node.childNodes) {
        // Numbers are normalised HERE, on text only. Doing it to the finished
        // string instead would rewrite the tag indices too — every <0>, <1>
        // becoming <{n}> — leaving the placeholders indistinguishable and
        // build() unable to match a single one of them.
        if (n.nodeType === 3) out += n.nodeValue.replace(NUM_RE, '{n}');
        else if (n.nodeType === 1) {
          const i = tags.length; tags.push(n);
          // data-i18n-keep rides the same path as <br>/<img>: the element goes
          // into the key as <0/>, and build() puts the ORIGINAL back, contents
          // untouched. That is the difference from data-no-i18n, which takes
          // the whole sentence out of translation along with the name inside
          // it. Here the sentence still translates and the name cannot be
          // touched — and because it is a numbered placeholder, a language that
          // wants the name first is free to put it first.
          // Badge names are the case: "A little bit less than a lover",
          // "Who let this bitch out the cage?" are lyrics and fandom coinages,
          // not words to be rendered into Thai.
          const keep = n.tagName === 'BR' || n.tagName === 'IMG' || n.tagName === 'WBR'
            || n.hasAttribute('data-i18n-keep');
          out += keep ? `<${i}/>` : `<${i}>${walk(n)}</${i}>`;
        }
      }
      return out;
    };
    return { key: norm(walk(el)), tags };
  }

  // Put a translation back, MOVING the original elements rather than rebuilding
  // them from HTML. That is what keeps onclick handlers and element identity
  // alive across a language switch — this site assigns .onclick directly in
  // several places, and re-parsing would quietly kill those buttons.
  function build(translated, tags, source) {
    const text = fillNums(translated, source);
    const frag = document.createDocumentFragment();
    const used = new Set();
    // <0>…</0>, <0/>, or plain text between them.
    const re = /<(\d+)\/>|<(\d+)>([\s\S]*?)<\/\2>/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const idx = Number(m[1] !== undefined ? m[1] : m[2]);
      const el = tags[idx];
      if (el) {
        // Reusing a node twice is impossible, so a translation that repeats a
        // placeholder gets a clone for the second one. It loses listeners
        // attached in JS; inline handlers survive, and repeats are vanishingly
        // rare in practice.
        const node = used.has(idx) ? el.cloneNode(true) : el;
        used.add(idx);
        if (m[3] !== undefined) {
          const inner = build(m[3], tags, m[3]);
          node.textContent = '';
          node.appendChild(inner);
        }
        frag.appendChild(node);
      }
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function lookup(key) {
    if (!dict) return null;
    if (!translatable(key.replace(/<\/?\d+\/?>/g, ''))) return null;
    return dict[key] || null;
  }

  function translateEl(el) {
    const prev = done.get(el);
    const { key, tags } = prev ? { key: prev.key, tags: prev.tags } : serialize(el);
    const hit = lookup(key);
    if (hit == null) return;
    // The original content, at EVERY level. `nodes` alone is not enough: those
    // are the same element objects build() is about to refill, so restoring
    // them would hand back a <a> whose text had already been overwritten —
    // English at the top level, the previous language inside every tag. The
    // nav did exactly that. Cloning instead would drop listeners, so what is
    // kept is each tag's own child list.
    if (!prev) done.set(el, {
      key, tags,
      nodes: [...el.childNodes],
      tagKids: tags.map((t) => [...t.childNodes]),
      ls: el.style.letterSpacing,   // see TIGHT below
      tagLs: tags.map((t) => t.style.letterSpacing),
    });
    const source = norm(el.textContent);
    const frag = build(hit, tags, source);
    el.textContent = '';
    el.appendChild(frag);
    // This site's chrome is set in wide-tracked uppercase mono, which is a
    // Latin display device. Hangul, kana and Thai are not alphabets being
    // spaced out — they are syllables and clusters, and 0.18em between them
    // reads as damage rather than as style. Thai is the case that actually
    // costs something: it has no spaces between words, so tracking the glyphs
    // apart removes the only cue for where one word ends.
    //
    // Only elements this ACTUALLY translated are touched, so a string still
    // falling back to English keeps the design it was drawn for. The inline
    // value is saved above and put back by restore(), because a few of these
    // elements carry their own letter-spacing in a style attribute and
    // clearing it would be a one-way loss.
    //
    // The tags get it too, and they are not a detail: every nav item's key is
    // <0>Home</0>, so the element this walk holds is the <li> while the text
    // is inside the <a> — and `.nav-links a` is a more specific rule than
    // anything inherited from the parent. Setting only the host left the
    // entire navigation still tracked at 0.18em.
    if (TIGHT.has(current)) {
      el.style.letterSpacing = 'normal';
      for (const t of tags) t.style.letterSpacing = 'normal';
    }
  }

  function translateAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const store = `__i18n_${a}`;
      const src = el[store] !== undefined ? el[store] : el.getAttribute(a);
      const key = keyOf(norm(src));
      if (!translatable(key)) continue;
      const hit = dict && dict[key];
      if (!hit) continue;
      if (el[store] === undefined) el[store] = src;
      el.setAttribute(a, fillNums(hit, norm(src)));
    }
  }

  function walkTree(root, visit) {
    if (!root) return;
    const el = root.nodeType === 1 ? root : root.parentElement;
    if (!el) return;
    const stack = [root.nodeType === 1 ? root : el];
    while (stack.length) {
      const n = stack.pop();
      if (!n || n.nodeType !== 1 || skipEl(n)) continue;
      visit(n);
      if (!isSentenceHost(n)) for (const c of n.children) stack.push(c);
    }
  }

  function translate(root) {
    walkTree(root, (el) => {
      translateAttrs(el);
      if (isSentenceHost(el)) translateEl(el);
    });
  }

  function restore() {
    for (const el of document.querySelectorAll('*')) {
      const prev = done.get(el);
      if (prev) {
        // Inner content first, then the top level. Both put back the same
        // objects, so the order only has to be self-consistent.
        prev.tags.forEach((t, i) => {
          t.style.letterSpacing = (prev.tagLs && prev.tagLs[i]) || '';
          const kids = prev.tagKids[i];
          if (!kids) return;
          t.textContent = '';
          for (const n of kids) t.appendChild(n);
        });
        el.textContent = '';
        for (const n of prev.nodes) el.appendChild(n);
        el.style.letterSpacing = prev.ls || '';
      }
      for (const a of ATTRS) {
        const store = `__i18n_${a}`;
        if (el[store] !== undefined) el.setAttribute(a, el[store]);
      }
    }
  }

  // ── keeping up with the page ──────────────────────────────────────────────
  // Every panel here re-renders by assigning innerHTML, from code that knows
  // nothing about translation. Watching the document is what makes that a
  // non-issue. Batched per frame so a render touching a hundred nodes is one
  // pass, and our own writes are ignored to avoid a loop.
  let muted = false, pending = null, queued = false;
  function schedule(nodes) {
    if (current === DEFAULT_LANG || !dict) return;
    if (!pending) pending = new Set();
    for (const n of nodes) {
      if (n.nodeType === 1) pending.add(n);
      // A TEXT node, and its parent is what has to be translated. Filling an
      // element that already exists — `el.textContent = '...'` — adds only a
      // text node, so dropping those meant none of it was ever translated.
      // That is how the whole guide tour stayed in English while the panels
      // around it translated: every one of its steps writes into the same
      // #guide-title and #guide-body that were in the page from the start.
      else if (n.nodeType === 3 && n.parentElement) pending.add(n.parentElement);
    }
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const batch = pending; pending = null;
      muted = true;
      for (const n of batch) { try { if (n.isConnected) translate(n); } catch (_) {} }
      muted = false;
    });
  }

  function observe() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver((records) => {
      if (muted) return;
      const touched = [];
      for (const r of records) if (r.type === 'childList') for (const n of r.addedNodes) touched.push(n);
      if (touched.length) schedule(touched);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── switching ─────────────────────────────────────────────────────────────
  async function load(lang) {
    if (lang === DEFAULT_LANG) return null;
    const r = await fetch(`/i18n/${lang}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`no dictionary for ${lang}`);
    return await r.json();
  }

  async function setLang(lang, opts) {
    if (!LANGS[lang]) lang = DEFAULT_LANG;
    try { localStorage.setItem(STORE_KEY, lang); } catch (_) {}
    const was = current;
    try {
      dict = await load(lang);
      current = lang;
    } catch (e) {
      // A missing dictionary must not leave the page half-translated into a
      // language nobody asked for.
      console.warn('[i18n]', e.message);
      dict = null; current = DEFAULT_LANG;
    }
    document.documentElement.setAttribute('lang', current);
    muted = true;
    // Back to English first: otherwise a string missing from the new language
    // would keep showing the previous one's translation.
    if (was !== DEFAULT_LANG) restore();
    if (current !== DEFAULT_LANG) translate(document.body);
    muted = false;
    renderPicker();
    if (!opts || !opts.silent) document.dispatchEvent(new CustomEvent('bu-lang', { detail: { lang: current } }));
  }

  // ── the picker ────────────────────────────────────────────────────────────
  // The picker's own look, injected as the FIRST thing in <head> so any rule a
  // page writes beats it — index.html's narrow-screen overrides depend on that,
  // and a media query adds no specificity to win with.
  //
  // It lives here rather than in a stylesheet because the runtime loads on
  // eleven pages and only one of them, index.html, has this CSS or a slot in
  // its nav for the control.
  const CSS = `
#lang-picker { position: relative; display: inline-flex; align-items: center; }
#lang-picker.lang-pick-float { position: fixed; right: 16px; bottom: 16px; z-index: 9000; }
.lang-pick-face {
  display: inline-flex; align-items: center; gap: 0.32rem;
  background: rgba(8,8,8,0.82); border: 1px solid rgba(255,0,102,0.5);
  color: #ff0066; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.48rem; letter-spacing: 0.14em; text-transform: uppercase;
  padding: 0.4rem 0.8rem; white-space: nowrap; border-radius: 2px;
  transition: border-color 0.2s, background 0.2s;
}
#lang-picker:hover .lang-pick-face,
#lang-picker:focus-within .lang-pick-face {
  border-color: #ff0066; background: rgba(255,0,102,0.12);
}
#lang-picker select {
  position: absolute; inset: 0; width: 100%; height: 100%;
  opacity: 0; cursor: pointer; border: 0; padding: 0;
  /* iOS zooms the whole page when a focused control's text is under 16px. */
  font-size: 16px; -webkit-appearance: none; appearance: none;
}
#lang-picker option { background: #12000a; color: #f5f0f0; text-transform: none; letter-spacing: 0; }`;

  function injectCss() {
    if (document.getElementById('bu-i18n-css') || !document.head) return;
    const st = document.createElement('style');
    st.id = 'bu-i18n-css';
    st.textContent = CSS;
    document.head.insertBefore(st, document.head.firstChild);
  }

  // index.html puts the control in its nav bar, next to Install App. Every
  // other page — the guides, the campaign pages — has its own markup and no
  // slot for it, so one is placed in the corner instead. Editing ten different
  // navs to each hold the same control is the version of this that rots.
  function pickerHost() {
    let host = document.getElementById('lang-picker');
    if (host) return host;
    if (!document.body) return null;
    host = document.createElement('div');
    host.id = 'lang-picker';
    host.className = 'lang-pick-float';
    document.body.appendChild(host);
    clearOfFixedBars(host);
    return host;
  }

  // That corner is not always empty: breaktudo.html parks a full-width "see the
  // board" bar along the bottom, and the picker landed on top of its button.
  // Rather than guess a safe offset per page, ask the page what is actually at
  // that point and step over it. Re-checked once after load, because a bar that
  // appears late would otherwise be missed.
  function clearOfFixedBars(host) {
    const lift = () => {
      host.style.bottom = '16px';
      const r = host.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      let bottom = 16;
      for (const el of document.elementsFromPoint(x, y) || []) {
        if (el === host || host.contains(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        const b = el.getBoundingClientRect();
        if (b.height && b.height < window.innerHeight / 2) {
          bottom = Math.max(bottom, window.innerHeight - b.top + 10);
        }
        break;
      }
      host.style.bottom = bottom + 'px';
    };
    try {
      lift();
      window.addEventListener('load', () => { try { lift(); } catch (_) {} }, { once: true });
      setTimeout(() => { try { lift(); } catch (_) {} }, 1500);
    } catch (_) {}
  }

  function renderPicker() {
    injectCss();
    const host = pickerHost();
    if (!host) return;
    // The language names are already in their own languages and must never be
    // translated into the current one.
    host.setAttribute('data-no-i18n', '');
    // The face is a globe, not the current language's flag. Windows ships no
    // flag glyphs, so 🇰🇷 would render as the letters "KR" directly beside the
    // code "KO" — two letter pairs saying the same thing. A globe renders
    // everywhere and means "language" on its own. Inside the open list the
    // flags earn their place (see FLAGS); here they would only add noise.
    // aria-hidden: the <select> on top already carries the accessible name.
    // The code is its own span so a narrow phone can drop it and keep the
    // globe: the nav bar there is the logo, this, Install App and the
    // hamburger, and the hamburger losing its corner is a worse outcome than
    // a two-letter code going away.
    host.innerHTML = '<span class="lang-pick-face" aria-hidden="true">🌐'
      + '<span class="lang-pick-code">' + (CODES[current] || current.toUpperCase()) + '</span></span>'
      + '<select id="lang-select" aria-label="Language">'
      + Object.keys(LANGS).map((k) => {
          const flag = FLAGS[k] ? FLAGS[k] + ' ' : '';
          // The label a screen reader announces is the name alone: a flag read
          // aloud as "flag of South Korea" in place of "한국어" is worse than
          // nothing, and the name is the part that actually identifies it.
          return `<option value="${k}"${k === current ? ' selected' : ''} aria-label="${LANGS[k]}">`
            + `${flag}${LANGS[k]}</option>`;
        }).join('')
      + '</select>';
    host.querySelector('select').onchange = (e) => setLang(e.target.value);
  }

  // Their choice beats their browser, and both beat English. A browser set to
  // pt-PT gets pt-BR: a close language is far better than a foreign one.
  function preferred() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && LANGS[saved]) return saved;
    } catch (_) {}
    for (const tag of (navigator.languages || [navigator.language || ''])) {
      if (!tag) continue;
      if (LANGS[tag]) return tag;
      const base = tag.toLowerCase().split('-')[0];
      const match = Object.keys(LANGS).find((k) => k.toLowerCase().split('-')[0] === base);
      if (match) return match;
    }
    return DEFAULT_LANG;
  }

  // ── for the extractor ─────────────────────────────────────────────────────
  // The string list is built by calling THIS, in a real browser, on a rendered
  // page — so a translator's key and the runtime's lookup are the same string
  // by construction rather than by agreement.
  function collect() {
    const out = [];
    const page = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.id && n.id.indexOf('page-') === 0) return n.id.slice(5);
      }
      return 'chrome';   // nav, footer, overlays — on every page
    };
    walkTree(document.body, (el) => {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const k = keyOf(norm(el.getAttribute(a)));
        if (translatable(k)) out.push({ s: k, attr: a, page: page(el) });
      }
      if (!isSentenceHost(el)) return;
      const { key } = serialize(el);
      if (translatable(key.replace(/<\/?\d+\/?>/g, ''))) out.push({ s: key, page: page(el) });
    });
    return out;
  }

  window.BU_I18N = {
    langs: LANGS,
    flags: FLAGS,
    setLang,
    get lang() { return current; },
    __collect: collect,
    // For tests: what would this key become?
    t(key) { const hit = lookup(key); return hit == null ? key : hit; },
  };

  function start() {
    observe();
    renderPicker();
    const want = preferred();
    if (want !== DEFAULT_LANG) setLang(want, { silent: true });
  }

  // ── the live switch ────────────────────────────────────────────────────────
  // OFF. The machinery is finished and shipped; the translations are not. At
  // the time of writing each language covers 28% of the page — the nav
  // completely, the voting flow almost, and the other 593 strings not at all —
  // and none of the 283 that do exist has been read by a native speaker.
  //
  // Half is worse than none here. A blink who picks 한국어 and gets a Korean
  // nav above an English page has not been helped; they have been told the site
  // speaks Korean and then shown that it does not. So the picker does not
  // appear and nothing is translated until there is enough to be worth
  // choosing.
  //
  // This gates `start()` ONLY. window.BU_I18N above is still exported, because
  // i18n-extract.mjs and i18n-status.mjs drive __collect() through a real page
  // load — gating the export would break the very tooling used to finish the
  // translations, and the switch would then be defending the work it is meant
  // to protect.
  //
  // To flip it: LIVE = true. Nothing else; the attributes are already in the
  // HTML and inert while this is false.
  const LIVE = false;

  // Previewing without shipping. ?i18n=on turns it on for this browser, ?i18n=off
  // turns it back off. Deliberately sticky rather than per-page-load: the site is
  // a single page that rewrites its own URL as you move around, so a query
  // param would be dropped on the first navigation and the preview would last
  // one screen. The cost of sticky is that it has to be switchable off again,
  // hence ?i18n=off — and it is per-browser, so it can never leak to visitors.
  function live() {
    try {
      const q = new URLSearchParams(location.search).get('i18n');
      if (q === 'on')  { localStorage.setItem('bu_i18n_preview', '1'); return true; }
      if (q === 'off') { localStorage.removeItem('bu_i18n_preview'); return false; }
      if (localStorage.getItem('bu_i18n_preview') === '1') return true;
    } catch (e) { /* private mode: fall through to the shipped setting */ }
    return LIVE;
  }

  if (!live()) return;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
