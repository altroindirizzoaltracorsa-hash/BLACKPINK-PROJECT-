/**
 * intercept-chartradar.mjs
 *
 * Uses Playwright to browse chartradar.app/charts/global/apple-music and
 * intercepts all network responses, capturing any that look like chart JSON.
 * Run once to discover the real API endpoint; after that we can hit it directly.
 */

import { chromium } from 'playwright';

const TARGET = 'https://www.chartradar.app/charts/global/apple-music';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  console.log('=== ChartRadar Playwright Intercept ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  const page = await context.newPage();

  const captured = [];

  page.on('response', async response => {
    const url = response.url();
    const status = response.status();
    const ct = response.headers()['content-type'] || '';

    // Capture any JSON-looking or API-looking response
    const looksLikeApi =
      ct.includes('json') ||
      url.includes('/api/') ||
      url.includes('chart') ||
      url.includes('music') ||
      url.includes('track') ||
      url.includes('song');

    if (!looksLikeApi) return;
    if (url.includes('_next/static') || url.includes('.js') || url.includes('.css')) return;

    try {
      const text = await response.text().catch(() => '');
      const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');
      if (!isJson && !ct.includes('json')) return;

      captured.push({ url, status, ct, preview: text.slice(0, 1000) });
      console.log(`\n--- Captured ---`);
      console.log(`URL:    ${url}`);
      console.log(`Status: ${status}`);
      console.log(`CT:     ${ct}`);
      console.log(`Body (first 1000):\n${text.slice(0, 1000)}`);
    } catch (_) {}
  });

  console.log(`Navigating to ${TARGET}…`);
  try {
    await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 45000 });
  } catch (e) {
    console.log(`Navigation ended (${e.message}) — continuing with collected responses`);
  }

  // Extra wait for lazy-loaded data
  await page.waitForTimeout(8000);

  // Also scroll down to trigger any lazy fetches
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);

  console.log(`\n\n=== Summary: ${captured.length} API response(s) captured ===`);
  if (captured.length === 0) {
    console.log('No JSON API responses found. Chart data may require authentication.');

    // Dump all network responses for debugging
    console.log('\n--- All non-asset responses (for debugging) ---');
  }

  for (const c of captured) {
    console.log(`\n  ${c.url} → HTTP ${c.status}`);
  }

  // Print page text as fallback to see if data is rendered in DOM
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  console.log(`\n--- Page visible text (first 3000 chars) ---`);
  console.log(bodyText.slice(0, 3000));

  await browser.close();
  console.log('\n=== Done ===');
}

main().catch(e => { console.error(e); process.exit(1); });
