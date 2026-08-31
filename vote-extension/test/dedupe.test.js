// Loads the REAL background.js against a stubbed Chrome, so dedupe is exercised
// as it actually runs. `store` persists across "worker restarts"; module state does not.
const fs = require('fs'), vm = require('vm');
const SRC = fs.readFileSync(process.argv[2], 'utf8');

function boot(store, posts) {
  let onCompleted;
  const chrome = {
    storage: { local: {
      get(keys, cb) {
        const k = Array.isArray(keys) ? keys : [keys];
        const out = {}; k.forEach(x => { if (x in store) out[x] = store[x]; });
        setTimeout(() => cb(out), 0);              // async, like the real API
      },
      set(obj, cb) { Object.assign(store, JSON.parse(JSON.stringify(obj))); if (cb) setTimeout(cb, 0); },
    }},
    webRequest: { onCompleted: { addListener(fn) { onCompleted = fn; } } },
    runtime: { onMessage: { addListener() {} } },
  };
  const ctx = {
    chrome, console, URL, Set, Promise, Date, Intl, Array, Object, JSON, setTimeout,
    fetch: async (url, opt) => {
      if (opt && opt.method === 'POST') posts.push(JSON.parse(opt.body));
      return { ok: true, json: async () => ({}) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return onCompleted;
}

const url = (cat, ts, slots, acct = 'me@x.com') => {
  const q = Object.entries(slots).map(([k, v]) => `${k}=${v}`).join('&');
  return `https://vote.mtv.com/api/prod/vote/s2/vote?action_type=vote&category=${cat}&timestamp=${ts}&user_id=${acct}&method=email&total=10&${q}`;
};
const settle = () => new Promise(r => setTimeout(r, 60));

(async () => {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = got === want;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} got ${got}, want ${want}`);
    ok ? pass++ : fail++;
  };

  // 1. a retried submission counts once
  {
    const store = { buToken: 't' }, posts = [];
    const fire = boot(store, posts);
    const d = { url: url('cat11', '111', { A1: 10 }), statusCode: 200 };
    fire(d); await settle(); fire(d); await settle();
    check('retry of the same submission', posts.length, 1);
  }

  // 2. two categories sharing a timestamp - BOTH are real votes
  {
    const store = { buToken: 't' }, posts = [];
    const fire = boot(store, posts);
    fire({ url: url('cat06', '222', { C1: 10 }), statusCode: 200 }); await settle();
    fire({ url: url('cat11', '222', { A1: 10 }), statusCode: 200 }); await settle();
    check('same timestamp, different category', posts.length, 2);
  }

  // 3. service worker restart: module state gone, storage kept
  {
    const store = { buToken: 't' }, posts = [];
    boot(store, posts)({ url: url('cat11', '333', { A1: 10 }), statusCode: 200 }); await settle();
    boot(store, posts)({ url: url('cat11', '333', { A1: 10 }), statusCode: 200 }); await settle();
    check('retry after service-worker restart', posts.length, 1);
  }

  // 4. two retries in the SAME tick (no await between)
  {
    const store = { buToken: 't' }, posts = [];
    const fire = boot(store, posts);
    const d = { url: url('cat11', '444', { A1: 10 }), statusCode: 200 };
    fire(d); fire(d); await settle();
    check('two retries in one tick', posts.length, 1);
  }

  // 5. a vote where no BLACKPINK slot scored must not consume the window
  {
    const store = { buToken: 't' }, posts = [];
    const fire = boot(store, posts);
    fire({ url: url('cat11', '555', { B2: 10 }), statusCode: 200 }); await settle();
    check('non-BP vote posts nothing', posts.length, 0);
    check('non-BP vote consumes no dedupe slot', (store.buSeenVotes || []).length, 0);
  }

  // 6. different accounts, same timestamp+category (account rotation)
  {
    const store = { buToken: 't' }, posts = [];
    const fire = boot(store, posts);
    fire({ url: url('cat11', '666', { A1: 10 }, 'a@x.com'), statusCode: 200 }); await settle();
    fire({ url: url('cat11', '666', { A1: 10 }, 'b@x.com'), statusCode: 200 }); await settle();
    check('same ts+category, different account', posts.length, 2);
  }

  // 7. window stays bounded
  {
    const store = { buToken: 't' }, posts = [];
    const fire = boot(store, posts);
    for (let i = 0; i < 75; i++) { fire({ url: url('cat11', 'w' + i, { A1: 1 }), statusCode: 200 }); await settle(); }
    check('dedupe window capped at 60', store.buSeenVotes.length, 60);
  }

  // 8. non-2xx responses are ignored entirely
  {
    const store = { buToken: 't' }, posts = [];
    boot(store, posts)({ url: url('cat11', '888', { A1: 10 }), statusCode: 500 }); await settle();
    check('failed submission not counted', posts.length, 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
