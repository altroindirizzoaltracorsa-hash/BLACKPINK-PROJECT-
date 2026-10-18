// Where Playwright lives depends on who is running the test.
//
// On a GitHub runner the page-checks workflow installs it, so the bare
// specifier resolves. In a Claude Code session it is preinstalled at a fixed
// path OUTSIDE any node_modules the repo can see, so the bare specifier throws
// ERR_MODULE_NOT_FOUND and only the absolute path works.
//
// Every browser test imports chromium from here so neither environment has to
// know about the other. Hardcoding either one is what kept these tests from
// running in CI at all.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'));
}
export { chromium };
