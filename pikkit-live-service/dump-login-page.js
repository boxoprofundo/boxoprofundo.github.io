/**
 * Dumps what app.pikkit.com's LOGIN page actually looks like, so the guessed
 * selectors in scraper.js can be replaced with real ones.
 *
 * Requires NO credentials and never logs in -- it only loads the public
 * pre-auth page. Nothing it writes is a secret, so the output is safe to
 * paste back into a chat.
 *
 *   npm install && npx playwright install chromium
 *   node dump-login-page.js
 *
 * Writes login-page-dump.txt (and login-page.png). Send me both.
 */

const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const out = [];
  const say = (s) => { console.log(s); out.push(s); };

  try {
    await page.goto('https://app.pikkit.com/', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    say('URL:   ' + page.url());
    say('TITLE: ' + (await page.title().catch(() => null)));

    // If the form is behind a "Sign in" click, note whether such a control exists.
    const signIn = page.getByText(/sign in|log in/i);
    say('\n"sign in"/"log in" text matches: ' + (await signIn.count().catch(() => 0)));

    for (const tag of ['input', 'button', 'form', 'a[href*="login" i]', 'a[href*="sign" i]']) {
      const els = await page.locator(tag).all();
      say(`\n=== <${tag}> (${els.length}) ===`);
      for (const el of els) {
        const html = await el.evaluate((n) => n.outerHTML).catch(() => '<unreadable>');
        const visible = await el.isVisible().catch(() => null);
        say(`[visible=${visible}] ${html.slice(0, 400)}`);
      }
    }

    say('\n=== VISIBLE PAGE TEXT ===');
    say(await page.locator('body').innerText().catch(() => '<none>'));

    fs.writeFileSync('login-page.png', await page.screenshot({ fullPage: true }));
    say('\n(screenshot written to login-page.png)');
  } catch (e) {
    say('FAILED: ' + e.message);
    await page.screenshot({ fullPage: true }).then(
      (b) => fs.writeFileSync('login-page.png', b),
      () => {}
    );
  } finally {
    fs.writeFileSync('login-page-dump.txt', out.join('\n'));
    console.log('\n--> wrote login-page-dump.txt');
    await browser.close().catch(() => {});
  }
})();
