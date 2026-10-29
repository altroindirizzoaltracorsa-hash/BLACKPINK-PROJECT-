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

console.log('\n--- and none of them reach for a path that only exists in a session');
// TWO PATHS, NOT ONE, and the first version of this guard only knew about the
// first. It caught the import, shipped, and the very next run failed on the
// same script for the OTHER one: chromium.launch({ executablePath:
// '/opt/pw-browsers/chromium' }), the container's browser binary, which a
// runner does not have either. Same class of mistake, same file, one step
// later — a guard that covers half a class just moves the failure.
//
// Each is matched as the CONSTRUCT that uses it, never as a bare substring.
// This file has to name what it forbids, and a substring test makes it fail on
// itself — which is exactly what the import rule did on its first run here.
// Prose and tables are free; resolving or launching through them is not.
//
// 19 of the browser tests import from _playwright.mjs and call
// chromium.launch() with no options, and have always been fine in both
// places. That is the shape to match.
const SESSION_ONLY = [
  { what: 'resolves playwright by the container path',
    why:  'ERR_MODULE_NOT_FOUND on a runner, before the first assertion',
    re:   /(?:\bfrom|\bimport\s*\()\s*['"][^'"]*\/opt\/node22\/lib\/node_modules\/playwright/ },
  { what: 'launches the container browser binary',
    why:  "the runner's chromium is wherever Playwright put it, not /opt",
    re:   /executablePath\s*:\s*['"][^'"]*\/opt\/pw-browsers/ },
];
for (const s of scripts) {
  const src = readFileSync(root + '.github/scripts/' + s, 'utf8');
  const hits = SESSION_ONLY.filter((r) => r.re.test(src));
  check(hits.length === 0, `${s} uses nothing that only exists in a session`,
        hits.length ? hits.map((h) => `${h.what} — ${h.why}`).join('; ') : undefined);
}

console.log('\n--- the shim itself still has both arms');
const shim = readFileSync(root + '.github/scripts/_playwright.mjs', 'utf8');
check(/import\(\s*['"]playwright['"]\s*\)/.test(shim), 'it tries the bare specifier first, which is the CI one');
check(/\/opt\/node22\/lib\/node_modules\/playwright/.test(shim), 'and falls back to the session path');
check(/ERR_MODULE_NOT_FOUND/.test(shim), 'and only swallows a module-not-found, so a real error still surfaces');

console.log(`\nFAILURES: ${fails.length}`);
for (const f of fails) console.log('  - ' + f);
process.exit(fails.length ? 1 : 0);
