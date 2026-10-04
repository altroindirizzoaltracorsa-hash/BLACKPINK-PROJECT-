// Exercise api/youtube-catalog.js against a stubbed YouTube API.
//
// Run: node .github/scripts/test_youtube_catalog.mjs
//
// No network, no quota, no key — every googleapis call is intercepted. Covers
// the things that are invisible until they bite in production: paging past the
// 50-item playlistItems limit, batching videos.list in 50s, a channel whose
// handle no longer resolves, a channel with no uploads playlist, the view
// floor, and the milestone arithmetic (notably that a video sitting exactly on
// 2B must target 2.1B, not report a gap of zero forever).
process.env.YOUTUBE_API_KEY = 'k';
process.env.ADMIN_SECRET = 'secret';

let calls = [];
const CH = {
  UCbp: { id:'UCbp', snippet:{title:'BLACKPINK'}, contentDetails:{relatedPlaylists:{uploads:'UUbp'}} },
  UCro: { id:'UCro', snippet:{title:'ROSÉ'},      contentDetails:{relatedPlaylists:{uploads:'UUro'}} },
  UCno: { id:'UCno', snippet:{title:'NoUploads'}, contentDetails:{relatedPlaylists:{}} },
  UCvv: { id:'UCvv', snippet:{title:'ROSÉVEVO'},  contentDetails:{relatedPlaylists:{uploads:'UUvv'}} },
};
// 60 uploads on BLACKPINK (forces 2 pages) and 3 on ROSÉ.
const UP = {
  UUbp: Array.from({length:60}, (_,i)=>'bp'+String(i).padStart(9,'0')),
  UUro: ['ro000000001','ro000000002','ro000000003'],
  UUvv: ['ro000000001'],                   // the VEVO mirror: same id, again
};
const views = id => id.startsWith('bp')
  ? (id === 'bp000000000' ? 2487300000 : (id === 'bp000000001' ? 50000000 : 900000000 + Number(id.slice(-3))*1e6))
  : 181900000;

globalThis.fetch = async (url) => {
  const u = new URL(url);
  const path = u.pathname.split('/').pop();
  calls.push(path + ':' + (u.searchParams.get('id') || u.searchParams.get('forHandle') || u.searchParams.get('playlistId') || ''));
  const ok = body => ({ ok:true, json: async () => body });
  if (path === 'channels') {
    const handle = u.searchParams.get('forHandle');
    if (handle) return ok({ items: handle === '@BLACKPINK' ? [CH.UCbp] : [] });
    const ids = (u.searchParams.get('id')||'').split(',').filter(Boolean);
    return ok({ items: ids.map(i => CH[i]).filter(Boolean) });
  }
  if (path === 'playlistItems') {
    const pl = u.searchParams.get('playlistId');
    const tok = Number(u.searchParams.get('pageToken') || 0);
    const all = UP[pl] || [];
    const page = all.slice(tok, tok + 50);
    return ok({ items: page.map(v => ({ contentDetails:{videoId:v} })),
                nextPageToken: tok + 50 < all.length ? String(tok + 50) : undefined });
  }
  if (path === 'videos') {
    const ids = (u.searchParams.get('id')||'').split(',').filter(Boolean);
    const part = u.searchParams.get('part');
    if (part === 'snippet') return ok({ items: ids.map(i => ({ id:i, snippet:{ channelId:'UCro' } })) });
    return ok({ items: ids.map(i => ({ id:i, snippet:{title:'T '+i, publishedAt:'2020-01-01T00:00:00Z'},
      contentDetails:{duration:'PT3M'}, statistics:{ viewCount:String(views(i)) } })) });
  }
  return { ok:false, status:404, json: async () => ({ error:{ message:'nope' } }) };
};

const { default: handler } = await import(new URL('../../api/youtube-catalog.js', import.meta.url).href);
const run = async query => {
  let out;
  await handler({ method:'GET', query, headers:{ 'x-admin-secret':'secret' } },
    { setHeader(){}, status(c){ this._c=c; return this; }, json(b){ out={code:this._c,body:b}; return this; }, end(){ out={code:this._c}; } });
  return out;
};

