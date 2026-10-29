// Every test the workflow runs can actually START on a runner.
//
// Run: node .github/scripts/test_ci_can_start.mjs
//
// WHY THIS EXISTS. Playwright lives in a different place depending on who is
// running: a bare 'playwright' specifier resolves on a GitHub runner, and in a
// Claude Code session it is preinstalled at a fixed absolute path outside any
// node_modules the repo can see. _playwright.mjs tries one and falls back to
// the other, and every browser test is supposed to import chromium from there.
//
// test_mama_votes.mjs did not. It imported the absolute container path, which
// is fine in a session and ERR_MODULE_NOT_FOUND on a runner — so the moment it
// was wired into page-checks it failed on main in under a second, before a
// single assertion ran. Nothing caught it beforehand because every check in
// that file passes locally; the file simply never started in CI.
//
// That is the shape this guards: a test can be perfectly correct and still be
// incapable of running where it is run. So this reads the workflow, not a list
// kept here, and asks of each script only the questions that decide whether it
// gets as far as its first check.
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

const wf = readFileSync(root + '.github/workflows/page-checks.yml', 'utf8');
// The scripts the workflow actually invokes, in the form it invokes them.
const run = [...wf.matchAll(/node\s+\.github\/scripts\/([A-Za-z0-9_.-]+\.mjs)/g)].map((m) => m[1]);
const scripts = [...new Set(run)];

console.log('--- the workflow names scripts that are there');
check(scripts.length > 0, `page-checks runs ${scripts.length} scripts`);
for (const s of scripts) {
  check(existsSync(root + '.github/scripts/' + s), `${s} exists`);
}

console.log('\n--- and none of them hardcode a path that only exists in a session');
// The absolute path is legitimate INSIDE _playwright.mjs, which is the fallback
// arm of the try/catch. Anywhere else it is a test that cannot start on a
// runner. Scripts not wired into the workflow are left alone: they are only
// ever run by hand, in the session, where that path is the one that works.
const BAD = '/opt/node22/lib/node_modules/playwright';
// An IMPORT of that path, not a mention of it. The first version tested
// `src.includes(BAD)` and promptly failed on this file, which names the path
// in the constant above and twice in the prose — a check that cannot describe
// what it forbids without tripping over itself. Comments are free; resolving
// through it is what breaks on a runner.
const IMPORTS_BAD = new RegExp(String.raw`(?:\bfrom|\bimport\s*\()\s*['"][^'"]*${BAD}`);
for (const s of scripts) {
  const src = readFileSync(root + '.github/scripts/' + s, 'utf8');
  const hard = IMPORTS_BAD.test(src);
  check(!hard, `${s} resolves playwright through _playwright.mjs`,
        hard ? 'imports the container path directly — ERR_MODULE_NOT_FOUND on a runner' : undefined);
}

console.log('\n--- the shim itself still has both arms');
const shim = readFileSync(root + '.github/scripts/_playwright.mjs', 'utf8');
check(/import\(\s*['"]playwright['"]\s*\)/.test(shim), 'it tries the bare specifier first, which is the CI one');
check(shim.includes(BAD), 'and falls back to the session path');
check(/ERR_MODULE_NOT_FOUND/.test(shim), 'and only swallows a module-not-found, so a real error still surfaces');

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
