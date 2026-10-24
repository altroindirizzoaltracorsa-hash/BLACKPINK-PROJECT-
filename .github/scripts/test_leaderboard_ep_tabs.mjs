// The leaderboard's EP tabs, in a real browser.
//
// Run: node .github/scripts/test_leaderboard_ep_tabs.mjs
//
// Two EP groups now share one tab row — Fallen Angel and PRESS PLAY — and each
// owns a nested track row. The failure is silent and specific: point both
// groups at one row id and the wrong tracks appear under a lit tab, with no
// error anywhere. Mutation-tested exactly that way.
//
// Also pinned: SaWaDiKa leads the PRESS PLAY row and still carries the
// `sawadika` id. It shipped as a single in September, so changing that id would
// orphan every play counted since.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './_playwright.mjs';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const SPA=/^\/(countdowns|voting|vote|streams|charts|badges|leaderboard|account|feedback)(\/|$)/;
const server=createServer(async(req,res)=>{const p=decodeURIComponent(req.url.split('?')[0]);
  const file=p==='/'?'/index.html':SPA.test(p)?'/index.html':p;
  try{const b=await readFile(ROOT+file);const e=file.split('.').pop();
    res.writeHead(200,{'content-type':{html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',
      svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',webp:'image/webp',mp4:'video/mp4'}[e]||'application/octet-stream'});
    res.end(b);}catch{res.writeHead(404);res.end('{}');}});
await new Promise(r=>server.listen(0,r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:430,height:950}});
await page.addInitScript(()=>{try{localStorage.setItem('bu_tutorial_seen','1');
  localStorage.setItem('ltal_reminder_dismissed_v1','1');localStorage.setItem('ext_update_dismissed_1.9.8','1');}catch(e){}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
let fails=0;
const ok=(m,d)=>console.log(`  ok   ${m}${d?` (${d})`:''}`);
const bad=(m,d)=>{fails++;console.log(`  FAIL ${m}${d?` (${d})`:''}`);};
await page.goto(base+'/leaderboard',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(3500);

const tabs = await page.evaluate(()=>[...document.querySelectorAll('.lb-subtabs:not(.lb-ep-subtabs) .lb-subtab')]
  .filter(b=>getComputedStyle(b).display!=='none').map(b=>b.textContent.trim()));
console.log('    top row: ' + tabs.join(' · '));
tabs.includes('PRESS PLAY EP ▾') ? ok('the EP tab is in the row') : bad('the EP tab is in the row');
!tabs.includes('SAWADIKA') ? ok('and the standalone SAWADIKA tab is gone from it') : bad('and the standalone SAWADIKA tab is gone from it');

const state=()=>page.evaluate(()=>({
  song: lbSong,
  pp: getComputedStyle(document.getElementById('lb-pp-subtabs')).display,
  fa: getComputedStyle(document.getElementById('lb-ep-subtabs')).display,
  ppLit: document.getElementById('lb-subtab-pressplay').classList.contains('active'),
  faLit: document.getElementById('lb-subtab-faep').classList.contains('active'),
  ppTracks: [...document.querySelectorAll('#lb-pp-subtabs .lb-subtab')].map(b=>b.textContent.trim()),
}));
await page.evaluate(()=>openPressPlayLeaderboard());
await page.waitForTimeout(500);
let s=await state();
console.log('    EP row: ' + s.ppTracks.join(' · '));
s.ppTracks.length===6 ? ok('six tracks in the EP row') : bad('six tracks in the EP row',`${s.ppTracks.length}`);
s.ppTracks[0]==='SAWADIKA' ? ok('SaWaDiKa leads it, as track 1') : bad('SaWaDiKa leads it',s.ppTracks[0]);
s.song==='sawadika' ? ok('opening the tab selects sawadika — its original id, so its history survives') : bad('opening selects sawadika',s.song);
(s.pp==='flex' && s.ppLit) ? ok('its row opens and the tab lights') : bad('its row opens and the tab lights',JSON.stringify(s));
s.fa==='none' ? ok('and the Fallen Angel row stays shut') : bad('and the Fallen Angel row stays shut',s.fa);

// Each EP track selects itself and keeps the group open.
for (const [i,key] of [[1,'v12'],[3,'tarantino'],[4,'cutuoff']]) {
  await page.evaluate((n)=>document.querySelectorAll('#lb-pp-subtabs .lb-subtab')[n].click(), i);
  await page.waitForTimeout(350);
  const t=await state();
  (t.song===key && t.pp==='flex' && t.ppLit) ? ok(`   ${key} selects and keeps the group open`)
                                             : bad(`   ${key} selects and keeps the group open`,JSON.stringify(t));
}
// Switching to the other EP must close this one.
await page.evaluate(()=>openFaEpLeaderboard());
await page.waitForTimeout(400);
s=await state();
(s.fa==='flex' && s.pp==='none' && s.faLit && !s.ppLit)
  ? ok('switching to Fallen Angel closes PRESS PLAY and lights only its own tab')
  : bad('switching to Fallen Angel closes PRESS PLAY', JSON.stringify(s));
// And a non-EP song closes both.
await page.evaluate(()=>switchLbSong('jump', null));
await page.waitForTimeout(400);
s=await state();
(s.fa==='none' && s.pp==='none') ? ok('a campaign track closes both rows') : bad('a campaign track closes both rows',JSON.stringify(s));
errs.length ? bad('no page errors',errs.join(' | ')) : ok('no page errors');
await browser.close(); server.close();
console.log(fails?`\n${fails} FAILED`:'\nAll tab checks passed.');
process.exit(fails?1:0);
