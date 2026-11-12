// The two views of the collab trade block, measured in a browser.
//
// Run: node .github/scripts/test_collab_views.mjs
//
// One selector, two readings of the same votes:
//
//   BY TRADE — what each ballot slot received, one row per pairing.
//   BY VOTER — a table: one row per self-declared side, one column per ballot
//     slot. "BLOOMs put 96 in BLACKPINK's category and 94 in BINI's."
//
// WHY THE SECOND ONE IS A TABLE, and why that is the thing to protect. Drawn as
// the four trades with the sides under each — which is what it was first — three
// of the four repeat BINI's single ballot category and two repeat BLACKPINK's:
// thirty-two numbers for fifteen facts, with an asterisk on about three
// quarters of them to say which were the same figure twice. The do-not-sum
// warning is a real one and it ended up applying to most of the block rather
// than to an exception. Across a row of the table nothing repeats, so nothing
// needs the asterisk. If this view ever goes back to being drawn on trades,
// that is what comes back with it.
//
// THE CLAIM THIS CHANGED. The page used to say a vote could not be traced to a
// fandom. This view attributes — not a vote, which carries no fandom, but a
// PERSON: somebody declares a side once and their own picks are recorded per
// round, so a cell is a sum over people who answered. The reach of that is
// exactly those people, which is why "didn't say" is a row of its own and never
// shared out: doing that would put votes under a fandom on the strength of
// nothing.
//
// Three failures live here and none throws.
//
//   1. A column that does not add up to the slot's own total — a side dropped,
//      a stray key ignored — and the table quietly understates somebody.
//   2. Shading drawn down the columns instead of across the rows. It would look
//      finer (every big side full, every small one short) and would say the
//      headcounts, which the turnout block already says, instead of where a
//      side's ballot was short, which is what a trade is checked on.
//   3. The split rebuilt on the page from `board`, which is cut to BOARD_MAX:
//      exact until this collab passes 200 voters, then quietly short.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PAGES = { '/collabs': '/collabs.html' };

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  const file = PAGES[p] || p;
  try {
    const buf = await readFile(ROOT + file);
    const ext = file.split('.').pop();
    res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript',
      css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(''); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const browser = await chromium.launch();
const errs = [];
async function open(path, w = 1200) {
  const page = await browser.newPage({ viewport: { width: w, height: 1400 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  return page;
}

const page = await open('/collabs?demo=b');

console.log('--- the selector offers both views and starts on the trade');
{
  const tabs = await page.$$eval('.pr-tabs .tab', (els) => els.map((e) => ({
    label: e.textContent.trim(), on: e.classList.contains('on'),
    pressed: e.getAttribute('aria-pressed'),
  })));
  check(tabs.length === 2, `there are ${tabs.length} view tab(s)`, tabs.map((t) => t.label).join(' / '));
  check(tabs.filter((t) => t.on).length === 1, 'exactly one is lit');
  check(tabs[0] && tabs[0].on, 'and it is the trade view', tabs.map((t) => `${t.label}${t.on ? '*' : ''}`).join(' '));
  check(tabs.every((t) => t.pressed === (t.on ? 'true' : 'false')), 'aria-pressed matches what is lit');
}

console.log('\n--- the voter view is sides down, ballot slots across');
await page.click('.pr-tabs .tab:nth-child(2)');
await page.waitForTimeout(400);
const t = await page.evaluate(() => {
  const head = [...document.querySelectorAll('.vt thead th')].map((th) => th.textContent.trim());
  const rows = [...document.querySelectorAll('.vt tbody tr')].map((tr) => ({
    side: tr.querySelector('.vt-side').textContent.trim(),
    cells: [...tr.querySelectorAll('td')].slice(1, -1).map((td) => ({
      n: Number(td.textContent.replace(/[^\d]/g, '') || 0),
      // The DRAWN width, off the element. Reading the style string back would
      // only confirm the number that was written into it.
      px: (() => { const b = td.querySelector('.vt-bar'); return b ? Math.round(b.getBoundingClientRect().width) : 0; })(),
      cell: (() => { const d = td.querySelector('.vt-cell'); return d ? Math.round(d.getBoundingClientRect().width) : 0; })(),
      split: td.classList.contains('vt-split'),
    })),
    all: Number((tr.querySelector('.vt-all') || {}).textContent.replace(/[^\d]/g, '') || 0),
  }));
  const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
  const p = c.tally.periods[PERIOD];
  return { head, rows,
           ours: (c.theyGive || []).map((x) => ({ slug: x.slug, act: x.who || x.nominee })),
           theirs: (c.weGive || []).map((x) => ({ slug: x.slug, act: x.who || x.nominee })),
           byCat: p.byCat, fandomCats: p.fandomCats,
           sides: c.fandoms.map((x) => ({ key: x.key, label: x.label })),
           head1: document.querySelector('.pairings-head').textContent.trim(),
           note: document.querySelector('.pairings .pr-note').textContent.replace(/\s+/g, ' ') };
});
const cols = t.ours.concat(t.theirs);
{
  // One column per ballot slot the collab has, in trade order: ours, then
  // theirs. Taken from the collab's own lists, so a slot added to the trade
  // appears here without touching this test.
  check(t.head.length === cols.length + 2,
        `${t.head.length - 2} slot column(s) for ${cols.length} slot(s)`, t.head.join(' | '));
  check(cols.every((col, i) => t.head[i + 1].includes(col.act)),
        'each names its act, ours first then theirs', t.head.slice(1, -1).join(' | '));
  check(/all/i.test(t.head[t.head.length - 1]), 'and the last column is the row total', t.head[t.head.length - 1]);
  // The divider falls where the trade does.
  check(t.rows.every((r) => r.cells.filter((x) => x.split).length === 1
        && r.cells.findIndex((x) => x.split) === t.ours.length),
        'a rule separates our slots from the partners\'', String(t.ours.length));
}

console.log('\n--- every cell is that side\'s own count for that slot');
{
  const key = {};
  for (const s of t.sides) key[s.label] = [s.key];
  key['Didn’t say'] = Object.keys(t.fandomCats).filter((k) => !t.sides.some((s) => s.key === k));
  const wrong = [];
  for (const r of t.rows) {
    const ks = key[Object.keys(key).find((l) => r.side.includes(l))] || [];
    cols.forEach((col, i) => {
      const want = ks.reduce((a, k) => a + ((t.fandomCats[k] || {})[col.slug] || 0), 0);
      if (r.cells[i].n !== want) wrong.push(`${r.side}/${col.act}: ${r.cells[i].n} want ${want}`);
    });
    const tot = cols.reduce((a, col) => a + ks.reduce((b, k) => b + ((t.fandomCats[k] || {})[col.slug] || 0), 0), 0);
    if (r.all !== tot) wrong.push(`${r.side} all: ${r.all} want ${tot}`);
  }
  check(wrong.length === 0, 'and the "all" column is its row', wrong.join(' | '));

  // THE PROPERTY THAT MAKES THE TABLE HONEST. The rows are everybody, so a
  // column comes to the figure the trade view prints for that slot. Dropping
  // "didn't say", or ignoring a key the collab no longer lists, is exactly what
  // this catches — and it is silent on the page, because a column that is short
  // still looks like a column.
  const off = [];
  cols.forEach((col, i) => {
    const sum = t.rows.reduce((a, r) => a + r.cells[i].n, 0);
    if (sum !== t.byCat[col.slug]) off.push(`${col.act}: ${sum} vs ${t.byCat[col.slug]}`);
  });
  check(off.length === 0, 'and a column adds up to that slot\'s own total', off.join(' | '));
}

console.log('\n--- the shading runs ACROSS a row, not down a column');
// Across: where that side's own ballot was short, which is what a trade is
// checked on. Down: the headcounts again, which the turnout block already
// carries — and a reader comparing shading between rows would be comparing two
// different scales without being told.
{
  const bad = [];
  for (const r of t.rows) {
    const most = Math.max(...r.cells.map((x) => x.n));
    for (const x of r.cells) {
      if (!x.n) { if (x.px) bad.push(`${r.side} empty cell drew ${x.px}px`); continue; }
      if (Math.abs(x.px / x.cell - x.n / most) > 0.06) {
        bad.push(`${r.side} ${Math.round(x.px / x.cell * 100)}% vs ${Math.round(x.n / most * 100)}%`);
      }
    }
  }
  check(bad.length === 0, 'each bar is its cell against the row\'s best', bad.join(' | '));

  // AND THE CELLS HAVE TO BE THE SAME WIDTH. Each bar is a percentage of its
  // own cell, so columns of different widths make the bars incomparable — with
  // the widths left to the content, BLINKs' 200 for Ahn Hyo-seop drew a longer
  // bar than their 250 for BLACKPINK, because the longer name made a wider
  // column. Everything above passed while the picture said the opposite of the
  // numbers printed on it. Only measuring the cells finds that.
  const widths = t.rows[0].cells.map((x) => x.cell);
  check(Math.max(...widths) - Math.min(...widths) <= 2,
        'and every slot column is the same width, so the bars compare',
        widths.join(', '));
  // The row's best really is full, which is what makes a short one read short.
  const longest = t.rows.map((r) => {
    const most = Math.max(...r.cells.map((x) => x.n));
    const at = r.cells.find((x) => x.n === most);
    return { side: r.side, pct: Math.round(at.px / at.cell * 100) };
  });
  check(longest.every((x) => x.pct >= 94), 'and each row\'s best column fills its cell',
        longest.map((x) => `${x.side} ${x.pct}%`).join(', '));

  // And the rule is not vacuous: on this data the two scales disagree, so a
  // column-scaled build would have been caught.
  const colMost = cols.map((col, i) => Math.max(...t.rows.map((r) => r.cells[i].n)));
  const differs = t.rows.some((r) => {
    const rowMost = Math.max(...r.cells.map((x) => x.n));
    return r.cells.some((x, i) => x.n && Math.abs(x.n / rowMost - x.n / colMost[i]) > 0.06);
  });
  check(differs, 'and the two scales really differ on this data, so the check can tell');
}

console.log('\n--- nothing repeats, so nothing is asterisked');
// The reason this is a table at all. Each ballot slot appears once across a
// row, so the mark that the trade view needs on three quarters of its numbers
// is not needed here on any of them.
{
  const slugs = cols.map((x) => x.slug);
  check(new Set(slugs).size === slugs.length, 'each ballot slot has exactly one column',
        slugs.join(', '));
  const marks = await page.evaluate(() => ({
    stars: (document.querySelector('.vt').textContent.match(/\*/g) || []).length,
    hatched: document.querySelectorAll('.vt .pr-repeat').length,
  }));
  check(marks.stars === 0, 'no asterisk anywhere in the table', String(marks.stars));
  check(marks.hatched === 0, 'and nothing hatched');
  // The other view still carries both: the repetition is real there.
  const trade = await page.evaluate(() => {
    setPairView('trade');
    const n = { stars: (document.querySelector('.pairings').textContent.match(/\*/g) || []).length,
                hatched: document.querySelectorAll('.pairings .pr-repeat').length };
    setPairView('voter');
    return n;
  });
  check(trade.stars > 0 && trade.hatched > 0,
        'while the trade view keeps its marks', `${trade.stars} stars, ${trade.hatched} hatched`);
}

console.log('\n--- "didn\'t say" is its own row, never spread across the others');
{
  const got = await page.evaluate(() => {
    const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
    const slug = c.theyGive[0].slug;
    const fc = { blink: { [slug]: 10 },
                 'a-side-this-collab-dropped': { [slug]: 3 },
                 unsaid: { [slug]: 7 } };
    const tb = voterTable(c, { fandomCats: fc });
    const i = tb.cols.findIndex((x) => x.slug === slug);
    return { rows: tb.rows.map((r) => ({ label: r.label, n: r.cells[i] })) };
  });
  const blink = got.rows.filter((r) => /BLINK/i.test(r.label))[0] || {};
  const other = got.rows.filter((r) => /Didn/i.test(r.label))[0] || {};
  check(blink.n === 10, 'a declared side carries only its own votes', String(blink.n));
  // The never-answered and a side the collab no longer has are the same
  // situation — nothing recognises them — and both belong in that one row.
  check(other.n === 10, 'and one row carries the undeclared AND the dropped side', String(other.n));
  check(got.rows.some((r) => /Pauljjak/i.test(r.label)),
        'a declared side keeps its row with nothing logged');
}

// This was the other way round until someone reading the live page asked why
// Ahn Hyo-seop's fandom was missing from the table. It was not missing: it had
// no row, and a sentence at the end of the note said so — four sentences down,
// below the fold on a phone, which is not where the question gets asked. The
// answer belongs in the row.
//
// WHAT THE ROW MUST NOT SAY is that they did not vote. The page knows who
// DECLARES a side; a Pauljjak voter who never answered is in Didn't say,
// counted. Zeroes across five columns would be a claim about another fandom's
// turnout that this data cannot support, which is also why the row is prose
// and not figures.
console.log('\n--- a declared side with nothing logged says so in its own row');
{
  const got = await page.evaluate(() => {
    const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
    const quiet = JSON.parse(JSON.stringify(c.tally.periods.all.fandomCats));
    delete quiet.pauljjak;                       // exactly what the live API returns
    const box = document.createElement('div');
    box.innerHTML = voterViewHtml(c, voterTable(c, { fandomCats: quiet }));
    // IN the document, because getComputedStyle on a detached node returns an
    // empty declaration — every style check against one passes or fails on
    // nothing. That is what the wrapping check did on its first run: it went
    // red against a stylesheet that was already correct.
    box.className = 'pairings';
    document.body.appendChild(box);
    const tr = [...box.querySelectorAll('tbody tr')]
      .filter((x) => /Pauljjak/.test(x.querySelector('.vt-side').textContent))[0];
    const none = tr && tr.querySelector('.vt-none');
    return {
      present: !!tr,
      text: none ? none.textContent.replace(/\s+/g, ' ').trim() : '',
      // Spans the whole table, so it cannot line up under a column and be read
      // as that column's figure.
      span: none ? Number(none.getAttribute('colspan')) : 0,
      cols: box.querySelectorAll('thead th').length - 1,
      // No digits anywhere in the row: a 0 or a — in a numeric column is read
      // as a count, which is the claim this must not make.
      digits: tr ? /\d/.test(tr.textContent) : true,
      // It has to WRAP. `.vt th, .vt td` sets white-space:nowrap for the
      // figures, and a bare `.vt-none` loses to it on specificity — which it
      // did, and the sentence ran off the side of a table that scrolls
      // sideways, so the half that says where those people actually are was
      // off-screen. Read computed rather than from the stylesheet text,
      // because specificity is the thing being tested.
      wraps: none ? getComputedStyle(none).whiteSpace : '',
    };
  });
  await page.evaluate(() => { const b = document.querySelectorAll('.pairings'); b[b.length - 1].remove(); });
  check(got.present, 'the row is there');
  check(/nobody has said they are Pauljjak/i.test(got.text),
        '  and says nobody has SAID, not that nobody voted', got.text);
  check(/Didn’t say|Didn't say/.test(got.text),
        '  and points at where those people are counted instead');
  check(got.span === got.cols, '  spanning the data columns, not posing as one',
        `colspan ${got.span} of ${got.cols}`);
  check(!got.digits, '  with no figure in it to misread as a turnout of zero');
  check(/^(normal|pre-wrap|pre-line)$/.test(got.wraps),
        '  and wrapping, not running off a table that scrolls sideways', got.wraps);
}

console.log('\n--- the split comes from the API, not rebuilt from the capped board');
{
  const src = await readFile(ROOT + '/collabs.html', 'utf8');
  const api = await readFile(ROOT + '/api/collabs.js', 'utf8');
  check(/for \(const e of per\.values\(\)\)[\s\S]{0,420}fandomCats/.test(api),
        'the API builds it from every row, not from `board`');
  check(/return \{ byCat, board, fandoms, fandomCats, total/.test(api), 'and sends it');
  const lines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const leak = lines.filter((l) => /\.board\b/.test(l) && /fandom/i.test(l));
  check(leak.length === 0, 'and the page never reconstructs it from the board',
        leak.map((l) => l.trim().slice(0, 70)).join(' | '));
  const none = await page.evaluate(() => {
    const c = COLLABS.find((x) => x.id === 'bvp-kca-2026');
    return voterTable(c, { byCat: c.tally.periods.all.byCat });
  });
  check(none === null, 'and without it there is no table at all', JSON.stringify(none));
}

console.log('\n--- the page no longer claims it cannot tell who logged a vote');
{
  const notes = await page.evaluate(() => ({
    tally: document.querySelector('.tally-note').textContent.replace(/\s+/g, ' '),
    turnout: [...document.querySelectorAll('.sub-note')].map((n) => n.textContent.replace(/\s+/g, ' ')).join(' '),
    // THE WHOLE PAGE, not the three notes I happened to edit. Scoped to those,
    // this passed while a fourth copy sat in the static "How a trade works"
    // list further down — "nothing here knows whether the person who picked
    // BLACKPINK is a blink or not" — and the deployed page carried the new
    // view and the old denial at the same time. A claim about what the page
    // says has to be checked against what the page says.
    page: document.body.innerText.replace(/\s+/g, ' '),
  }));
  const all = notes.tally + ' ' + notes.turnout + ' ' + t.note + ' ' + notes.page;
  check(!/cannot be traced to a fandom|can tell which fandom a vote came from/i.test(all),
        'the old blanket claim is gone', (all.match(/[^.]*fandom a vote[^.]*\./) || [])[0] || '');
  check(/not a blink’s vote|carries no fandom of its own/i.test(all),
        'replaced by the narrower true one: a vote carries no fandom');
  check(/self-declared/i.test(all), 'and the attribution is still marked self-declared');
  check(/Didn’t say/.test(t.note), 'the table\'s note names where the unanswered go');
  check(/shading runs across a row/i.test(t.note), 'and says which way the shading reads');
  check(/not two teams/i.test(notes.tally), 'the bar still says it is not two teams');
}

console.log('\n--- it fits a phone, and the page still does not scroll sideways');
// The table may scroll inside its own wrapper. The PAGE may not — that is the
// rule the whole site is held to, and a wide table is the classic way to break
// it without anything looking wrong on a desktop.
{
  const small = await open('/collabs?demo=b', 390);
  // Take a declared side's figures away so the empty-side row is on screen to
  // be measured. The demo fixture has every side logging, which is the one
  // case that cannot show this row — and the live API, today, is the case
  // that does.
  await small.evaluate(() => {
    COLLABS.forEach((c) => {
      var ps = (c.tally && c.tally.periods) || {};
      Object.keys(ps).forEach((k) => { if (ps[k].fandomCats) delete ps[k].fandomCats.pauljjak; });
    });
    setPairView('voter');
  });
  await small.waitForTimeout(300);
  const got = await small.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wrapScrolls: (() => { const w = document.querySelector('.vt-wrap');
      return w ? w.scrollWidth > w.clientWidth : null; })(),
    rows: document.querySelectorAll('.vt tbody tr').length,
    // The "nobody has said" sentence has to be READABLE at this width. It
    // spans a table that is deliberately wider than the screen, so by default
    // it wrapped at the table's width and its first line finished off to the
    // right, where the reader has to scroll to find it. Measured against the
    // scroll container's VISIBLE width — against the table it would be a
    // check that can never fail, and at 1200px so would this one, which is
    // why it lives down here and not beside the other row checks.
    noneOut: (() => {
      const sp = document.querySelector('.vt td.vt-none > span');
      const w = document.querySelector('.vt-wrap');
      if (!sp || !w) return null;
      return Math.round(sp.getBoundingClientRect().right
                        - w.getBoundingClientRect().left - w.clientWidth);
    })(),
  }));
  check(got.page <= 1, 'no sideways scroll on the page at 390px', `${got.page}px`);
  check(got.rows > 0, 'the table is there', `${got.rows} rows`);
  check(got.wrapScrolls !== null, 'inside a wrapper that may scroll on its own',
        String(got.wrapScrolls));
  check(got.noneOut !== null && got.noneOut <= 0,
        'and the empty-side sentence reads without scrolling it',
        got.noneOut === null ? 'no such row on this demo' : `${got.noneOut}px past the edge`);
  await small.close();
}

console.log('\n--- a collab with no sides keeps the trade rows and loses the control');
{
  const plain = await open('/collabs?demo=a');
  const got = await plain.evaluate(() => ({
    tabs: document.querySelectorAll('.pr-tabs').length,
    rows: document.querySelectorAll('.pairings .pr-row').length,
    head: (document.querySelector('.pairings-head') || {}).textContent || '',
  }));
  check(got.tabs === 0, 'no selector is drawn', `${got.tabs} found`);
  check(got.rows === 4, 'the four trade rows are still there', String(got.rows));
  check(/trade/i.test(got.head), 'under the trade heading', got.head.trim());
  await plain.close();
}

// ── The fandom picker, on the board itself ─────────────────────────────────
// It exists on the home page too, under Settings → Account. It is HERE because
// this is where the question occurs to somebody: they have just read a row
// saying nobody has said they are their fandom. Two navigations and a settings
// panel away is far enough that the answer does not get given.
//
// This page has no Supabase client and must not grow one — it is a public
// read-only board, and pulling the SDK in would make it a sign-in surface. It
// READS the session the home page already put in localStorage, same origin.
console.log('\n--- the fandom picker on /collabs');
{
  const mk = async (session) => {
    const pg = await browser.newPage({ viewport: { width: 412, height: 1200 } });
    pg.on('pageerror', (e) => errs.push(e.message));
    if (session) {
      await pg.addInitScript((sess) => {
        try { localStorage.setItem('sb-esbzlrmrdvvsrsobrzfz-auth-token', JSON.stringify(sess)); } catch (e) {}
      }, session);
    }
    const posts = [];
    let gets = 0;
    await pg.route('**/api/collabs**', (r) => {
      if (r.request().method() === 'POST') {
        posts.push(JSON.parse(r.request().postData() || '{}'));
        return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      }
      gets++;
      return r.continue();
    });
    await pg.goto(base + '/collabs?demo=b', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(600);
    await pg.evaluate(() => setPairView('voter'));
    await pg.waitForTimeout(200);
    return { pg, posts, getCount: () => gets };
  };
  const live = (over) => Object.assign({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'u1', user_metadata: {} },
  }, over || {});

  // Signed out: no chips. The message is not a sign-up pitch — everybody on
  // this board already has an account, because a vote cannot be logged
  // without one — it says where their own picker is.
  {
    const { pg } = await mk(null);
    const got = await pg.evaluate(() => ({
      chips: document.querySelectorAll('.fp-chip').length,
      msg: (document.querySelector('.fp-msg') || {}).textContent || '',
      link: !!document.querySelector('.fp-msg a'),
    }));
    check(got.chips === 0, 'signed out: no chips to press', `${got.chips} chips`);
    check(/signed up|cannot log a vote/i.test(got.msg) && got.link,
          'and it points at where to sign in rather than asking them to sign up');
    await pg.close();
  }

  // AN EXPIRED TOKEN IS SIGNED OUT. It would POST, 401, and the picker would
  // report a save that did not happen — the one outcome worse than no picker.
  {
    const { pg } = await mk(live({ expires_at: Math.floor(Date.now() / 1000) - 60 }));
    const chips = await pg.evaluate(() => document.querySelectorAll('.fp-chip').length);
    check(chips === 0, 'an expired session is treated as signed out', `${chips} chips`);
    await pg.close();
  }

  // THE ONE THAT SHIPPED BROKEN. A Supabase access token lasts an hour and the
  // client swaps the refresh token for a new one on load; what sits in storage
  // between visits is therefore usually EXPIRED. With no client on this page
  // the expiry check above reported every such reader as signed out, so the
  // picker worked only within an hour of a visit to the home page — which is
  // nobody arriving from a link, and is how it reached someone as "this does
  // nothing".
  //
  // The client is stubbed rather than fetched: the real one comes from a CDN
  // this runner cannot reach, so without a stub every check in this section
  // silently measures the FALLBACK path instead of the one being fixed. That
  // is precisely why the bug got through.
  {
    const stale = live({ access_token: 'stale', expires_at: Math.floor(Date.now() / 1000) - 60 });
    const pg = await browser.newPage({ viewport: { width: 412, height: 1200 } });
    pg.on('pageerror', (e) => errs.push(e.message));
    const posts = [];
    await pg.addInitScript((sess) => {
      try { localStorage.setItem('sb-esbzlrmrdvvsrsobrzfz-auth-token', JSON.stringify(sess)); } catch (e) {}
      // What the real client does with an expired token: hands back a fresh one.
      window.supabase = { createClient: () => ({ auth: {
        getSession: async () => ({ data: { session: {
          access_token: 'refreshed', expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'u1', user_metadata: {} },
        } } }),
      } }) };
    }, stale);
    await pg.route('**/api/collabs**', (r) => {
      if (r.request().method() === 'POST') {
        posts.push(JSON.parse(r.request().postData() || '{}'));
        return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      }
      return r.continue();
    });
    await pg.goto(base + '/collabs?demo=b', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(700);
    await pg.evaluate(() => setPairView('voter'));
    await pg.waitForTimeout(300);
    const chips = await pg.evaluate(() => document.querySelectorAll('.fp-chip').length);
    check(chips > 0, 'a STALE stored token still gets the picker, because the client refreshes it',
          `${chips} chips`);
    if (chips) {
      await pg.evaluate(() => {
        [...document.querySelectorAll('.fp-chip')].find((b) => /pauljjak/i.test(b.textContent)).click();
      });
      await pg.waitForTimeout(700);
      // The refreshed token, not the stale one sitting in storage. Sending the
      // stale one is a 401 and a picker that reports a save it did not make.
      check(!!posts[0] && posts[0].accessToken === 'refreshed',
            '  and the save carries the refreshed token, not the stale one',
            posts[0] ? posts[0].accessToken : 'no post');
    }
    await pg.close();
  }

  // Signed in: one chip per side the COLLAB declares. Built from its own list,
  // so a side is offered here because it is on the board — the keys are not
  // copied into this page to drift from it.
  {
    const { pg, posts, getCount } = await mk(live());
    const got = await pg.evaluate(() => ({
      chips: [...document.querySelectorAll('.fp-chip')].map((b) => b.getAttribute('onclick')),
      sides: (COLLABS.find((c) => c.id === 'bvp-kca-2026').fandoms || []).map((f) => f.key),
      lit: document.querySelectorAll('.fp-chip.on').length,
    }));
    check(got.chips.length === got.sides.length,
          'signed in: a chip for every side the collab declares',
          `${got.chips.length} chips, ${got.sides.length} sides`);
    check(got.sides.every((k) => got.chips.some((o) => o && o.includes("'" + k + "'"))),
          '  and they are that collab\'s own keys', got.sides.join(', '));
    check(got.lit === 0, '  with nothing preselected', `${got.lit} lit`);
    // ABOVE the view tabs, not under the table. Under it, it sat below the
    // table, three paragraphs of notes and a fold — and the person who needs
    // it most is the one who has not scrolled that far. Above the tabs it also
    // shows in BOTH views, not only the one that raises the question.
    const place = await pg.evaluate(() => {
      const fp = document.querySelector('.fp'), tabs = document.querySelector('.pr-tabs');
      const note = document.querySelector('.pr-note');
      if (!fp || !tabs) return null;
      return { aboveTabs: fp.getBoundingClientRect().top < tabs.getBoundingClientRect().top,
               aboveNote: !note || fp.getBoundingClientRect().top < note.getBoundingClientRect().top };
    });
    check(!!place && place.aboveTabs && place.aboveNote,
          '  sitting above the view tabs, not buried under the table',
          JSON.stringify(place));

    const before = getCount();
    await pg.evaluate(() => {
      [...document.querySelectorAll('.fp-chip')].find((b) => /pauljjak/i.test(b.textContent)).click();
    });
    await pg.waitForTimeout(900);
    check(posts.length === 1 && posts[0].action === 'set-fandom' && posts[0].fandom === 'pauljjak',
          'pressing one declares that side', JSON.stringify(posts[0] || {}));
    // The server takes the identity from the token and never from the body.
    // A picker that sent a user id would be a picker that could relabel
    // somebody else's votes.
    check(!!posts[0] && posts[0].accessToken === 'tok'
          && !posts[0].uid && !posts[0].app_user_id,
          '  carrying the session token and no identity of its own');
    // Seeing their own row appear is the confirmation. A message saying it
    // worked is not the same thing, and this is the half that would silently
    // stop working.
    check(getCount() > before, '  and the board is re-read so their row appears',
          `${getCount() - before} refetch(es)`);
    const after = await pg.evaluate(() => ({
      lit: (document.querySelector('.fp-chip.on') || {}).textContent || '',
      msg: (document.querySelector('.fp-msg') || {}).textContent || '',
    }));
    check(/pauljjak/i.test(after.lit), '  the chip stays lit afterwards', after.lit);
    check(/done/i.test(after.msg), '  and it says so', after.msg.slice(0, 60));
    await pg.close();
  }
}

console.log('\n--- nothing threw');
check(errs.length === 0, 'no page errors', errs.join(' | '));

await browser.close();
server.close();
console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
