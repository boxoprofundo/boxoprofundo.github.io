/**
 * Local selector-debugging harness. NOT used by the deployed service.
 *
 * Run this on YOUR machine (where app.pikkit.com is actually reachable) to
 * see what the scraper sees, so you can fix the guessed selectors in
 * scraper.js against the real page.
 *
 *   npm install
 *   npx playwright install chromium
 *   PIKKIT_EMAIL=you@example.com PIKKIT_PASSWORD='...' node local-debug.js
 *
 * Flags (env vars):
 *   HEADED=1   open a real visible browser window so you can watch/interact
 *   PAUSE=1    drop into Playwright Inspector before the run (pick selectors
 *              interactively, step through, copy working locators)
 *
 * On success it prints the scraped page text. On failure it writes
 * debug.png and prints the page URL/title -- the same payload the deployed
 * service returns in its `debug` field.
 */

const fs = require('fs');
const { chromium } = require('playwright');
const { scrapeLiveBets } = require('./scraper');

if (!process.env.PIKKIT_EMAIL || !process.env.PIKKIT_PASSWORD) {
  console.error('Set PIKKIT_EMAIL and PIKKIT_PASSWORD in your environment first.');
  console.error("Tip: don't put them on the command line if you share shell history --");
  console.error('use `read -s PIKKIT_PASSWORD && export PIKKIT_PASSWORD` instead.');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  try {
    if (process.env.PAUSE) await page.pause();
    const { text, debug } = await scrapeLiveBets(page);
    console.log('=== SCRAPE SUCCEEDED ===');
    console.log('final url:  ', debug.url);
    console.log('final title:', debug.title);
    console.log('--- visible page text ---');
    console.log(text);
    fs.writeFileSync('pikkit-page-text.txt', text);
    console.log('\n(also written to pikkit-page-text.txt)');
  } catch (e) {
    console.error('=== SCRAPE FAILED ===');
    console.error('message:', e.message);
    if (e.debug) {
      console.error('label:  ', e.debug.label);
      console.error('url:    ', e.debug.url);
      console.error('title:  ', e.debug.title);
      if (e.debug.screenshotBase64) {
        fs.writeFileSync('debug.png', Buffer.from(e.debug.screenshotBase64, 'base64'));
        console.error('screenshot written to debug.png');
      }
    } else {
      console.error('(no debug payload attached to this error)');
    }
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();
