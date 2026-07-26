/**
 * probe-youtube-charts-v25.mjs
 *
 * Use Playwright to intercept the real API request the daily chart page makes.
 * Chromium is pre-installed on GitHub Actions (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers).
 * We navigate to charts.youtube.com daily chart and capture the exact
 * browseId + params + body that the browser sends.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');

async function main() {
  console.log('=== Probe v25: Playwright intercept of YouTube Charts daily API ===');

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH
      ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium/chrome`
      : undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  const capturedRequests = [];

  // Intercept all requests to charts.youtube.com API
  await context.route('**/youtubei/v1/browse**', async route => {
    const request = route.request();
    const postData = request.postData();
    let parsedBody = null;
    try { parsedBody = JSON.parse(postData ?? '{}'); } catch {}
    capturedRequests.push({
      url: request.url(),
      headers: request.headers(),
      body: parsedBody,
      rawBody: postData,
    });
    console.log(`  [CAPTURED] ${request.url()}`);
    if (parsedBody?.browseId) console.log(`    browseId: ${parsedBody.browseId}`);
    if (parsedBody?.params) console.log(`    params: ${parsedBody.params}`);
    if (parsedBody?.query) console.log(`    query: ${parsedBody.query}`);
    await route.continue();
  });

  // Also capture responses to log the entityId returned
  const page = await context.newPage();
  page.on('response', async response => {
    if (response.url().includes('youtubei/v1/browse')) {
      try {
        const body = await response.json();
        const entityId = body?.contents?.sectionListRenderer?.contents?.[0]
          ?.musicAnalyticsSectionRenderer?.content?.perspectiveMetadata?.entityId;
        if (entityId) console.log(`  [RESPONSE entityId] ${entityId}`);

        // Check for Less Than A Lover in this response
        const content = body?.contents?.sectionListRenderer?.contents?.[0]
          ?.musicAnalyticsSectionRenderer?.content;
        for (const tt of (content?.trackTypes ?? [])) {
          for (const e of (tt.trackViews ?? [])) {
            const combined = ((e.name ?? '') + ' ' + (e.artists ?? []).map(a => a.name ?? '').join(' ')).toLowerCase();
            if (combined.includes('jennie') || combined.includes('less than')) {
              console.log(`  *** JENNIE HIT: #${e.chartEntryMetadata?.currentPosition} "${e.name}" — ${(e.artists ?? []).map(a => a.name).join(', ')} (${e.viewCount} views)`);
            }
          }
        }
      } catch {}
    }
  });

  // Step 1: Navigate to the main charts page
  console.log('\nNavigating to charts.youtube.com...');
  await page.goto('https://charts.youtube.com', { waitUntil: 'networkidle', timeout: 30000 });
  console.log('  Loaded main page');

  // Step 2: Try to find and click "Daily" / "Giornaliera" tab
  console.log('\nLooking for daily chart tab...');
  await page.waitForTimeout(2000);

  // Look for tab buttons
  const tabs = await page.$$('button, [role="tab"], a');
  for (const tab of tabs) {
    const text = await tab.textContent().catch(() => '');
    if (/daily|giornali|日次|일별/i.test(text ?? '')) {
      console.log(`  Found tab: "${text?.trim()}" — clicking`);
      await tab.click();
      await page.waitForTimeout(2000);
      break;
    }
  }

  // Step 3: Try navigating directly to the daily chart URL variants
  const dailyUrls = [
    'https://charts.youtube.com/charts/TopVideos/global/daily',
    'https://charts.youtube.com/charts/TopVideos/us/daily',
    'https://charts.youtube.com/charts/TopVideos/global?period=daily',
    'https://charts.youtube.com/charts/TopVideos/global?frequency=daily',
  ];

  for (const url of dailyUrls) {
    console.log(`\nTrying URL: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1500);
      const title = await page.title();
      console.log(`  Page title: ${title}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  // Step 4: Check what page we're on and look for chart entries
  console.log('\nFinal page state:');
  console.log(`  URL: ${page.url()}`);
  const entries = await page.$$('[data-p]').catch(() => []);
  console.log(`  Chart entries found: ${entries.length}`);

  await browser.close();

  // Summary
  console.log('\n=== Captured API requests ===');
  console.log(`Total captured: ${capturedRequests.length}`);
  capturedRequests.forEach((req, i) => {
    console.log(`\n[${i + 1}] ${req.url}`);
    if (req.body) {
      console.log(`  browseId: ${req.body.browseId ?? '(none)'}`);
      console.log(`  params: ${req.body.params ?? '(none)'}`);
      console.log(`  query: ${req.body.query ?? '(none)'}`);
    }
  });

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    join(DATA_DIR, 'probe-v25-playwright-capture.json'),
    JSON.stringify(capturedRequests, null, 2),
  );
  console.log('\nSaved captured requests to data/probe-v25-playwright-capture.json');
  console.log('=== Done ===');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
