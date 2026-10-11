# Translating Blinks United

The site is in English, and these files put it in other languages. **You do not
need to know how to code to help** — a translation is one line in one file.

Ten languages are wired up: Spanish, Portuguese (BR), Bahasa Indonesia,
Filipino, ไทย, 한국어, 日本語, Français, Deutsch, Italiano. Anything not yet
translated simply shows in English, so a language that is half done is useful
today rather than broken until it is finished.

Pick a language from the 🌐 button in the top bar, next to Install App.

## Where it stands — and the thing we most need from you

**The nav, footer, buttons and overlays — everything on every page — are done
in all ten languages, and every one of them is a machine first draft.** No
native speaker has read them yet. They are live because English-for-everyone
was worse, not because they are right.

So the most valuable thing you can do is not translate a new string. It is to
switch the site to your language, read what is already there, and fix what a
real person would never say. Correcting a draft takes a minute and is worth
more than a new sentence nobody checks.

The two places a draft is most likely to be wrong:

- **Fandom words.** Scrobble, stream, bias, comeback, board, badge. A machine
  translates these literally; blinks have real words for them already.
- **Tone.** The site speaks to one person, warmly and informally. Several of
  these languages have to choose a politeness level to say anything at all,
  and a draft picks one at random.

## How to add a translation

Open the file for your language — `es.json`, `ko.json`, `th.json` and so on.
Each line is one sentence:

```json
"Vote every category to the end.": "모든 카테고리를 끝까지 투표하세요."
```

**The left side is the key. Never change it.** It is the exact English on the
site, and it is how the right translation gets found. Change one character and
that sentence silently goes back to English.

The sentences still needing a translation are in `strings.json`, which lists
every string on the site and where it appears.

## The two things in the text that are not words

**`<0>` `<1>` `<2>` are the formatting.** They mark bold text, links, coloured
spans — whatever was around those words in English:

```
"<0>No vote limit</0> — the rules allow repeats"
```

Keep each pair together, and **put them where your language wants them**. That
is the whole reason they are numbers instead of fixed positions — word order
differs, and the formatting should follow the words it belongs to, not stay
where English left it:

```json
"<0>one</0> then <1>two</1>": "<1>dos</1> luego <0>uno</0>"
```

**`{n}` is a number the site fills in** — a vote count, a date, a total. Leave
it as `{n}`, and move it wherever your sentence needs it. They are filled in the
order they appear in your translation.

## What not to translate

- **Names**: BLACKPINK, JENNIE, ROSÉ, JISOO, LISA, BLINK, song and album titles
- **Other people's names**: nominees, other artists, other fandoms
- **Brands**: Spotify, YouTube, Nickelodeon, BreakTudo, MTV, Last.fm
- **The site's own name**, Blinks United

Most of those never reach you: the site's own name and the admin tools are
marked `data-no-i18n` in the page, so they are not collected as strings at all.
If something that should never be translated turns up in `strings.json`, that
is worth reporting — the fix belongs in the page, not in ten dictionaries.

Fandom words usually have a settled form in your language already — use the one
blinks actually say, not the dictionary one. That is the single most valuable
thing a real speaker brings here, and the main reason these files are not left
to a machine.

## Where to be most careful

The **voting** pages are the ones worth getting exactly right. A vague chart
label costs nothing; a vague voting rule costs somebody their vote. In
particular:

> Nothing is submitted until you finish the round

If that reads as "you can stop whenever you like" in your language, people will
stop, and their votes will not count. Say it as plainly as your language allows.

## 한국어 · 日本語 · ไทย — one thing that is not a bug

Much of the site is set in wide-tracked uppercase, which is a Latin design
device. Between Hangul, kana or Thai glyphs it reads as broken spacing instead
of as style, and Thai has no spaces between words, so tracking the characters
apart takes away the only cue for where a word ends. The site therefore drops
that spacing automatically — but only on the elements it actually translated.
A string still falling back to English keeps the spacing it was drawn with, so
a half-translated page will show both. That is the fallback working, not a
layout fault.

## For maintainers

```bash
node .github/scripts/i18n-extract.mjs     # rebuild strings.json from the live pages
node .github/scripts/i18n-extract.mjs --check   # has the English changed?
node .github/scripts/i18n-status.mjs      # coverage per language, and orphaned keys
node .github/scripts/test_i18n.mjs        # the mechanism itself
```

`strings.json` is generated by **rendering** every page in a browser and
collecting what is actually on screen — not by reading the source. Around 70% of
this site's text is built inside JavaScript template literals, so grepping finds
a fraction of it. The extractor calls the same `__collect()` the runtime uses to
walk the DOM, which is what keeps a translator's key and the runtime's lookup
identical by construction instead of by agreement.

**After changing any English on the site**, re-run the extractor and then
`i18n-status.mjs`: it reports keys that no longer match anything, which is what
a reworded sentence looks like from here. Nothing breaks when that happens —
the string just falls back to English in every language at once — which is
precisely why it has to be reported rather than noticed.

Text drawn into `<canvas>` (the share cards) and text inside images are not
reachable by any of this. They stay English.
