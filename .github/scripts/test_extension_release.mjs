// The version the site offers has to be the version that exists.
//
// Run: node .github/scripts/test_extension_release.mjs
//
// A release touches six places: two manifests, two zips and two pages. Miss one
// and the failure is quiet in the worst way — a download link to a file that
// isn't there 404s, and a page still advertising the old version sends people
// to an extension that cannot see the collab, which on their board looks like
// "my votes aren't counting" rather than "I'm on the wrong version".
//
// Also checks the zips are what they claim: built from the current source, with
// the right manifest in each. A zip is the thing people actually install, and
// it is the one artefact in this repo that can silently fall behind the code.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const mv3 = JSON.parse(readFileSync(root + 'vote-extension/manifest.json', 'utf8'));
const mv2 = JSON.parse(readFileSync(root + 'vote-extension/manifest-mv2.json', 'utf8'));
const V = mv3.version;

console.log('--- the two manifests');
check(mv2.version === V, 'both manifests are the same version', `${V} / ${mv2.version}`);
check(mv3.manifest_version === 3, 'the desktop one is MV3');
check(mv2.manifest_version === 2, 'and the Android one is MV2 — Edge Canary and Quetta run Kiwi\'s engine');

console.log('--- the zips exist and match the source');
const zips = [['chrome', mv3], ['android', mv2]];
for (const [target, manifest] of zips) {
  const name = `vote-extension-v${V}-${target}.zip`;
  const path = root + name;
  if (!existsSync(path)) { check(false, `${name} exists`, 'not built'); continue; }
  check(true, `${name} exists`);
  // unzip -p, rather than a zip library, so this reads the archive the same
  // way a person's browser will.
  const inner = JSON.parse(execFileSync('unzip', ['-p', path, 'manifest.json'], { encoding: 'utf8' }));
  check(inner.version === V, `${target}: the manifest inside says ${V}`, inner.version);
  check(inner.manifest_version === manifest.manifest_version,
        `${target}: and it is the right manifest`, `MV${inner.manifest_version}`);
  // The whole reason for this release: an older background.js would install
  // cleanly and silently count three categories out of four.
  const bg = execFileSync('unzip', ['-p', path, 'background.js'], { encoding: 'utf8' });
  check(/const COLLAB = \{/.test(bg), `${target}: carries the collab counting`);
  check(bg === readFileSync(root + 'vote-extension/background.js', 'utf8'),
        `${target}: background.js is byte-identical to the source`);
}

console.log('--- the pages offer that version and no other');
for (const page of ['index.html', 'collabs.html']) {
  const html = readFileSync(root + page, 'utf8');
  const links = [...html.matchAll(/vote-extension-v([\d.]+)-(chrome|android)\.zip/g)];
  if (!links.length) { check(page === 'collabs.html' ? false : false, `${page} links the download`, 'no link found'); continue; }
  const wrong = links.filter((m) => m[1] !== V).map((m) => m[1]);
  check(wrong.length === 0, `${page} links v${V} only`, wrong.length ? `also links ${[...new Set(wrong)].join(', ')}` : `${links.length} links`);
  // And every file it links is actually in the repo.
  for (const m of links) {
    check(existsSync(root + m[0]), `${page} → ${m[0]} is present`);
  }
  // A stale "v1.8.0" in prose is as misleading as a stale link.
  //
  // Anchored to a version standing on its own — after a space, a tag or an
  // opening bracket. An unanchored /v\d+\.\d+\.\d+/ also matches the middle of
  // a filename, and the first thing it flagged was the web font
  // (pretendard-variable-latin-v1.3.9.woff2), which has nothing to do with
  // this and would have taught everyone to ignore the check.
  const stale = [...html.matchAll(/(?:^|[\s>(\u2014])v(\d+\.\d+\.\d+)/g)].map((m) => m[1])
    .filter((v) => v !== V);
  check(stale.length === 0, `${page} names no older version in its text`,
        stale.length ? [...new Set(stale)].join(', ') : '');
}

console.log('--- the update prompt re-appears for this version');
// The dismiss key is versioned, so bumping the constant is what makes the
// nudge show again. Leaving it behind means nobody is ever told to update.
const idx = readFileSync(root + 'index.html', 'utf8');
const m = idx.match(/const EXT_LATEST_VERSION = '([\d.]+)'/);
check(!!m && m[1] === V, 'EXT_LATEST_VERSION matches the build', m ? m[1] : 'not found');

console.log('--- older zips are kept, not overwritten');
// Someone mid-install on an older link should not get a 404; the old files
// stay, they are simply no longer advertised.
const olds = readdirSync(root).filter((f) => /^vote-extension-v[\d.]+-(chrome|android)\.zip$/.test(f));
check(olds.length > 2, 'previous releases are still downloadable', `${olds.length} zips`);

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