let fails = [];
const check = (c,m) => { console.log((c?'  ok   ':'  FAIL ')+m); if(!c) fails.push(m); };

console.log('--- auth');
let r;
await handler({ method:'GET', query:{}, headers:{} },
  { setHeader(){}, status(c){ this._c=c; return this; }, json(b){ r={code:this._c,body:b}; } });
check(r.code === 401, 'no key → 401');

console.log('\n--- a full sweep');
calls = [];
r = await run({});
check(r.code === 200, 'returns 200');
const ch = r.body.channels.map(c => c.title).sort();
check(ch.includes('BLACKPINK') && ch.includes('ROSÉ'),
      `seeds + handles resolved both channels (${ch.join(', ')})`);
check(r.body.unresolved.length === 0, 'every configured handle resolved');
const bp = r.body.channels.find(c => c.title === 'BLACKPINK');
check(bp.uploads === 60, `paged through all 60 uploads (got ${bp.uploads})`);
check(calls.filter(c => c.startsWith('playlistItems:UUbp')).length === 2, '…in 2 pages');
check(calls.filter(c => c.startsWith('videos:bp')).length === 2, 'and fetched stats in 2 batches of 50');

console.log('\n--- the view floor');
check(r.body.videos.every(v => v.views >= 100000000), 'nothing below 100M is returned');
check(!r.body.videos.some(v => v.id === 'bp000000001'), 'the 50M video is dropped');
check(r.body.videos.length === bp.videos + r.body.channels.find(c=>c.title==='ROSÉ').videos,
      'per-channel counts add up to the total');

console.log('\n--- milestones');
const top = r.body.videos.find(v => v.id === 'bp000000000');
check(top.next === 2500000000 && top.gap === 12700000,
      `2,487,300,000 → next 2.5B, gap 12,700,000 (got ${top.next}, ${top.gap})`);
const ro = r.body.videos.find(v => v.id === 'ro000000001');
check(ro.next === 200000000 && ro.gap === 18100000, `181,900,000 → 200M, gap 18,100,000`);
check(ro.channel === 'ROSÉ', 'and it carries the channel it was found on');
const exact = (() => { // a video sitting exactly on a milestone must advance
  const nm = v => Math.ceil((v+1)/100e6)*100e6;
  return nm(2000000000) === 2100000000;
})();
check(exact, 'a video exactly on 2B targets 2.1B, not 2B');
check(r.body.videos.every((v,i,a) => i===0 || a[i-1].gap <= v.gap), 'sorted by smallest gap');

console.log('\n--- VEVO mirrors');
r = await run({ channels:'UCro,UCvv' });
const ro1 = r.body.videos.filter(v => v.id === 'ro000000001');
check(ro1.length === 1, `a video on both the artist channel and its VEVO mirror appears once (got ${ro1.length})`);
check(ro1[0].channel === 'ROSÉ', `and is credited to the artist channel, not the mirror (${ro1[0].channel})`);
r = await run({ channels:'UCvv,UCro' });
check(r.body.videos.filter(v => v.id === 'ro000000001')[0].channel === 'ROSÉ',
      'whichever order the channels are walked in');

console.log('\n--- a truncated walk');
r = await run({ channels:'UCbp', max_pages:'1' });
check(r.body.channels[0].truncated === true,
      'stopping at the page cap is reported as truncated, not as a complete walk');
check(r.body.channels[0].uploads === 50, 'and only the first page was read');
r = await run({ channels:'UCbp' });
check(r.body.channels[0].truncated === undefined, 'a complete walk is not flagged');

console.log('\n--- a channel with no uploads playlist');
calls = [];
r = await run({ channels:'UCno' });
check(r.body.channels[0].note === 'no uploads playlist', 'is reported, not crashed on');
check(r.body.videos.length === 0, 'and contributes nothing');

console.log('\n--- explicit overrides');
r = await run({ channels:'UCro', min:'500000000' });
check(r.body.channels.length === 1 && r.body.channels[0].title === 'ROSÉ', 'channels= narrows the sweep');
check(r.body.videos.length === 0, 'min= raises the floor (ROSÉ has nothing over 500M)');

console.log(`\nFAILURES: ${fails.length}`);
fails.forEach(f => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
